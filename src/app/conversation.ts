/**
 * Conversation turns (1.0).
 *
 * Strategy: replay-session. Each Turn starts a fresh CLI process with a prompt built from the
 * persisted user/agent transcript. The Session stays open in waiting_user after a successful turn.
 * Adapters that need native session ids can replace this path later without changing the wire model.
 */

import { randomUUID } from 'node:crypto';
import { startTask, type TaskHandle } from '../runner.js';
import type {
  ApprovalLookupInput,
  ApprovalLookupResult,
  TaskFinishInfo,
  TaskHooks,
} from '../core/task-supervisor.js';
import type { PermissionPolicyName } from '../core/permission-policy.js';
import type { ServerMessage, TaskStatus, TaskPhase, PermissionMode } from '../protocol.js';
import type { Emitter } from '../core/emitter.js';
import { hasAnsi } from '../core/ansi.js';
import type { SessionStore, SessionRecord, SessionPhase, TurnRecord } from '../core/session-store.js';
import type { TaskRegistry } from './task-registry.js';
import type { SessionLog } from './session-log.js';
import { authorizeService } from './service-gate.js';
import { acpSpecFor, agentCanContinue, agentDefOf, resolveBin } from '../adapters/agent-adapters.js';
import { canRunAcp } from '../adapters/acp-codebuddy.js';
import { ClaudeResident } from './claude-resident.js';
import type { InteractionBroker } from '../core/interaction-broker.js';

type RunTaskMessage = Extract<ServerMessage, { type: 'run_task' }>;
type SendMessageMessage = Extract<ServerMessage, { type: 'send_message' }>;

export interface ConversationDeps {
  emitter: Emitter;
  tasks: Map<string, TaskHandle>;
  registry: TaskRegistry;
  store: SessionStore;
  interactions?: InteractionBroker;
  interactionEnabled?: boolean;
  approvalLookup?: (input: ApprovalLookupInput, taskId: string) => ApprovalLookupResult | undefined;
  allowedCwd?: string[];
  maxConcurrent: number;
  maxQueued: number;
  diffMaxBytes: number;
  captureDiffByDefault: boolean;
  /** 本机权限策略与隔离声明；每个 Turn 都须传递，不能在 conversation 入口丢失。 */
  permissionPolicy?: PermissionPolicyName;
  externalSandbox?: boolean;
  requireServiceToken: boolean;
  log: SessionLog;
  /** 存在时启用 Claude 常驻会话；测试/旧流程不传则走 startTask */
  residentSessions?: Map<string, ClaudeResident>;
  /** waiting_user 空闲关闭（0/undefined = 关闭） */
  idleTimeoutMs?: number;
  idleTimers?: Map<string, NodeJS.Timeout>;
}

function phaseOf(status: TaskStatus, info?: TaskFinishInfo): TaskPhase {
  if (status !== 'running') return 'running';
  return info?.phase === 'queued' || info?.phase === 'waiting_interaction' ? info.phase : 'running';
}

function wirePhase(phase: SessionPhase): TaskPhase {
  return phase === 'settled' ? 'running' : phase;
}

function emitStatus(
  deps: ConversationDeps,
  sessionId: string,
  turnId: string,
  status: TaskStatus,
  phase: TaskPhase,
  info?: TaskFinishInfo,
): number {
  const payload = {
    taskId: sessionId,
    turnId,
    status,
    phase,
    interactionId: info?.interactionId,
    exitCode: info?.exitCode,
    error: info?.error,
    errorCode: info?.errorCode,
    permissionMode: info?.permissionMode,
    requestedBy: undefined,
  };
  const event = deps.store.appendEvent({ sessionId, type: 'task_status', payload });
  deps.emitter.emit({
    type: 'task_status',
    taskId: sessionId,
    turnId,
    status,
    phase,
    interactionId: info?.interactionId,
    exitCode: info?.exitCode,
    error: info?.error,
    errorCode: info?.errorCode,
    permissionMode: info?.permissionMode,
    eventSeq: event.eventSeq,
  });
  return event.eventSeq;
}

/**
 * 启动一个 conversation Turn。调用方负责 session/turn 已存在、user message 已持久化。
 */
export function startConversationTurn(
  deps: ConversationDeps,
  session: SessionRecord,
  turn: TurnRecord,
  prompt: string,
  timeoutMs?: number,
): TaskHandle {
  const sessionId = session.sessionId;
  const executionId = `${sessionId}__${turn.turnId}`;
  const def = agentDefOf(session.agentType);
  const permissionMode: PermissionMode | undefined =
    session.permissionMode === 'full' || session.permissionMode === 'default' ? session.permissionMode : undefined;
  // 本机 policy=full 时，省略 permissionMode 的旧平台会话同样必须按 full 执行。
  const full = permissionMode ? permissionMode === 'full' : deps.permissionPolicy === 'full';
  // full 只接受受管空 args：内部 resumeArgs 也不能塞进该字段。需要续上下文时使用完整 transcript 重放。
  const resumeArgs =
    !full && def?.resumeArgs && session.nativeSessionId
      ? def.resumeArgs.map((arg) => arg.replaceAll('{{sessionId}}', session.nativeSessionId as string))
      : [];
  const turnPrompt = full ? transcriptOf(deps, sessionId) : prompt;
  /**
   * 有原生续接参数时 prompt 只有「本轮新说的话」—— 一旦 ACP 续会话没成功，
   * 新会话就只剩这句话，历史悄无声息地没了。这里备一份完整 transcript 给它兜底。
   * 没有续接参数的工具本来就把 transcript 当 prompt，无需重复准备。
   */
  const replayPrompt =
    resumeArgs.length > 0 && def?.acp && canRunAcp(def.acp) && prompt
      ? transcriptOf(deps, sessionId)
      : undefined;
  const onStatus = (status: TaskStatus, info?: TaskFinishInfo): void => {
    const runningPhase = phaseOf(status, info);
    try {
      if (status === 'running') {
        deps.store.updateSession(sessionId, { status: 'running', phase: runningPhase });
        deps.store.updateTurn(sessionId, turn.turnId, {
          status: info?.phase === 'queued' ? 'queued' : 'running',
          startedAt: info?.phase === 'queued' ? undefined : new Date().toISOString(),
        });
        emitStatus(deps, sessionId, turn.turnId, 'running', runningPhase, info);
        return;
      }

      // 最终回答先落 canonical message，再处理 Turn 终态。
      if (info?.result?.trim()) {
        const message = deps.store.appendMessage({
          sessionId,
          messageId: `msg_${sessionId}_${turn.turnId}_final`,
          role: 'agent',
          text: info.result,
          turnId: turn.turnId,
        });
        if (!message.duplicate) {
          deps.emitter.emit({
            type: 'task_message',
            taskId: sessionId,
            messageId: message.message.messageId,
            role: 'agent',
            state: 'complete',
            text: message.message.text,
            turnId: turn.turnId,
            eventSeq: message.message.eventSeq,
            at: message.message.createdAt,
          });
        }
      }

      const at = new Date().toISOString();
      deps.store.updateTurn(sessionId, turn.turnId, {
        status: status as 'success' | 'failed' | 'cancelled' | 'timeout',
        stopReason: info?.error,
        finishedAt: at,
      });
      if (status === 'success') {
        // Turn 成功不等于 Session 结束：事件与 wire 都保持 running/waiting_user。
        deps.store.updateSession(sessionId, { status: 'running', phase: 'waiting_user' });
        const statusEvent = deps.store.appendEvent({
          sessionId,
          type: 'task_status',
          payload: {
            taskId: sessionId,
            turnId: turn.turnId,
            status: 'running',
            phase: 'waiting_user',
          },
        });
        deps.emitter.emit({
          type: 'task_status',
          taskId: sessionId,
          turnId: turn.turnId,
          status: 'running',
          phase: 'waiting_user',
          eventSeq: statusEvent.eventSeq,
        });
        scheduleIdleClose(deps, sessionId);
        return;
      }

      const statusEvent = deps.store.appendEvent({
        sessionId,
        type: 'task_status',
        payload: { taskId: sessionId, turnId: turn.turnId, status, exitCode: info?.exitCode },
      });
      deps.store.closeSession(sessionId, status, info?.error);
      deps.emitter.emit({
        type: 'task_status',
        taskId: sessionId,
        turnId: turn.turnId,
        status,
        eventSeq: statusEvent.eventSeq,
        exitCode: info?.exitCode,
        error: info?.error,
        errorCode: info?.errorCode,
      });
    } catch (error) {
      deps.log('error', `[agent-bridge] conversation 事件落库失败 ${sessionId}：${(error as Error).message}`);
    }
  };

  const hooks: TaskHooks = {
    onBeforeLaunch: () => deps.store.claimTurnForLaunch(sessionId, turn.turnId, turn.tenantId),
    onLog: (stream, data) => {
      const text = data.replace(/\x1b\[[0-9;]*m/g, '');
      if (text.trim()) deps.log('info', `[${sessionId}#${turn.ordinal}] [${stream}] ${text.trimEnd()}`);
      let eventSeq: number | undefined;
      try {
        eventSeq = deps.store.appendEvent({
          sessionId,
          type: 'task_log',
          payload: { stream, data, isAnsi: hasAnsi(data) },
        }).eventSeq;
      } catch {
        /* event persistence must not kill the process */
      }
      deps.emitter.emit({ type: 'task_log', taskId: sessionId, turnId: turn.turnId, stream, data, isAnsi: hasAnsi(data), eventSeq });
    },
    onStep: (step) => {
      deps.registry.updateStep(sessionId, step);
      const at = new Date().toISOString();
      let eventSeq: number | undefined;
      try {
        eventSeq = deps.store.appendEvent({
          sessionId,
          type: 'task_step',
          payload: { ...step, at },
        }).eventSeq;
      } catch {
        /* event persistence must not kill the process */
      }
      deps.emitter.emit({
        type: 'task_step',
        taskId: sessionId,
        turnId: turn.turnId,
        ...step,
        at,
        eventSeq,
      });
    },
    // 中间 agent 消息（4.7）：与 dispatch 同口径 —— appendMessage 同事务写 messages+events
    //（message.eventSeq 即事件序号），duplicate 短路，不重复 appendEvent
    onAgentMessage: (message) => {
      const messageId =
        message.messageId ?? `msg_${sessionId}_am_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      try {
        const saved = deps.store.appendMessage({
          sessionId,
          messageId,
          role: 'agent',
          text: message.text,
          turnId: turn.turnId,
        });
        if (saved.duplicate) return;
        deps.emitter.emit({
          type: 'task_message',
          taskId: sessionId,
          messageId,
          role: 'agent',
          state: 'complete',
          text: message.text,
          turnId: turn.turnId,
          eventSeq: saved.message.eventSeq,
          at: saved.message.createdAt,
        });
      } catch (error) {
        deps.log('warn', `[agent-bridge] 中间消息 ${messageId} 未落库：${(error as Error).message}`);
      }
    },
    onPlan: (items) => deps.registry.updatePlan(sessionId, items),
    onInteraction: (request) => {
      try {
        if (!deps.interactions) throw new Error('InteractionBroker 未接入');
        deps.interactions.open({
          sessionId,
          requestId: request.requestId,
          kind: request.kind,
          payload: request.payload,
          turnId: turn.turnId,
          expiresAt: request.expiresAt,
        });
      } catch (error) {
        deps.log('error', `[agent-bridge] 创建交互失败 ${sessionId}：${(error as Error).message}`);
      }
    },
    onApprovalLookup: (input) => deps.approvalLookup?.(input, sessionId),
    onSession: (nativeSessionId) => {
      try {
        deps.store.updateSession(sessionId, { nativeSessionId });
      } catch (error) {
        deps.log('error', `[agent-bridge] 保存 native session id 失败 ${sessionId}：${(error as Error).message}`);
      }
    },
    onStatus,
  };

  if (
    deps.residentSessions &&
    def &&
    // 常驻通道的参数按 claude 写死（含 `--verbose`），而 qoder-cli 不认这个旗标
    // —— 实测 `qodercli -p --input-format stream-json ... --verbose` 直接退出。
    // 因此常驻只给 claude-code；qoder 走下方 startTask（headless + resumeArgs，已实测能续会话）。
    session.agentType === 'claude-code' &&
    !full
  ) {
    // 必须传**绝对路径**：常驻进程的 spawn 不经过 resolveBin，裸名直接落到 PATH 上查找。
    // qoder 实跑即此 —— `where qodercli` 找得到（扫描判「就绪」），但裸名 spawn 仍 ENOENT。
    const command = resolveBin([def.bin, ...(def.altBins ?? [])]);
    if (!command) {
      const message = `本机没有安装 ${def.display}（未找到 ${def.bin}）`;
      onStatus('failed', { error: message, errorCode: 'tool_not_installed' });
      throw new Error(message);
    }
    return startResidentTurn(deps, session, turn, prompt, hooks, command, timeoutMs);
  }

  let handle: TaskHandle;
  try {
    handle = startTask(
      {
        taskId: executionId,
        agentType: session.agentType,
        cwd: session.cwd,
        args: [],
        internalArgs: resumeArgs,
        prompt: turnPrompt,
        timeoutMs,
        allowedCwd: deps.allowedCwd,
        maxConcurrent: deps.maxConcurrent,
        maxQueued: deps.maxQueued,
        captureDiff: deps.captureDiffByDefault,
        diffMaxBytes: deps.diffMaxBytes,
        permissionMode,
        permissionPolicy: deps.permissionPolicy,
        externalSandbox: deps.externalSandbox,
        interactive: turn.execution?.allowInteractive === true && deps.interactionEnabled === true,
        interactionSessionId: sessionId,
        interactionTenantId: turn.tenantId,
        // full 会话走受管 headless + transcript replay；ACP/app-server 不再静默丢弃权限模式。
        acp: !full && Boolean(turnPrompt) && canRunAcp(def?.acp),
        acpSpec: acpSpecFor(def),
        appServer: !full && session.agentType === 'codex' && Boolean(turnPrompt),
        nativeSessionId: full ? undefined : session.nativeSessionId,
        replayPrompt,
      },
      hooks,
    );
  } catch (error) {
    onStatus('failed', { error: (error as Error).message, errorCode: 'internal' });
    throw error;
  }
  deps.tasks.set(sessionId, handle);
  void handle.done.then(() => {
    if (deps.tasks.get(sessionId) === handle) deps.tasks.delete(sessionId);
  });
  return handle;
}

function startResidentTurn(
  deps: ConversationDeps,
  session: SessionRecord,
  turn: TurnRecord,
  prompt: string,
  hooks: TaskHooks,
  command: string,
  timeoutMs?: number,
): TaskHandle {
  const sessionId = session.sessionId;
  const executionId = `${sessionId}__${turn.turnId}`;
  let resident = deps.residentSessions?.get(sessionId);
  if (!resident) {
    resident = new ClaudeResident({
      command,
      cwd: session.cwd,
      nativeSessionId: session.nativeSessionId,
    });
    deps.residentSessions?.set(sessionId, resident);
  }
  const current = resident;

  let settled = false;
  let status: TaskStatus = 'running';
  let resolveDone!: (value: TaskStatus) => void;
  const done = new Promise<TaskStatus>((resolve) => {
    resolveDone = resolve;
  });
  const settle = (next: TaskStatus, info?: TaskFinishInfo): void => {
    if (settled) return;
    settled = true;
    status = next;
    hooks.onStatus(next, info);
    if (next !== 'success') {
      current.close();
      deps.residentSessions?.delete(sessionId);
    }
    resolveDone(next);
  };

  const handle: TaskHandle = {
    taskId: executionId,
    cancel: () => {
      settle('cancelled', { error: '任务已取消', errorCode: 'cancelled' });
    },
    done: done.then(() => status),
  };
  deps.tasks.set(sessionId, handle);
  void done.then(() => {
    if (deps.tasks.get(sessionId) === handle) deps.tasks.delete(sessionId);
  });

  if (hooks.onBeforeLaunch && !hooks.onBeforeLaunch()) {
    settle('failed', { error: 'Turn 启动前持久化闸门未通过，未启动 CLI', errorCode: 'internal' });
    return handle;
  }

  void current.send(prompt, hooks, timeoutMs).then(
    (info) => settle('success', info),
    (error) => {
      const message = (error as Error).message;
      settle(message.includes('超时') ? 'timeout' : 'failed', {
        error: message,
        errorCode: message.includes('超时') ? 'timeout' : 'agent_error',
      });
    },
  );
  return handle;
}

function clearIdleClose(deps: ConversationDeps, sessionId: string): void {
  const timer = deps.idleTimers?.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  deps.idleTimers?.delete(sessionId);
}

function scheduleIdleClose(deps: ConversationDeps, sessionId: string): void {
  clearIdleClose(deps, sessionId);
  const idleMs = deps.idleTimeoutMs ?? 0;
  if (idleMs <= 0 || !deps.idleTimers) return;
  const timer = setTimeout(() => {
    deps.idleTimers?.delete(sessionId);
    const session = deps.store.getSession(sessionId);
    if (!session || session.status !== 'running' || session.phase !== 'waiting_user') return;
    deps.residentSessions?.get(sessionId)?.close();
    deps.residentSessions?.delete(sessionId);
    const lastTurn = deps.store.snapshot(sessionId).turns.at(-1);
    const event = deps.store.appendEvent({
      sessionId,
      type: 'task_status',
      payload: { status: 'success', reason: 'idle_timeout', turnId: lastTurn?.turnId },
    });
    deps.store.closeSession(sessionId, 'success', 'idle_timeout');
    deps.emitter.emit({
      type: 'task_status',
      taskId: sessionId,
      status: 'success',
      turnId: lastTurn?.turnId,
      error: 'idle_timeout',
      eventSeq: event.eventSeq,
    });
    deps.log('info', `[agent-bridge] 会话 ${sessionId} 空闲超时，已关闭`);
  }, idleMs);
  timer.unref?.();
  deps.idleTimers.set(sessionId, timer);
}

function transcriptOf(deps: ConversationDeps, sessionId: string): string {
  return deps.store
    .listMessages(sessionId)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n\n');
}

export function recoverConversationTurn(deps: ConversationDeps, turn: TurnRecord): void {
  const session = deps.store.getSession(turn.sessionId, turn.tenantId);
  if (!session || session.status !== 'running' || !turn.execution) return;
  startConversationTurn(deps, session, turn, turn.execution.prompt ?? '', turn.execution.timeoutMs);
}

export function dispatchConversationRun(msg: RunTaskMessage, deps: ConversationDeps): void {
  const existing = deps.store.getSession(msg.taskId);
  if (existing) {
    if (existing.status !== 'running') {
      deps.emitter.emit({
        type: 'task_status',
        taskId: msg.taskId,
        status: existing.status,
        error: '会话已结束（幂等重放，未重复执行）',
      });
      return;
    }
    deps.emitter.emit({
      type: 'task_status',
      taskId: msg.taskId,
      status: 'running',
      phase: wirePhase(existing.phase),
    });
    return;
  }

  // 没有可续通道的工具不能开 conversation：先接受再失败比当场拒绝更糟（spec「不支持的 conversation」）。
  // 未知工具单列出来 —— 用 session_not_continuable 报「打错名字」会把排查方向带偏。
  if (!agentDefOf(msg.agentType)) {
    deps.emitter.emit({
      type: 'task_status',
      taskId: msg.taskId,
      status: 'failed',
      error: `不支持的工具：${msg.agentType}`,
      errorCode: 'tool_not_installed',
      requestedBy: msg.requestedBy,
    });
    return;
  }
  if (!agentCanContinue(msg.agentType)) {
    deps.emitter.emit({
      type: 'task_status',
      taskId: msg.taskId,
      status: 'failed',
      error: `该工具不支持多轮会话（continuation = single-turn）：${msg.agentType}`,
      errorCode: 'session_not_continuable',
      requestedBy: msg.requestedBy,
    });
    return;
  }

  const created = deps.store.createSession({
    sessionId: msg.taskId,
    mode: 'conversation',
    agentType: msg.agentType,
    cwd: msg.cwd,
    permissionMode: msg.permissionMode,
    phase: 'queued',
  });
  const initialText = msg.prompt ?? '';
  const turn = deps.store.createTurn({
    sessionId: msg.taskId,
    status: 'queued',
    execution: {
      args: [],
      prompt: initialText,
      timeoutMs: msg.timeoutMs,
      allowInteractive: msg.allowInteractive,
      permissionMode: msg.permissionMode,
      requestedBy: msg.requestedBy,
      purpose: msg.purpose,
    },
  });
  const initial = deps.store.appendMessage({
    sessionId: msg.taskId,
    messageId: `msg_${msg.taskId}_initial`,
    role: 'user',
    text: initialText,
    turnId: turn.turnId,
  });
  if (!initial.duplicate) {
    deps.emitter.emit({
      type: 'task_message',
      taskId: msg.taskId,
      messageId: initial.message.messageId,
      role: 'user',
      state: 'complete',
      text: initial.message.text,
      turnId: turn.turnId,
      eventSeq: initial.message.eventSeq,
      at: initial.message.createdAt,
    });
  }
  deps.registry.register(msg.taskId, { agentType: msg.agentType, cwd: msg.cwd, source: 'platform' });
  deps.log('info', `\n▶ 创建会话 ${msg.taskId}：${msg.agentType}`);
  startConversationTurn(deps, created.session, turn, initialText, msg.timeoutMs);
}

export async function dispatchConversationMessage(
  msg: SendMessageMessage,
  deps: ConversationDeps,
): Promise<void> {
  const reject = (errorCode: string): void => {
    deps.emitter.emit({
      type: 'message_ack',
      taskId: msg.taskId,
      messageId: msg.messageId,
      delivery: 'rejected',
      errorCode,
      at: new Date().toISOString(),
    });
  };

  const gate = authorizeService(msg, 'run_task', msg.taskId, 'task:create', deps.requireServiceToken);
  if (!gate.ok) return reject(gate.code);

  const session = deps.store.getSession(msg.taskId);
  if (!session) return reject('session_not_found');
  if (session.mode !== 'conversation') return reject('session_not_continuable');
  if (session.status !== 'running') return reject('session_closed');
  // 鉴权与状态校验通过后才停 idle 计时；未授权请求不能靠空转保活会话。
  clearIdleClose(deps, msg.taskId);

  const text = msg.parts.map((part) => part.text).join('\n').trim();
  if (!text) return reject('empty_message');

  const existing = deps.store.getMessage(msg.taskId, msg.messageId);
  if (existing) {
    if (existing.text !== text || existing.role !== 'user') return reject('message_conflict');
    deps.emitter.emit({
      type: 'message_ack',
      taskId: msg.taskId,
      messageId: msg.messageId,
      turnId: existing.turnId,
      eventSeq: existing.eventSeq,
      delivery: 'duplicate',
      at: new Date().toISOString(),
    });
    return;
  }

  if (msg.mode === 'steer') {
    if (session.phase === 'waiting_user' || session.phase === 'settled') {
      return reject('steer_unsupported');
    }
    const handle = deps.tasks.get(msg.taskId);
    if (!handle?.steer) return reject('steer_unsupported');
    const turns = deps.store.snapshot(msg.taskId).turns;
    const current = [...turns].reverse().find((t) => t.status === 'running' || t.status === 'queued');
    if (!current) return reject('steer_unsupported');
    const ok = await handle.steer(text);
    if (!ok) return reject('steer_unsupported');
    const userMessage = deps.store.appendMessage({
      sessionId: msg.taskId,
      messageId: msg.messageId,
      role: 'user',
      text,
      turnId: current.turnId,
    });
    deps.emitter.emit({
      type: 'message_ack',
      taskId: msg.taskId,
      messageId: msg.messageId,
      turnId: current.turnId,
      eventSeq: userMessage.message.eventSeq,
      delivery: 'queued',
      at: new Date().toISOString(),
    });
    deps.emitter.emit({
      type: 'task_message',
      taskId: msg.taskId,
      messageId: msg.messageId,
      role: 'user',
      state: 'complete',
      text,
      turnId: current.turnId,
      eventSeq: userMessage.message.eventSeq,
      at: userMessage.message.createdAt,
    });
    return;
  }

  if (session.phase !== 'waiting_user') return reject('session_busy');

  const nativeResume = Boolean(agentDefOf(session.agentType)?.resumeArgs && session.nativeSessionId);
  const priorTranscript = transcriptOf(deps, msg.taskId);
  const prompt = nativeResume ? text : `${priorTranscript}${priorTranscript ? '\n\n' : ''}User: ${text}`;
  const allowInteractive = deps.store.snapshot(msg.taskId).turns.at(-1)?.execution?.allowInteractive === true;
  const turn = deps.store.createTurn({
    sessionId: msg.taskId,
    status: 'queued',
    execution: { args: [], prompt, allowInteractive },
  });
  const userMessage = deps.store.appendMessage({
    sessionId: msg.taskId,
    messageId: msg.messageId,
    role: 'user',
    text,
    turnId: turn.turnId,
  });
  deps.emitter.emit({
    type: 'message_ack',
    taskId: msg.taskId,
    messageId: msg.messageId,
    turnId: turn.turnId,
    eventSeq: userMessage.message.eventSeq,
    delivery: 'queued',
    at: new Date().toISOString(),
  });
  deps.emitter.emit({
    type: 'task_message',
    taskId: msg.taskId,
    messageId: msg.messageId,
    role: 'user',
    state: 'complete',
    text,
    turnId: turn.turnId,
    eventSeq: userMessage.message.eventSeq,
    at: userMessage.message.createdAt,
  });
  startConversationTurn(deps, session, turn, prompt);
}

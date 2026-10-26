/**
 * 任务指令编排（应用编排层）
 *
 * 把「平台下发 run_task / cancel_task」到「本地起进程 + 回传状态」这一段从入口文件里搬出来。
 * 这里**不碰终端**：所有输出走注入的 `log`，所以控制面板复用同一段逻辑时不会污染 stdout。
 *
 * 上行一律经 `Emitter.emit()`（终态幂等 / 日志脱敏 / 审计 / 信封收口都在这条路上）。
 */

import type { Emitter } from '../core/emitter.js';
import { hasAnsi } from '../core/ansi.js';
import { startTask, type TaskHandle } from '../runner.js';
import type { ServerMessage, TaskStatus } from '../protocol.js';
import { authorizeService } from './service-gate.js';
import { canRunAcp } from '../adapters/acp-codebuddy.js';
import { agentDefOf } from '../adapters/agent-adapters.js';
import type { SessionLog } from './session-log.js';
import type { TaskRegistry } from './task-registry.js';
import type { SessionStore, TurnRecord } from '../core/session-store.js';
import { dispatchConversationRun } from './conversation.js';

export type RunTaskMessage = Extract<ServerMessage, { type: 'run_task' }>;
export type CancelTaskMessage = Extract<ServerMessage, { type: 'cancel_task' }>;
export type GetTaskMessage = Extract<ServerMessage, { type: 'get_task' }>;
export type CloseSessionMessage = Extract<ServerMessage, { type: 'close_session' }>;
export type CancelTurnMessage = Extract<ServerMessage, { type: 'cancel_turn' }>;
export type InteractionResponseMessage = Extract<ServerMessage, { type: 'task_interaction_response' }>;

export interface TaskDispatchOptions {
  /** 唯一上行出口 */
  emitter: Emitter;
  /** 在跑/排队的任务句柄（取消用；终态后由 session 摘除） */
  tasks: Map<string, TaskHandle>;
  /** 任务注册表（终端面板 / Web 面板的共享视图） */
  registry: TaskRegistry;
  allowedCwd?: string[];
  maxConcurrent: number;
  maxQueued: number;
  diffMaxBytes: number;
  /** 平台没带 captureDiff 时，是否按本地配置的 diff_default 开启 */
  captureDiffByDefault: boolean;
  requireServiceToken: boolean;
  /** 持久 Session/Turn/Event 权威源 */
  store: SessionStore;
  log: SessionLog;
  /** 常驻 conversation 进程（close_session 成功后才回收） */
  residentSessions?: Map<string, import('./claude-resident.js').ClaudeResident>;
  /** waiting_user 空闲计时器（close_session 成功后才清除） */
  idleTimers?: Map<string, NodeJS.Timeout>;
}

function clearIdleTimer(o: TaskDispatchOptions, sessionId: string): void {
  const timer = o.idleTimers?.get(sessionId);
  if (!timer) return;
  clearTimeout(timer);
  o.idleTimers?.delete(sessionId);
}

/** 取消同样要鉴权：拿到 task:create 的令牌不等于能杀别人的任务 */
export function dispatchCancelTask(msg: CancelTaskMessage, o: TaskDispatchOptions): void {
  const gate = authorizeService(msg, 'cancel_task', msg.taskId, 'task:cancel', o.requireServiceToken);
  if (!gate.ok) {
    o.log('error', `[agent-bridge] 拒绝取消 ${msg.taskId}：${gate.message}`);
    return;
  }
  o.tasks.get(msg.taskId)?.cancel();
}

function terminalStatus(status: string): status is 'success' | 'failed' | 'cancelled' | 'timeout' {
  return status === 'success' || status === 'failed' || status === 'cancelled' || status === 'timeout';
}

function ackSession(
  o: TaskDispatchOptions,
  msg: CloseSessionMessage | CancelTurnMessage,
  action: 'close_session' | 'cancel_turn',
  ok: boolean,
  extra: { status?: string; errorCode?: string } = {},
): void {
  o.emitter.emit({
    type: 'session_ack',
    taskId: msg.taskId,
    operationId: msg.operationId,
    action,
    ok,
    status: extra.status,
    errorCode: extra.errorCode,
    at: new Date().toISOString(),
  });
}

export function dispatchCloseSession(msg: CloseSessionMessage, o: TaskDispatchOptions): void {
  const gate = authorizeService(msg, 'cancel_task', msg.taskId, 'task:cancel', o.requireServiceToken);
  if (!gate.ok) {
    ackSession(o, msg, 'close_session', false, { errorCode: gate.code });
    return;
  }
  const session = o.store.getSession(msg.taskId);
  if (!session) {
    ackSession(o, msg, 'close_session', false, { errorCode: 'session_not_found' });
    return;
  }
  if (session.status !== 'running') {
    clearIdleTimer(o, msg.taskId);
    o.residentSessions?.get(msg.taskId)?.close();
    o.residentSessions?.delete(msg.taskId);
    ackSession(o, msg, 'close_session', true, { status: session.status });
    return;
  }
  const handle = o.tasks.get(msg.taskId);
  if (handle) {
    clearIdleTimer(o, msg.taskId);
    handle.cancel();
    ackSession(o, msg, 'close_session', true, { status: 'cancelled' });
    return;
  }
  const active = o.store.getActiveTurn(msg.taskId);
  if (active) {
    o.store.updateTurn(msg.taskId, active.turnId, {
      status: 'cancelled',
      stopReason: 'session_closed',
      finishedAt: new Date().toISOString(),
    });
  }
  clearIdleTimer(o, msg.taskId);
  const closed = o.store.closeSession(msg.taskId, 'cancelled', 'session_closed');
  o.residentSessions?.get(msg.taskId)?.close();
  o.residentSessions?.delete(msg.taskId);
  ackSession(o, msg, 'close_session', true, { status: closed.status });
}

export function dispatchCancelTurn(msg: CancelTurnMessage, o: TaskDispatchOptions): void {
  const gate = authorizeService(msg, 'cancel_task', msg.taskId, 'task:cancel', o.requireServiceToken);
  if (!gate.ok) {
    ackSession(o, msg, 'cancel_turn', false, { errorCode: gate.code });
    return;
  }
  const session = o.store.getSession(msg.taskId);
  if (!session) {
    ackSession(o, msg, 'cancel_turn', false, { errorCode: 'session_not_found' });
    return;
  }
  const active = o.store.getActiveTurn(msg.taskId);
  if (!active || active.turnId !== msg.turnId) {
    ackSession(o, msg, 'cancel_turn', false, { errorCode: 'turn_not_found' });
    return;
  }
  const handle = o.tasks.get(msg.taskId);
  if (handle) {
    handle.cancel();
    ackSession(o, msg, 'cancel_turn', true, { status: 'cancelled' });
    return;
  }
  o.store.updateTurn(msg.taskId, active.turnId, {
    status: 'cancelled',
    stopReason: 'turn_cancelled',
    finishedAt: new Date().toISOString(),
  });
  if (session.mode === 'task') {
    o.store.closeSession(msg.taskId, 'cancelled', 'turn_cancelled');
  } else {
    o.store.updateSession(msg.taskId, { phase: 'waiting_user' });
  }
  ackSession(o, msg, 'cancel_turn', true, { status: 'cancelled' });
}

export function dispatchInteractionResponse(
  msg: InteractionResponseMessage,
  o: TaskDispatchOptions,
): void {
  const emitResult = (
    state: 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed',
    extra: { responseId?: string; resultSeq?: number; resultPayload?: Record<string, unknown>; errorCode?: string } = {},
  ): void => {
    o.emitter.emit({
      type: 'task_interaction_result',
      taskId: msg.taskId,
      requestId: msg.requestId,
      state,
      ...extra,
    });
  };

  const interaction = o.store.getInteraction(msg.taskId, msg.requestId);
  if (!interaction) {
    emitResult('failed', { errorCode: 'interaction_not_found' });
    return;
  }
  if (interaction.state !== 'pending') {
    if (interaction.responseId === msg.responseId) {
      const settledState = interaction.state as
        | 'accepted'
        | 'declined'
        | 'cancelled'
        | 'expired'
        | 'failed';
      emitResult(settledState, {
        responseId: interaction.responseId,
        resultSeq: interaction.resultSeq,
        resultPayload: interaction.resultPayload as Record<string, unknown> | undefined,
      });
    } else {
      emitResult('failed', { errorCode: 'interaction_already_resolved' });
    }
    return;
  }
  if (interaction.expiresAt && Date.parse(interaction.expiresAt) <= Date.now()) {
    const event = o.store.appendEvent({
      sessionId: msg.taskId,
      type: 'task_interaction_result',
      payload: {
        requestId: msg.requestId,
        responseId: msg.responseId,
        state: 'expired',
      },
    });
    const expired = o.store.resolveInteraction({
      sessionId: msg.taskId,
      requestId: msg.requestId,
      state: 'expired',
      responseId: msg.responseId,
      resultSeq: event.eventSeq,
    });
    emitResult('expired', {
      responseId: expired.responseId,
      resultSeq: expired.resultSeq,
    });
    return;
  }

  const scope = interaction.kind === 'permission' ? 'task:approve' : 'task:respond';
  const gate = authorizeService(msg, 'task_interaction_response', msg.taskId, scope, o.requireServiceToken);
  if (!gate.ok) {
    emitResult('failed', { errorCode: gate.code });
    return;
  }

  const payload = msg.payload ?? {};
  const event = o.store.appendEvent({
    sessionId: msg.taskId,
    type: 'task_interaction_result',
    payload: {
      requestId: msg.requestId,
      responseId: msg.responseId,
      state: msg.state,
      resultPayload: payload,
    },
  });
  const resolved = o.store.resolveInteraction({
    sessionId: msg.taskId,
    requestId: msg.requestId,
    state: msg.state,
    responseId: msg.responseId,
    resultSeq: event.eventSeq,
    resultPayload: payload,
  });
  const explicitOption =
    typeof payload['optionId'] === 'string'
      ? (payload['optionId'] as string)
      : typeof payload['option_id'] === 'string'
        ? (payload['option_id'] as string)
        : undefined;
  const requestOptions = (interaction.payload as { options?: Array<Record<string, unknown>> }).options;
  const fallbackOption =
    msg.state === 'accepted' && Array.isArray(requestOptions)
      ? requestOptions.find((option) => String(option['kind'] ?? '').startsWith('allow'))?.['optionId']
      : undefined;
  const optionId =
    explicitOption ?? (typeof fallbackOption === 'string' ? fallbackOption : undefined);
  o.tasks.get(msg.taskId)?.respondInteraction?.(msg.requestId, optionId);
  emitResult(resolved.state as 'accepted' | 'declined' | 'cancelled', {
    responseId: resolved.responseId,
    resultSeq: resolved.resultSeq,
    resultPayload: payload,
  });
}

export function dispatchGetTask(msg: GetTaskMessage, o: TaskDispatchOptions): void {
  const gate = authorizeService(msg, 'get_task', msg.taskId, 'task:read', o.requireServiceToken);
  if (!gate.ok) {
    o.emitter.emit({
      type: 'task_snapshot',
      taskId: msg.taskId,
      requestId: msg.requestId,
      found: false,
      errorCode: gate.code,
    });
    return;
  }
  try {
    const snapshot = o.store.snapshot(msg.taskId, {
      afterEventSeq: msg.afterEventSeq,
      limit: msg.limit,
    });
    o.emitter.emit({
      type: 'task_snapshot',
      taskId: msg.taskId,
      requestId: msg.requestId,
      found: true,
      session: snapshot.session as unknown as Record<string, unknown>,
      turns: snapshot.turns as unknown as Record<string, unknown>[],
      events: snapshot.events.map((event) => ({
        eventSeq: event.eventSeq,
        type: event.type,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
      oldestEventSeq: snapshot.oldestEventSeq,
      latestEventSeq: snapshot.latestEventSeq,
    });
  } catch (error) {
    o.emitter.emit({
      type: 'task_snapshot',
      taskId: msg.taskId,
      requestId: msg.requestId,
      found: false,
      errorCode: 'task_not_found',
    });
    o.log('error', `[agent-bridge] 读取快照失败 ${msg.taskId}：${(error as Error).message}`);
  }
}

export function dispatchRunTask(msg: RunTaskMessage, o: TaskDispatchOptions): void {
  const gate = authorizeService(msg, 'run_task', msg.taskId, 'task:create', o.requireServiceToken);
  if (!gate.ok) {
    o.log('error', `[agent-bridge] 拒绝执行 ${msg.taskId}：${gate.message}`);
    o.emitter.emit({
      type: 'task_status',
      taskId: msg.taskId,
      status: 'failed',
      error: `服务身份校验失败：${gate.message}`,
      errorCode: gate.code,
      requestedBy: msg.requestedBy,
    });
    return;
  }

  if (msg.sessionMode === 'conversation') {
    dispatchConversationRun(msg, o);
    return;
  }

  let sessionCreated = false;
  let turn: TurnRecord | undefined;
  try {
    const existing = o.store.getSession(msg.taskId);
    if (existing && existing.status !== 'running') {
      // 跨进程重发：Session 的终态是权威，不再重新 spawn。
      if (!o.tasks.has(msg.taskId)) {
        o.emitter.emit({
          type: 'task_status',
          taskId: msg.taskId,
          status: existing.status as TaskStatus,
          error: '会话已结束（幂等重放，未重复执行）',
          requestedBy: msg.requestedBy,
        });
        return;
      }
    }
    if (!existing) {
      const created = o.store.createSession({
        sessionId: msg.taskId,
        mode: 'task',
        agentType: msg.agentType,
        cwd: msg.cwd,
        phase: 'queued',
      });
      sessionCreated = created.created;
      turn = o.store.createTurn({ sessionId: msg.taskId, status: 'queued' });
    }
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'session_store_error';
    o.emitter.emit({
      type: 'task_status',
      taskId: msg.taskId,
      status: 'failed',
      error: `会话状态不可用：${(error as Error).message}`,
      errorCode: code,
      requestedBy: msg.requestedBy,
    });
    return;
  }

  const who = msg.requestedBy ? `（${msg.requestedBy}${msg.purpose ? ` / ${msg.purpose}` : ''}）` : '';
  o.log('info', `\n▶ 执行任务 ${msg.taskId}：${msg.agentType}${who}`);

  o.registry.register(msg.taskId, { agentType: msg.agentType, cwd: msg.cwd, source: 'platform' });

  const handle = startTask(
    {
      taskId: msg.taskId,
      agentType: msg.agentType,
      cwd: msg.cwd,
      args: msg.args,
      prompt: msg.prompt,
      timeoutMs: msg.timeoutMs,
      allowedCwd: o.allowedCwd,
      maxConcurrent: o.maxConcurrent,
      maxQueued: o.maxQueued,
      captureDiff: msg.captureDiff === true || o.captureDiffByDefault,
      diffMaxBytes: o.diffMaxBytes,
      interactive: msg.allowInteractive === true,
      acp: Boolean(msg.prompt) && canRunAcp(agentDefOf(msg.agentType)?.acp),
      acpSpec: agentDefOf(msg.agentType)?.acp,
      appServer: msg.agentType === 'codex' && Boolean(msg.prompt),
      claudeStream:
        Boolean(msg.prompt) &&
        msg.allowInteractive === true &&
        (msg.agentType === 'claude-code' || msg.agentType === 'qoder-cli'),
    },
    {
      onLog: (stream, data) => {
        const text = data.replace(/\x1b\[[0-9;]*m/g, '');
        if (text.trim()) o.log('info', `[${stream}] ${text.trimEnd()}`);
        let eventSeq: number | undefined;
        if (sessionCreated) {
          eventSeq = o.store.appendEvent({
            sessionId: msg.taskId,
            type: 'task_log',
            payload: { stream, data, isAnsi: hasAnsi(data) },
          }).eventSeq;
        }
        o.emitter.emit({
          type: 'task_log',
          taskId: msg.taskId,
          stream,
          data,
          isAnsi: hasAnsi(data),
          turnId: turn?.turnId,
          eventSeq,
        });
      },
      // 步骤流（B 批次）：仅 steps:true 的工具会触发；label 的截断与脱敏在 Emitter 收口
      onStep: (step) => {
        o.registry.updateStep(msg.taskId, step);
        const at = new Date().toISOString();
        let eventSeq: number | undefined;
        if (sessionCreated) {
          eventSeq = o.store.appendEvent({
            sessionId: msg.taskId,
            type: 'task_step',
            payload: { ...step, at },
          }).eventSeq;
        }
        o.emitter.emit({
          type: 'task_step',
          taskId: msg.taskId,
          ...step,
          at,
          turnId: turn?.turnId,
          eventSeq,
        });
      },
      onPlan: (items) => {
        o.registry.updatePlan(msg.taskId, items);
      },
      onSession: (nativeSessionId) => {
        try {
          o.store.updateSession(msg.taskId, { nativeSessionId });
        } catch (error) {
          o.log('error', `[agent-bridge] 保存 native session id 失败 ${msg.taskId}：${(error as Error).message}`);
        }
      },
      onInteraction: (request) => {
        try {
          o.store.requestInteraction({
            sessionId: msg.taskId,
            requestId: request.requestId,
            kind: request.kind,
            payload: request.payload,
            turnId: turn?.turnId,
            expiresAt: request.expiresAt,
          });
          let eventSeq: number | undefined;
          if (sessionCreated) {
            eventSeq = o.store.appendEvent({
              sessionId: msg.taskId,
              type: 'task_interaction_request',
              payload: {
                requestId: request.requestId,
                kind: request.kind,
                payload: request.payload,
                expiresAt: request.expiresAt,
              },
            }).eventSeq;
          }
          o.emitter.emit({
            type: 'task_interaction_request',
            taskId: msg.taskId,
            requestId: request.requestId,
            turnId: turn?.turnId,
            kind: request.kind,
            payload: request.payload,
            expiresAt: request.expiresAt,
            eventSeq,
          });
        } catch (error) {
          o.log('error', `[agent-bridge] 创建交互失败 ${msg.taskId}：${(error as Error).message}`);
        }
      },
      onStatus: (status, info) => {
        o.registry.updateStatus(msg.taskId, status, info);
        if (info?.changedFiles?.length) {
          o.log(
            'info',
            `[agent-bridge] 变更 ${info.changedFiles.length} 个文件：${info.changedFiles.slice(0, 8).join(', ')}`,
          );
        }
        let eventSeq: number | undefined;
        if (sessionCreated) {
          try {
            // 最终回答先落 canonical task_message，再落终态；平台按 eventSeq 可完整重建。
            if (terminalStatus(status) && info?.result?.trim()) {
              const at = new Date().toISOString();
              const messageId = `msg_${msg.taskId}_final`;
              const messageEvent = o.store.appendEvent({
                sessionId: msg.taskId,
                type: 'task_message',
                payload: {
                  messageId,
                  role: 'agent',
                  state: 'complete',
                  text: info.result,
                  turnId: turn?.turnId,
                  at,
                },
              });
              o.emitter.emit({
                type: 'task_message',
                taskId: msg.taskId,
                messageId,
                role: 'agent',
                state: 'complete',
                text: info.result,
                turnId: turn?.turnId,
                eventSeq: messageEvent.eventSeq,
                at,
              });
            }
            const nextPhase =
              status === 'running' ? (info?.phase === 'queued' ? 'queued' : 'running') : 'settled';
            o.store.updateSession(msg.taskId, { phase: nextPhase });
            if (turn) {
              const at = new Date().toISOString();
              const turnPatch: {
                status: TurnRecord['status'];
                startedAt?: string;
                finishedAt?: string;
              } = {
                status:
                  status === 'running'
                    ? info?.phase === 'queued'
                      ? 'queued'
                      : 'running'
                    : (status as 'success' | 'failed' | 'cancelled' | 'timeout'),
              };
              if (status === 'running' && info?.phase !== 'queued') turnPatch.startedAt = at;
              if (terminalStatus(status)) turnPatch.finishedAt = at;
              o.store.updateTurn(msg.taskId, turn.turnId, turnPatch);
            }
            const payload = {
              taskId: msg.taskId,
              status,
              exitCode: info?.exitCode,
              error: info?.error,
              errorCode: info?.errorCode,
              phase: info?.phase,
              queuePosition: info?.queuePosition,
              diff: info?.diff,
              changedFiles: info?.changedFiles,
              diffTruncated: info?.diffTruncated,
              requestedBy: msg.requestedBy,
            };
            eventSeq = o.store.appendEvent({
              sessionId: msg.taskId,
              type: 'task_status',
              payload,
            }).eventSeq;
            if (terminalStatus(status)) {
              o.store.closeSession(msg.taskId, status, info?.error);
            }
          } catch (error) {
            o.log('error', `[agent-bridge] 会话事件落库失败 ${msg.taskId}：${(error as Error).message}`);
          }
        }
        o.emitter.emit({
          type: 'task_status',
          taskId: msg.taskId,
          status,
          exitCode: info?.exitCode,
          error: info?.error,
          errorCode: info?.errorCode,
          phase: info?.phase,
          queuePosition: info?.queuePosition,
          diff: info?.diff,
          changedFiles: info?.changedFiles,
          diffTruncated: info?.diffTruncated,
          requestedBy: msg.requestedBy,
          turnId: turn?.turnId,
          eventSeq,
        });
      },
    },
  );

  o.tasks.set(msg.taskId, handle);
  void handle.done.then(() => o.tasks.delete(msg.taskId));
}

/**
 * Conversation turns (1.0).
 *
 * Strategy: replay-session. Each Turn starts a fresh CLI process with a prompt built from the
 * persisted user/agent transcript. The Session stays open in waiting_user after a successful turn.
 * Adapters that need native session ids can replace this path later without changing the wire model.
 */

import { startTask, type TaskHandle } from '../runner.js';
import type { TaskFinishInfo, TaskHooks } from '../core/task-supervisor.js';
import type { ServerMessage, TaskStatus, TaskPhase } from '../protocol.js';
import type { Emitter } from '../core/emitter.js';
import type { SessionStore, SessionRecord, SessionPhase, TurnRecord } from '../core/session-store.js';
import type { TaskRegistry } from './task-registry.js';
import type { SessionLog } from './session-log.js';
import { authorizeService } from './service-gate.js';
import { agentDefOf } from '../adapters/agent-adapters.js';
import { hasCodebuddyAcpAuth } from '../adapters/acp-codebuddy.js';

type RunTaskMessage = Extract<ServerMessage, { type: 'run_task' }>;
type SendMessageMessage = Extract<ServerMessage, { type: 'send_message' }>;

export interface ConversationDeps {
  emitter: Emitter;
  tasks: Map<string, TaskHandle>;
  registry: TaskRegistry;
  store: SessionStore;
  allowedCwd?: string[];
  maxConcurrent: number;
  maxQueued: number;
  diffMaxBytes: number;
  captureDiffByDefault: boolean;
  requireServiceToken: boolean;
  log: SessionLog;
}

function phaseOf(status: TaskStatus, info?: TaskFinishInfo): TaskPhase {
  if (status !== 'running') return 'running';
  return info?.phase === 'queued' ? 'queued' : 'running';
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
    exitCode: info?.exitCode,
    error: info?.error,
    errorCode: info?.errorCode,
    requestedBy: undefined,
  };
  const event = deps.store.appendEvent({ sessionId, type: 'task_status', payload });
  deps.emitter.emit({
    type: 'task_status',
    taskId: sessionId,
    turnId,
    status,
    phase,
    exitCode: info?.exitCode,
    error: info?.error,
    errorCode: info?.errorCode,
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
  const resumeArgs =
    def?.resumeArgs && session.nativeSessionId
      ? def.resumeArgs.map((arg) => arg.replaceAll('{{sessionId}}', session.nativeSessionId as string))
      : [];
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
    onLog: (stream, data) => {
      const text = data.replace(/\x1b\[[0-9;]*m/g, '');
      if (text.trim()) deps.log('info', `[${sessionId}#${turn.ordinal}] [${stream}] ${text.trimEnd()}`);
      let eventSeq: number | undefined;
      try {
        eventSeq = deps.store.appendEvent({
          sessionId,
          type: 'task_log',
          payload: { stream, data, isAnsi: true },
        }).eventSeq;
      } catch {
        /* event persistence must not kill the process */
      }
      deps.emitter.emit({ type: 'task_log', taskId: sessionId, turnId: turn.turnId, stream, data, isAnsi: true, eventSeq });
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
    onPlan: (items) => deps.registry.updatePlan(sessionId, items),
    onInteraction: (request) => {
      try {
        deps.store.requestInteraction({
          sessionId,
          requestId: request.requestId,
          kind: request.kind,
          payload: request.payload,
          turnId: turn.turnId,
          expiresAt: request.expiresAt,
        });
        let eventSeq: number | undefined;
        try {
          eventSeq = deps.store.appendEvent({
            sessionId,
            type: 'task_interaction_request',
            payload: {
              requestId: request.requestId,
              kind: request.kind,
              payload: request.payload,
              expiresAt: request.expiresAt,
            },
          }).eventSeq;
        } catch {
          /* event persistence must not kill the process */
        }
        deps.emitter.emit({
          type: 'task_interaction_request',
          taskId: sessionId,
          requestId: request.requestId,
          turnId: turn.turnId,
          kind: request.kind,
          payload: request.payload,
          expiresAt: request.expiresAt,
          eventSeq,
        });
      } catch (error) {
        deps.log('error', `[agent-bridge] 创建交互失败 ${sessionId}：${(error as Error).message}`);
      }
    },
    onSession: (nativeSessionId) => {
      try {
        deps.store.updateSession(sessionId, { nativeSessionId });
      } catch (error) {
        deps.log('error', `[agent-bridge] 保存 native session id 失败 ${sessionId}：${(error as Error).message}`);
      }
    },
    onStatus,
  };

  let handle: TaskHandle;
  try {
    handle = startTask(
      {
        taskId: executionId,
        agentType: session.agentType,
        cwd: session.cwd,
        args: resumeArgs,
        prompt,
        timeoutMs,
        allowedCwd: deps.allowedCwd,
        maxConcurrent: deps.maxConcurrent,
        maxQueued: deps.maxQueued,
        captureDiff: deps.captureDiffByDefault,
        diffMaxBytes: deps.diffMaxBytes,
        acp:
          session.agentType === 'codebuddy-cli' &&
          Boolean(prompt) &&
          hasCodebuddyAcpAuth(),
        nativeSessionId: session.nativeSessionId,
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

function transcriptOf(deps: ConversationDeps, sessionId: string): string {
  return deps.store
    .listMessages(sessionId)
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n\n');
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

  const created = deps.store.createSession({
    sessionId: msg.taskId,
    mode: 'conversation',
    agentType: msg.agentType,
    cwd: msg.cwd,
    phase: 'queued',
  });
  const turn = deps.store.createTurn({ sessionId: msg.taskId, status: 'queued' });
  const initialText = msg.prompt ?? '';
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

export function dispatchConversationMessage(msg: SendMessageMessage, deps: ConversationDeps): void {
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
  if (session.phase !== 'waiting_user') return reject('session_busy');
  if (msg.mode === 'steer') return reject('steer_unsupported');

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

  const turn = deps.store.createTurn({ sessionId: msg.taskId, status: 'queued' });
  const userMessage = deps.store.appendMessage({
    sessionId: msg.taskId,
    messageId: msg.messageId,
    role: 'user',
    text,
    turnId: turn.turnId,
  });
  const nativeResume = Boolean(agentDefOf(session.agentType)?.resumeArgs && session.nativeSessionId);
  const prompt = nativeResume ? text : transcriptOf(deps, msg.taskId);
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

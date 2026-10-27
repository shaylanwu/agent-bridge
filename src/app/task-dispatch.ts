/**
 * 任务指令编排（应用编排层）
 *
 * 把「平台下发 run_task / cancel_task」到「本地起进程 + 回传状态」这一段从入口文件里搬出来。
 * 这里**不碰终端**：所有输出走注入的 `log`，所以控制面板复用同一段逻辑时不会污染 stdout。
 *
 * 上行一律经 `Emitter.emit()`（终态幂等 / 日志脱敏 / 审计 / 信封收口都在这条路上）。
 */

import type { Emitter } from '../core/emitter.js';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { hasAnsi } from '../core/ansi.js';
import { validateFormContent } from '../core/form-schema.js';
import type { PermissionPolicyName } from '../core/permission-policy.js';
import {
  approvalExpiry,
  approvalFingerprint,
  canAutoApprove,
  PERSISTENT_OPTION_KINDS,
  permissionTarget,
  persistentAllowOption,
} from '../core/permission-ledger.js';
import { startTask, type TaskHandle } from '../runner.js';
import type { ApprovalLookupInput, ApprovalLookupResult } from '../core/task-supervisor.js';
import { ARTIFACT_INLINE_MAX_BYTES } from '../protocol.js';
import type { PermissionMode, ServerMessage, TaskStatus } from '../protocol.js';
import { authorizeService } from './service-gate.js';
import { writeAudit } from '../infra/audit.js';
import { canRunAcp } from '../adapters/acp-codebuddy.js';
import { agentDefOf } from '../adapters/agent-adapters.js';
import type { SessionLog } from './session-log.js';
import type { TaskRegistry } from './task-registry.js';
import type { SessionStore, TurnRecord } from '../core/session-store.js';
import { dispatchConversationRun } from './conversation.js';

export type RunTaskMessage = Extract<ServerMessage, { type: 'run_task' }>;
export type CancelTaskMessage = Extract<ServerMessage, { type: 'cancel_task' }>;
export type GetTaskMessage = Extract<ServerMessage, { type: 'get_task' }>;
export type GetArtifactMessage = Extract<ServerMessage, { type: 'get_artifact' }>;
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
  /** 本机权限策略（1.0，缺省 default；见 resolvePermissionPolicy） */
  permissionPolicy?: PermissionPolicyName;
  /** 本机是否声明 CodeBuddy full 运行在外部沙箱内 */
  externalSandbox?: boolean;
  /** 是否开放交互（1.0，缺省 false）：关闭时不发任何交互请求 */
  interactionEnabled?: boolean;
  /** 单次交互等待上限（毫秒）；适配器自带 expiresAt 时取二者较小值 */
  interactionTimeoutMs?: number;
  /** 单任务交互次数上限；超出的请求按失败处理，不无限回问 */
  maxInteractionsPerTask?: number;
  /** 附件 CAS 根目录（get_artifact 读内容用；缺省则只能回元数据） */
  artifactRootDir?: string;
  /** 持久 Session/Turn/Event 权威源 */
  store: SessionStore;
  /**
   * 持久授权账本（1.0）：缺省关闭。开启后人工的 persistent allow 才会落库，
   * 后续 default 模式下同指纹请求可自动命中。
   */
  approvalLedger?: {
    enabled: boolean;
    tenantId: string;
    ttlMs: number;
    /** 是否要求响应方具备 approval:persist 才允许落库（缺省 true，关掉只用于单测） */
    requirePersistScope?: boolean;
  };
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

/**
 * 一次交互响应处理的客观结果。
 *
 * 抽出来是因为同一条规则要服务两条通道：WS（`task_interaction_response`）只看「有没有回 result 帧」，
 * 而 HTTP（`POST /v1/interactions/{requestId}:respond`）必须能给出状态码。让判定函数返回结果，
 * 而不是让调用方回读 SQLite 猜 —— 回读在“鉴权失败”这类不落库的分支上会误判成 pending。
 */
export interface InteractionOutcome {
  ok: boolean;
  /** 结算后的状态（ok=true 时有效；幂等重放返回既有终态） */
  state?: 'accepted' | 'declined' | 'cancelled' | 'expired';
  responseId?: string;
  resultSeq?: number;
  /** ok=false 时的受控错误码，与 WS 的 `task_interaction_result.errorCode` 同源 */
  errorCode?: string;
}

export function dispatchInteractionResponse(
  msg: InteractionResponseMessage,
  o: TaskDispatchOptions,
): InteractionOutcome {
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
    return { ok: false, errorCode: 'interaction_not_found' };
  }
  if (interaction.state !== 'pending') {
    if (interaction.responseId === msg.responseId) {
      emitResult(interaction.state as 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed', {
        responseId: interaction.responseId,
        resultSeq: interaction.resultSeq,
        resultPayload: interaction.resultPayload as Record<string, unknown> | undefined,
      });
      // 幂等重放：同 responseId 再发一次 = 同一结果，不算错
      return {
        ok: true,
        state: interaction.state as 'accepted' | 'declined' | 'cancelled' | 'expired',
        responseId: interaction.responseId,
        resultSeq: interaction.resultSeq,
      };
    }
    emitResult('failed', { errorCode: 'interaction_already_resolved' });
    return { ok: false, errorCode: 'interaction_already_resolved' };
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
    return { ok: false, errorCode: 'interaction_expired', state: 'expired' as const };
  }

  const scope = interaction.kind === 'permission' ? 'task:approve' : 'task:respond';
  const gate = authorizeService(msg, 'task_interaction_response', msg.taskId, scope, o.requireServiceToken);
  if (!gate.ok) {
    emitResult('failed', { errorCode: gate.code });
    return { ok: false, errorCode: gate.code };
  }

  const payload = msg.payload ?? {};
  const content =
    typeof payload['content'] === 'object' && payload['content'] !== null
      ? (payload['content'] as Record<string, unknown>)
      : undefined;
  const action =
    msg.state === 'accepted' ? 'accept' : msg.state === 'declined' ? 'decline' : 'cancel';

  const interactionPayload =
    typeof interaction.payload === 'object' && interaction.payload !== null
      ? (interaction.payload as Record<string, unknown>)
      : {};
  if (interaction.kind === 'form' && msg.state === 'accepted') {
    const schema =
      typeof interactionPayload['requestedSchema'] === 'object' &&
      interactionPayload['requestedSchema'] !== null
        ? (interactionPayload['requestedSchema'] as Record<string, unknown>)
        : {};
    const invalid = validateFormContent(schema, content ?? {});
    if (invalid) {
      emitResult('failed', { errorCode: 'protocol_incompatible' });
      return { ok: false, errorCode: 'protocol_incompatible' };
    }
  }

  // Form content 只回送 ACP；落库/回传只保留动作与字段名，避免 secret 扩散。
  const storedPayload =
    interaction.kind === 'form'
      ? { action, fieldNames: Object.keys(content ?? {}) }
      : payload;

  const event = o.store.appendEvent({
    sessionId: msg.taskId,
    type: 'task_interaction_result',
    payload: {
      requestId: msg.requestId,
      responseId: msg.responseId,
      state: msg.state,
      resultPayload: storedPayload,
    },
  });
  const resolved = o.store.resolveInteraction({
    sessionId: msg.taskId,
    requestId: msg.requestId,
    state: msg.state,
    responseId: msg.responseId,
    resultSeq: event.eventSeq,
    resultPayload: storedPayload,
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

  // ---- 持久授权（1.0）：只有人工明确选了「持久允许」才落账本 ----
  // 写在 respondInteraction 之前，但任何失败都不影响本次响应：会话内的授权由 ACP 自己维持。
  if (msg.state === 'accepted' && interaction.kind === 'permission' && o.approvalLedger?.enabled) {
    const chosenKind = Array.isArray(requestOptions)
      ? requestOptions.find((option) => option['optionId'] === optionId)?.['kind']
      : undefined;
    if (typeof chosenKind === 'string' && (PERSISTENT_OPTION_KINDS as readonly string[]).includes(chosenKind)) {
      persistApproval(o, msg, interaction.payload as Record<string, unknown>, gate, chosenKind);
    }
  }

  o.tasks.get(msg.taskId)?.respondInteraction?.(msg.requestId, { optionId, action, content });
  emitResult(resolved.state as 'accepted' | 'declined' | 'cancelled', {
    responseId: resolved.responseId,
    resultSeq: resolved.resultSeq,
    resultPayload: storedPayload,
  });
  // 等待态必须显式收起：不带 interactionId 的 running 帧就是「不再等待」的语义。
  // 仅在任务仍活着时发 —— 终态后迟到的响应不应把已结算的任务拉回 running。
  if (o.tasks.get(msg.taskId)) {
    o.emitter.emit({
      type: 'task_status',
      taskId: msg.taskId,
      status: 'running',
      phase: 'running',
      turnId: interaction.turnId,
    });
  }
  return {
    ok: true,
    state: resolved.state as 'accepted' | 'declined' | 'cancelled',
    responseId: resolved.responseId,
    resultSeq: resolved.resultSeq,
  };
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
  // 两个游标语义相反，同时给只能猜一个 —— 宁可明确拒绝，也不静默挑一个
  if (msg.afterEventSeq !== undefined && msg.beforeEventSeq !== undefined) {
    o.emitter.emit({
      type: 'task_snapshot',
      taskId: msg.taskId,
      requestId: msg.requestId,
      found: false,
      errorCode: 'protocol_incompatible',
    });
    return;
  }
  // 会话不存在要分成两种：从没存在过 / 存在过但内容已删（tombstone）。后者永不复用该 ID，
  // 平台据 session_deleted 就该放弃重试，而不是拿 task_not_found 反复重发。
  if (!o.store.getSession(msg.taskId)) {
    const tombstone = o.store.getTombstone(msg.taskId);
    o.emitter.emit({
      type: 'task_snapshot',
      taskId: msg.taskId,
      requestId: msg.requestId,
      found: false,
      errorCode: tombstone ? 'session_deleted' : 'task_not_found',
    });
    return;
  }
  try {
    const snapshot = o.store.snapshot(msg.taskId, {
      ...(msg.afterEventSeq !== undefined ? { afterEventSeq: msg.afterEventSeq } : {}),
      ...(msg.beforeEventSeq !== undefined ? { beforeEventSeq: msg.beforeEventSeq } : {}),
      limit: msg.limit,
    });
    const prunedThrough = snapshot.prunedThrough ?? 0;
    // 游标落在已裁剪区间：内容确实取不回来了。found 仍为 true（任务在），
    // errorCode 表达的是「这次补取的完整性结论」，平台据此显示"更早的历史已清理"。
    const cursor =
      msg.beforeEventSeq !== undefined
        ? msg.beforeEventSeq
        : msg.afterEventSeq !== undefined
          ? msg.afterEventSeq
          : undefined;
    const pruned = cursor !== undefined && cursor < prunedThrough;
    o.emitter.emit({
      type: 'task_snapshot',
      taskId: msg.taskId,
      requestId: msg.requestId,
      found: true,
      ...(pruned ? { errorCode: 'session_history_pruned' } : {}),
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
      hasMoreBefore: snapshot.hasMoreBefore ?? false,
      ...(prunedThrough > 0 ? { prunedThrough } : {}),
      // 缺口必须一起给：平台拿到连续的 [oldest, latest] 不代表中间没丢
      eventWindow: {
        oldestEventSeq: snapshot.oldestEventSeq,
        latestEventSeq: snapshot.latestEventSeq,
        gaps: o.store.eventGaps(msg.taskId, snapshot.session.tenantId),
      },
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

/**
 * `get_artifact`：按 artifactId 从持久元数据 + CAS 取回内容（1.0）。
 *
 * 为什么不能顺手把内容塞进 task_artifact：那是**事件**，重放会重复传输；
 * 而这里是平台主动补取（终态后仍可用）。超过内联上限只回元数据 + `too_large`，
 * 让平台走 artifact_download 分块通道 —— 大块 base64 会拖垮 WS 心跳。
 * 也**不重读工作区**：避免 TOCTOU 与内容漂移，只认已落盘的那份。
 */
export function dispatchGetArtifact(msg: GetArtifactMessage, o: TaskDispatchOptions): void {
  const deny = (errorCode: string): void => {
    o.emitter.emit({
      type: 'artifact_content',
      taskId: msg.taskId,
      artifactId: msg.artifactId,
      requestId: msg.requestId,
      found: false,
      errorCode,
    });
  };
  // 读产物与 get_task 同权（都是读该任务的结果面）
  const gate = authorizeService(msg, 'get_artifact', msg.taskId, 'task:read', o.requireServiceToken);
  if (!gate.ok) {
    deny(gate.code);
    return;
  }
  const session = o.store.getSession(msg.taskId);
  const record = o.store.getArtifact(msg.artifactId, session?.tenantId);
  // 必须同时校验归属：拿 A 任务的 id 读 B 任务的附件属于越权，不是「找不到」
  if (!record || record.sessionId !== msg.taskId) {
    deny('artifact_not_found');
    return;
  }
  const meta = {
    type: 'artifact_content' as const,
    taskId: msg.taskId,
    artifactId: record.artifactId,
    requestId: msg.requestId,
    found: true,
    name: record.name,
    mimeType: record.mimeType,
    size: record.size,
    sha256: record.sha256,
    kind: record.kind,
  };
  if (record.size > ARTIFACT_INLINE_MAX_BYTES) {
    o.emitter.emit({ ...meta, contentUnavailableReason: 'too_large' });
    return;
  }
  try {
    if (!o.artifactRootDir) throw new Error('未配置附件根目录');
    const data = readFileSync(join(o.artifactRootDir, record.storageKey));
    o.emitter.emit({ ...meta, data: data.toString('base64') });
  } catch (error) {
    // 元数据还在但 CAS 文件已回收：如实回 not_readable，不伪造成「任务不存在」
    o.emitter.emit({ ...meta, contentUnavailableReason: 'not_readable' });
    o.log('error', `[agent-bridge] 读取附件失败 ${record.artifactId}：${(error as Error).message}`);
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

  // 交互额度（1.0）：按任务计数，不是全局 —— 一个任务问爆了不该拖累别的任务
  const maxInteractions = o.maxInteractionsPerTask ?? 16;
  const interactionBudgetMs = o.interactionTimeoutMs ?? 15 * 60 * 1000;
  let interactionCount = 0;
  /** 本任务实际采用的权限模式（由调度器决策后回传，用于交互帧与终态一致回显） */
  let permissionModeForEcho: PermissionMode | undefined;
  /** 交互过期时刻：适配器给了 expiresAt 就取较小值，绝不让单次等待超过本机上限 */
  const interactionDeadline = (requested?: string): string => {
    const cap = Date.now() + interactionBudgetMs;
    const asked = requested ? Date.parse(requested) : NaN;
    return new Date(Number.isFinite(asked) ? Math.min(asked, cap) : cap).toISOString();
  };

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
      // 权限模式（1.0）：平台请求 + 本机策略设备，实际模式由 TaskSupervisor 在 spawn 前定判
      permissionMode: msg.permissionMode,
      permissionPolicy: o.permissionPolicy,
      externalSandbox: o.externalSandbox,
      interactive: msg.allowInteractive === true && o.interactionEnabled === true,
      acp: Boolean(msg.prompt) && canRunAcp(agentDefOf(msg.agentType)?.acp),
      acpSpec: agentDefOf(msg.agentType)?.acp,
      appServer: msg.agentType === 'codex' && Boolean(msg.prompt),
      claudeStream:
        Boolean(msg.prompt) &&
        msg.allowInteractive === true &&
        o.interactionEnabled === true &&
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
        // 本机关闭交互 / 超出单任务额度：**主动回拒绝**而不是静默丢弃 ——
        // 静默会让上游的 Promise 一直悬着，任务白等到总超时。
        const refuse = (why: string): void => {
          o.tasks.get(msg.taskId)?.respondInteraction?.(request.requestId, { action: 'decline' });
          o.log('info', `[agent-bridge] ${why}，已拒绝交互 ${request.kind}/${request.requestId}`);
        };
        if (o.interactionEnabled !== true) {
          refuse('交互已关闭');
          return;
        }
        interactionCount += 1;
        if (interactionCount > maxInteractions) {
          refuse(`交互次数超过上限 ${maxInteractions}`);
          return;
        }
        const expiresAt = interactionDeadline(request.expiresAt);
        try {
          o.store.requestInteraction({
            sessionId: msg.taskId,
            requestId: request.requestId,
            kind: request.kind,
            payload: request.payload,
            turnId: turn?.turnId,
            expiresAt,
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
                expiresAt,
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
            expiresAt,
            eventSeq,
          });
          // 等待态必须带上 interactionId：平台据此收起「等待中」，而不是等到下一帧才反应过来
          o.emitter.emit({
            type: 'task_status',
            taskId: msg.taskId,
            status: 'running',
            phase: 'waiting_interaction',
            interactionId: request.requestId,
            turnId: turn?.turnId,
            permissionMode: permissionModeForEcho,
            requestedBy: msg.requestedBy,
          });
        } catch (error) {
          o.log('error', `[agent-bridge] 创建交互失败 ${msg.taskId}：${(error as Error).message}`);
        }
      },
      onApprovalLookup: (input) => resolveApproval(o, input, msg.taskId),
      onStatus: (status, info) => {
        o.registry.updateStatus(msg.taskId, status, info);
        // 记下实际权限模式：交互帧与后续帧要保持一致，不能让平台看到两个不同的模式
        if (info?.permissionMode) permissionModeForEcho = info.permissionMode;
        // 权限判定审计（每个任务一条，终态时落）：只写策略名/模式/结果，不写 argv 与环境值
        if (terminalStatus(status)) {
          const deniedByPolicy =
            info?.errorCode === 'permission_policy_denied' || info?.errorCode === 'permission_mode_unsupported';
          writeAudit({
            at: new Date().toISOString(),
            action: 'permission_decision',
            outcome: deniedByPolicy ? 'denied' : 'allowed',
            taskId: msg.taskId,
            agent: msg.agentType,
            requestedBy: msg.requestedBy,
            purpose: msg.purpose,
            policy: o.permissionPolicy ?? 'default',
            permissionMode: info?.permissionMode,
            reason: deniedByPolicy ? info?.error : undefined,
          });
        }
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
              permissionMode: info?.permissionMode,
              stopReason: info?.stopReason,
              feedIncomplete: info?.feedIncomplete,
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
          permissionMode: info?.permissionMode,
          stopReason: info?.stopReason,
          feedIncomplete: info?.feedIncomplete,
          turnId: turn?.turnId,
          eventSeq,
        });
      },
    },
  );

  o.tasks.set(msg.taskId, handle);
  void handle.done.then(() => o.tasks.delete(msg.taskId));
}

/**
 * 把一次人工「持久允许」写进账本（1.0 approval ledger）。
 *
 * 三条保险，任一不满足就只留审计、不落库：
 *  1. 本机开了账本（`approval_ledger_enabled`）—— 调用方已判；
 *  2. 响应方通过 `task:approve` 且**额外**具备 `approval:persist` —— 授权别人的未来任务比批一次更重；
 *  3. 能定位到 agent 与资源 —— 定位不了就不猜（不按 title/模型文本造授权）。
 *
 * ⚠️ 落库失败也绝不抛：本次响应已经发出，会话内授权由 ACP 自己维持。
 */
function persistApproval(
  o: TaskDispatchOptions,
  msg: InteractionResponseMessage,
  requestPayload: Record<string, unknown>,
  gate: { scopes?: string[] },
  optionKind: string,
): void {
  const ledger = o.approvalLedger;
  if (!ledger) return;
  const at = new Date().toISOString();
  const session = o.store.getSession(msg.taskId, undefined);
  const agentType = session?.agentType;
  if (!agentType) {
    o.log('warn', `[ledger] 无法确定 ${msg.taskId} 的 agent，跳过持久授权`);
    return;
  }
  let persistScope: ScopeCheck;
  if (ledger.requirePersistScope === false) {
    persistScope = { ok: true, scopes: gate.scopes };
  } else if (gate.scopes === undefined) {
    // 没有令牌 = 未鉴权：兼容模式（require_service_token=false）下不落库，只提示
    persistScope = { ok: false, scopes: [], reason: 'no_service_token' };
  } else if (!gate.scopes.includes('approval:persist')) {
    persistScope = { ok: false, scopes: gate.scopes, reason: 'missing_scope:approval:persist' };
  } else {
    persistScope = { ok: true, scopes: gate.scopes };
  }
  if (!persistScope.ok) {
    writeAudit({
      at,
      action: 'approval_grant',
      outcome: 'denied',
      taskId: msg.taskId,
      agent: agentType,
      cwd: session?.cwd,
      requestedBy: msg.respondedBy,
      scopes: persistScope.scopes,
      reason: persistScope.reason,
    });
    o.log('warn', `[ledger] 不落库（${persistScope.reason}）：本次授权仅在当前会话内有效`);
    return;
  }

  const target = permissionTarget(requestPayload['toolCall'], session?.cwd);
  // 同上：没有资源就不落库。写一条「通用授权」等于给该工具开永久后门。
  if (target.resourceKey === '-') {
    writeAudit({
      at,
      action: 'approval_grant',
      outcome: 'denied',
      taskId: msg.taskId,
      agent: agentType,
      cwd: session?.cwd,
      requestedBy: msg.respondedBy,
      reason: 'no_resource_to_bind',
    });
    o.log('warn', '[ledger] 该请求没有可绑定的资源，不写入持久授权（仅在当前会话有效）');
    return;
  }
  const fingerprint = approvalFingerprint({ agentType, tool: target.tool, resourceKey: target.resourceKey });
  const approvalId = `ap_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  try {
    o.store.addApproval({
      tenantId: ledger.tenantId,
      approvalId,
      principalId: msg.respondedBy ?? 'local',
      agentType,
      tool: target.tool,
      action: 'permission',
      resource: target.display,
      scope: optionKind,
      fingerprint,
      expiresAt: approvalExpiry(Date.now(), ledger.ttlMs),
      createdAt: at,
    });
    writeAudit({
      at,
      action: 'approval_grant',
      outcome: 'allowed',
      taskId: msg.taskId,
      agent: agentType,
      cwd: session?.cwd,
      requestedBy: msg.respondedBy,
      scopes: persistScope.scopes,
      approvalId,
      reason: `tool=${target.tool} resource=${target.display} expires=${approvalExpiry(Date.now(), ledger.ttlMs)}`,
    });
    o.log('info', `[ledger] 已记住授权 ${approvalId}（tool=${target.tool}），可用 approvals revoke 撤销`);
  } catch (error) {
    writeAudit({
      at,
      action: 'approval_grant',
      outcome: 'error',
      taskId: msg.taskId,
      agent: agentType,
      requestedBy: msg.respondedBy,
      reason: (error as Error).message,
    });
    o.log('error', `[ledger] 持久授权写入失败：${(error as Error).message}`);
  }
}

interface ScopeCheck {
  ok: boolean;
  scopes?: string[];
  reason?: string;
}

/**
 * 查询持久授权（1.0）：命中就返回**请求里真实存在**的 optionId。
 *
 * 独立成函数而非内联在 hooks 里，是因为「命中判定」是安全边界，必须能被单测直接打到。
 * 判定规则全在 `canAutoApprove()`；这里只负责取指纹、找记录、写审计。
 */
export function resolveApproval(
  o: TaskDispatchOptions,
  input: ApprovalLookupInput,
  taskId: string,
): ApprovalLookupResult | undefined {
  const ledger = o.approvalLedger;
  // 账本未开启时既没有记录也不该查（等价于从未授过权）
  if (ledger?.enabled !== true) return undefined;
  const target = permissionTarget(input.toolCall, input.cwd);
  // 没有可归一化的资源时一律不自动批准：否则所有「无资源」请求会共享同一个指纹，
  // 等于批准一次就永久放开该工具的全部调用 —— 这比不给账本更危险。
  if (target.resourceKey === '-') {
    o.log('info', '[ledger] 请求没有可归一化的资源，不自动批准（继续询问）');
    return undefined;
  }
  const fingerprint = approvalFingerprint({
    agentType: input.agentType,
    tool: target.tool,
    resourceKey: target.resourceKey,
  });
  const record = o.store.findApproval(ledger.tenantId, input.agentType, fingerprint);
  const option = persistentAllowOption(input.options);
  const verdict = canAutoApprove(record, {
    fingerprint,
    permissionMode: input.permissionMode,
    hasPersistentOption: option !== undefined,
  });
  if (!verdict.ok) {
    // 未命中是常态，不留审计噪声；只有"本来有记录却用不上"才值得记一行
    if (record && verdict.reason !== 'no_persistent_option') {
      o.log('info', `[ledger] 未自动批准：${verdict.reason}`);
    }
    return undefined;
  }
  writeAudit({
    at: new Date().toISOString(),
    action: 'approval_hit',
    outcome: 'allowed',
    taskId,
    agent: input.agentType,
    cwd: input.cwd,
    approvalId: record?.approvalId,
    reason: `tool=${target.tool} resource=${target.display}`,
    permissionMode: input.permissionMode,
  });
  if (!option) return undefined;
  return { optionId: option.optionId, approvalId: record?.approvalId ?? '' };
}

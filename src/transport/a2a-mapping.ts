/**
 * A2A（Agent2Agent）映射层 —— 纯函数，无 IO（tasks 1.1 / 1.2 / 1.4）
 *
 * 职责：把 bridge 内部任务状态/消息/附件翻译成 A2A wire 对象。
 * 边界：
 *  - 本文件**不定义** bridge 平台 wire 类型（那是 `src/protocol.ts` 的独占职责）；
 *    这里只定义 A2A 侧的外部协议类型，名字全部带 `A2a` 前缀以示区分。
 *  - `task_log` 只作为调试扩展放进 `Task.metadata`，不冒充标准 `Message`/`Artifact`
 *    （proposal 明确要求，平台/UI 不得把日志流当稳定协议解析）。
 *  - 版本协商：A2A v1.0（2026-03）与 0.3 两个拼写家族并存——方法名 PascalCase vs
 *    `message/send` 小写、状态 `TASK_STATE_*` vs 连字符、part 判别字段 `kind` vs `type`。
 *    输出按请求的 `A2A-Version` 头选择拼写；输入两种都接受（宽松解析）。
 */

import type { TaskPhase, TaskStatus } from '../protocol.js';
import type { ArtifactRecord, SessionEvent, SessionPhase, SessionRecord } from '../core/session-store.js';

/** A2A v1.0 状态拼写（8 态；v1.0 规范值域） */
export type A2aTaskState =
  | 'TASK_STATE_SUBMITTED'
  | 'TASK_STATE_WORKING'
  | 'TASK_STATE_INPUT_REQUIRED'
  | 'TASK_STATE_AUTH_REQUIRED'
  | 'TASK_STATE_COMPLETED'
  | 'TASK_STATE_FAILED'
  | 'TASK_STATE_CANCELED'
  | 'TASK_STATE_REJECTED';

/** A2A 0.3 状态拼写（连字符小写） */
export type A2aTaskStateV03 =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'unknown';

/** 网关协商出的 A2A wire 版本（`unsupported` = 版本头不认识，调用方回 -32009） */
export type A2aWireVersion = '0.3' | '1.0';

/** 状态的版本相关拼写：同一语义，两个家族 */
export interface A2aEmitStyle {
  /** TaskState 拼写（v1.0: TASK_STATE_WORKING；0.3: working） */
  state: (s: A2aTaskState) => string;
  /** Task 对象是否带 `kind: 'task'` 判别字段（0.3 有，v1.0 移除） */
  taskKindDiscriminator: boolean;
  /** Part 判别字段名（v1.0: kind；0.3: type） */
  partDiscriminator: 'kind' | 'type';
  /** Message.role 拼写（v1.0: ROLE_USER；0.3: user） */
  role: (r: 'user' | 'agent') => string;
}

export const A2A_STYLE_V1: A2aEmitStyle = {
  state: (s) => s,
  taskKindDiscriminator: false,
  partDiscriminator: 'kind',
  role: (r) => (r === 'user' ? 'ROLE_USER' : 'ROLE_AGENT'),
};

export const A2A_STYLE_V03: A2aEmitStyle = {
  // 0.3 家族没有 auth-required 的稳定拼写：语义映射成 unknown，不编造规范值
  state: (s) =>
    s === 'TASK_STATE_AUTH_REQUIRED'
      ? 'unknown'
      : (s
          .slice('TASK_STATE_'.length)
          .toLowerCase()
          .replace('_', '-') as A2aTaskStateV03),
  taskKindDiscriminator: true,
  partDiscriminator: 'type',
  role: (r) => r,
};

/**
 * 版本协商：空/缺省按 0.3（规范规定）；`1.0`/`1.0.x` 按 1.0；其余（含 2.0、`0.2`）不支持。
 * 只看 Major.Minor，patch 不参与协商。
 */
export function negotiateA2aVersion(header: string | undefined): A2aWireVersion | 'unsupported' {
  const raw = header?.trim();
  if (!raw) return '0.3';
  const m = /^(\d+)\.(\d+)(?:\.|$)/.exec(raw);
  if (!m) return 'unsupported';
  const major = m[1] ?? '0';
  const minor = m[2] ?? '3';
  if (major === '0' && minor === '3') return '0.3';
  if (major === '1' && minor === '0') return '1.0';
  return 'unsupported';
}

export function a2aEmitStyleFor(version: A2aWireVersion): A2aEmitStyle {
  return version === '1.0' ? A2A_STYLE_V1 : A2A_STYLE_V03;
}

/**
 * TaskStatus（+phase）→ A2A TaskState。
 *
 * | bridge | A2A |
 * | --- | --- |
 * | running + phase=queued | SUBMITTED |
 * | running + phase=running | WORKING |
 * | running + waiting_interaction / waiting_user | INPUT_REQUIRED |
 * | success | COMPLETED |
 * | failed | FAILED |
 * | timeout | FAILED（A2A 无超时态；bridge 原因放 Task.metadata） |
 * | cancelled | CANCELED |
 */
export function toA2aTaskState(
  status: TaskStatus,
  phase?: TaskPhase | SessionPhase,
): A2aTaskState {
  if (status !== 'running') {
    switch (status) {
      case 'success':
        return 'TASK_STATE_COMPLETED';
      case 'failed':
        return 'TASK_STATE_FAILED';
      case 'timeout':
        return 'TASK_STATE_FAILED';
      case 'cancelled':
        return 'TASK_STATE_CANCELED';
    }
  }
  if (phase === 'queued') return 'TASK_STATE_SUBMITTED';
  if (phase === 'waiting_interaction' || phase === 'waiting_user') return 'TASK_STATE_INPUT_REQUIRED';
  return 'TASK_STATE_WORKING';
}

/** A2A 任务终态判定（终态任务不接受新消息/取消，网关按此回 TaskNotCancelableError） */
export function isA2aTerminalState(state: A2aTaskState): boolean {
  return (
    state === 'TASK_STATE_COMPLETED' ||
    state === 'TASK_STATE_FAILED' ||
    state === 'TASK_STATE_CANCELED' ||
    state === 'TASK_STATE_REJECTED'
  );
}

/** bridge 消息 role → A2A role（A2A 只有 user/agent 两方；system 归 agent 侧陈述） */
export function toA2aRole(role: 'user' | 'agent' | 'system'): 'user' | 'agent' {
  return role === 'user' ? 'user' : 'agent';
}

/** A2A 文本 Part（text/plain） */
export interface A2aTextPart {
  kind?: string;
  type?: string;
  text: string;
  mimeType?: string;
}

/** A2A 消息（一轮对话） */
export interface A2aMessage {
  role: string;
  parts: A2aTextPart[];
  messageId: string;
  taskId?: string;
  contextId?: string;
}

/** A2A 附件（产物） */
export interface A2aArtifact {
  artifactId: string;
  name?: string;
  description?: string;
  parts: Record<string, unknown>[];
  metadata?: Record<string, unknown>;
}

/** A2A Task Status 对象 */
export interface A2aTaskStatus {
  state: string;
  message?: A2aMessage;
  timestamp?: string;
}

/** A2A Task（工作单元） */
export interface A2aTask {
  id: string;
  contextId: string;
  status: A2aTaskStatus;
  artifacts?: A2aArtifact[];
  history?: A2aMessage[];
  metadata?: Record<string, unknown>;
  kind?: 'task';
}

/** task_message 事件 payload 的最小读取面（宽松解析，未知字段忽略） */
interface MessageEventPayload {
  messageId?: unknown;
  role?: unknown;
  state?: unknown;
  text?: unknown;
}

/**
 * bridge `task_message` 事件 → A2A `Message`。
 * 只映射 `state: 'complete'` 的消息：delta 是流式增量，不是协议消息
 * （bridge 侧同样不发 `task_message.state='delta'` 到快照）。
 */
export function toA2aMessageFromEvent(
  taskId: string,
  ev: SessionEvent,
  style: A2aEmitStyle,
): A2aMessage | undefined {
  if (ev.type !== 'task_message') return undefined;
  const p = (ev.payload ?? {}) as MessageEventPayload;
  const messageId = typeof p.messageId === 'string' ? p.messageId : `msg_${ev.eventSeq}`;
  if (p.state !== 'complete') return undefined;
  const text = typeof p.text === 'string' ? p.text : '';
  const role = p.role === 'user' ? 'user' : 'agent';
  return {
    role: style.role(role),
    parts: [{ [style.partDiscriminator]: 'text', text, ...(style.partDiscriminator === 'kind' ? { mimeType: 'text/plain' } : {}) } as A2aTextPart],
    messageId,
    taskId,
  };
}

/**
 * bridge `task_artifact` 记录 → A2A `Artifact`。
 * 不内联文件内容：part 是一个指向控制面附件下载端点的 file part（URI 引用），
 * sha256/size 放 metadata，调用方自行带 token 去取。
 */
export function toA2aArtifact(
  artifact: ArtifactRecord,
  style: A2aEmitStyle,
  artifactUrl: string,
): A2aArtifact {
  const filePart: Record<string, unknown> = {
    [style.partDiscriminator]: 'file',
    file: {
      uri: artifactUrl,
      mimeType: artifact.mimeType || 'application/octet-stream',
      name: artifact.name,
    },
  };
  return {
    artifactId: artifact.artifactId,
    name: artifact.name,
    parts: [filePart],
    metadata: {
      size: artifact.size,
      sha256: artifact.sha256,
      kind: artifact.kind,
    },
  };
}

/**
 * 从 SessionSnapshot 组装 A2A Task（`tasks/get` 的 result）。
 *
 * - `history`：`task_message` complete 消息按 eventSeq 顺序；
 * - `artifacts`：store 里的已提交附件（A2A file part 指向 `/v1/sessions/{id}/artifacts/{aid}`）；
 * - `metadata.bridge`：bridge 侧调试扩展（agentType/exitCode/errorCode/timeout 归因，
 *   以及 `task_log` 的取回端点——日志**不**进 history/artifacts，只给指引）。
 */
export function toA2aTask(
  input: {
    session: SessionRecord;
    events: SessionEvent[];
    artifacts: ArtifactRecord[];
    style: A2aEmitStyle;
    /** 控制面基地址（含 scheme+host+port，不含尾斜杠），用于附件 URI */
    baseUrl: string;
  },
): A2aTask {
  const { session, events, artifacts, style, baseUrl } = input;
  const state = toA2aTaskState(session.status, session.phase);
  const history = events
    .map((ev) => toA2aMessageFromEvent(session.sessionId, ev, style))
    .filter((m): m is A2aMessage => m !== undefined);
  const task: A2aTask = {
    id: session.sessionId,
    contextId: session.contextId,
    status: {
      state: style.state(state),
      timestamp: session.updatedAt,
    },
    ...(artifacts.length
      ? {
          artifacts: artifacts.map((a) =>
            toA2aArtifact(a, style, `${baseUrl}/v1/sessions/${encodeURIComponent(session.sessionId)}/artifacts/${encodeURIComponent(a.artifactId)}`),
          ),
        }
      : {}),
    ...(history.length ? { history } : {}),
    metadata: {
      bridge: {
        agentType: session.agentType,
        mode: session.mode,
        permissionMode: session.permissionMode,
        // 超时在 A2A 侧是 FAILED；真实归因放这里，避免平台只能猜
        statusDetail:
          session.status === 'timeout' ? 'bridge:timeout' : session.status === 'failed' ? 'bridge:failed' : undefined,
        closedAt: session.closedAt,
        // task_log 只作为调试扩展：给端点指引，不冒充 Message/Artifact
        taskLogEndpoint: `${baseUrl}/v1/tasks/${encodeURIComponent(session.sessionId)}/events`,
      },
    },
  };
  if (style.taskKindDiscriminator) task.kind = 'task';
  return task;
}

/**
 * JSON-RPC 错误码（A2A 规范自 -32001 起；标准 JSON-RPC 码复用 -32xxx 之外的部分）。
 * bridge 的受控错误码体系不动——网关把鉴权/scope 失败映射到 JSON-RPC error 对象。
 */
export const A2A_JSONRPC_ERRORS = {
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  versionNotSupported: -32009,
  /** JSON-RPC 2.0 标准：非法请求 */
  invalidRequest: -32600,
  /** JSON-RPC 2.0 标准：方法不存在 */
  methodNotFound: -32601,
  /** JSON-RPC 2.0 标准：参数非法 */
  invalidParams: -32602,
  /** JSON-RPC 2.0 标准：JSON 解析失败 */
  parseError: -32700,
} as const;

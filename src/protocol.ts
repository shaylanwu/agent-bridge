/**
 * Wire protocol between the bridge and the orchestration platform.
 *
 * The bridge is an external client: it does not import platform code, it only relies on this JSON
 * contract plus runtime validation (`assertServerMessage`) so the two sides cannot drift silently.
 *
 * Direction: bridge → platform uses `ClientMessage`; platform → bridge uses `ServerMessage`.
 */

export const PROTOCOL_VERSION = 1;

/**
 * 能力协商清单（hello.capabilities）
 *
 * 平台（可能是任意第三方系统）据此判断本机支持哪些**可选**能力，而不是靠 CLI 版本号猜。
 * 规则：新增能力 = 加一个字符串 + 保持 PROTOCOL_VERSION 不变；语义变更/必填字段才 +1。
 */
export const PROTOCOL_CAPABILITIES = [
  'diff',
  'service-token',
  'queue',
  'scan-progress',
  'cloud-events',
  'capacity',
  'task-step',
  'task-message',
  'task-snapshot',
  'session-control',
  'session-multi-turn',
  'task-interaction',
] as const;

/** 平台下发的字符串字段长度上限（防畸形报文，也防日志/审计被撑爆） */
const MAX_META_LEN = 128;
const MAX_PURPOSE_LEN = 64;
const MAX_TOKEN_LEN = 256;

/** 取字符串字段：类型不对或超长一律忽略（前向兼容，不因为新字段拒帧） */
function strField(msg: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = msg[key];
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 && t.length <= max ? t : undefined;
}

/** 单个 AI 编码 CLI 的安装/凭据状态（对应平台工具卡片的三个标签） */
export type AgentStatus = 'not_installed' | 'installed_no_cred' | 'ready';

export type AgentCapability = 'non_interactive' | 'interactive_only';

export interface AgentListItem {
  kind: string;
  display: string;
  version?: string;
  status: AgentStatus;
  /** 命中的可执行文件路径（便于排查，不含任何密钥） */
  path?: string;
  /** 凭据来源：`env:NAME` / `file:~/.codex/auth.json` / `platform`（后者由平台侧合并） */
  credentialSource?: string;
  capability: AgentCapability;
  /** 找到二进制但执行失败（exit≠0 / 超时），典型是 Node 版本不兼容 */
  installedButBroken?: boolean;
  /** 品牌图标：`data:image/svg+xml;base64,…`（24×24 单色）；资产缺失时省略。平台应按 kind 缓存 */
  logo?: string;
  /** 是否支持步骤流（task_step）：纯文本输出的工具为 false，平台应隐藏其步骤面板而不是空转 */
  steps?: boolean;
}

export type ClientMessage =
  | {
      type: 'hello';
      protocolVersion: number;
      deviceId: string;
      cliVersion: string;
      platform: string;
      hostname: string;
      /** 本机支持的可选能力（见 PROTOCOL_CAPABILITIES）；平台据此降级，而不是猜版本 */
      capabilities?: string[];
      /** 本次会话生效的调度额度：平台据此做有水位线的派发，而不是靠 device_busy 试错 */
      capacity?: { maxTasks: number; maxQueued: number };
    }
  | { type: 'agent_list'; agents: AgentListItem[]; scannedAt: string }
  | {
      /** 扫描过程中的增量回传：每完成一个适配器发一条，`done: true` 表示探测阶段结束 */
      type: 'scan_progress';
      requestId?: string;
      items: AgentListItem[];
      scannedAt: string;
      done: boolean;
    }
  | {
      type: 'task_status';
      taskId: string;
      status: TaskStatus;
      exitCode?: number;
      error?: string;
      /** 机器可读错误码（见 src/core/errors 的受控枚举；人类可读串仍在 error） */
      errorCode?: string;
      /** 任务结束时 cwd 下的 unified diff（仅 captureDiff 启用时有值） */
      diff?: string;
      /** 变更文件清单（仓库相对路径） */
      changedFiles?: string[];
      /** diff 是否因超过 diff_max_bytes 被截断 */
      diffTruncated?: boolean;
      /** 终态最终回答文本（步骤流工具从 result 事件提取；≤16KB） */
      result?: string;
      /** 回显本次调用的服务身份，供平台落 requested_by 审计 */
      requestedBy?: string;
      /**
       * 排队/等待语义：`status` 恒为 `running`，phase 区分 queued/running/waiting_*。
       * 新增 waiting_* 只作为可选字段值；平台不认识时应继续按 running 展示。
       */
      phase?: TaskPhase;
      /** 队列中的位次（从 1 开始），仅在 `phase: 'queued'` 时出现 */
      queuePosition?: number;
      /** 当前 Turn（1.0 会话模型）；老的一次性任务可省略 */
      turnId?: string;
      /** 持久事件序号：平台按它去重/补洞 */
      eventSeq?: number;
    }
  | {
      type: 'task_log';
      taskId: string;
      stream: 'stdout' | 'stderr';
      data: string;
      isAnsi: boolean;
      turnId?: string;
      eventSeq?: number;
    }
  | {
      /**
       * 动态步骤流（task-step 能力）：AI CLI 的步骤由模型实时决定，无预定义总步数。
       * `seq` 从 1 单调递增；`ref` 配对 started/finished（源事件的 tool_use_id / item.id）；
       * `label` ≤160 字符且与日志同口径脱敏；任务终态后该 task 的步骤一律丢弃（同 task_log）。
       */
      type: 'task_step';
      taskId: string;
      seq: number;
      /** 动作名：Bash / Edit / Read / command_execution / file_change…（依工具而定） */
      action: string;
      label?: string;
      state: 'started' | 'finished';
      /** state=finished 时给出成败 */
      ok?: boolean;
      ref?: string;
      /** ISO 时间戳 */
      at: string;
      turnId?: string;
      /** 持久事件序号；与 task_status 共用同一序列 */
      eventSeq?: number;
    }
  | {
      /**
       * canonical 会话消息（1.0）。
       * delta 是流式增量；complete 是最终完整文本。messageId 是平台幂等键。
       */
      type: 'task_message';
      taskId: string;
      messageId: string;
      role: 'user' | 'agent' | 'system';
      state: 'delta' | 'complete';
      text: string;
      turnId?: string;
      eventSeq?: number;
      at: string;
    }
  | {
      /** 历史快照：响应 get_task；终态后仍可补取 */
      type: 'task_snapshot';
      taskId: string;
      requestId?: string;
      found: boolean;
      session?: Record<string, unknown>;
      turns?: Record<string, unknown>[];
      events?: { eventSeq: number; type: string; payload: unknown; createdAt: string }[];
      oldestEventSeq?: number;
      latestEventSeq?: number;
      errorCode?: string;
    }
  | {
      /** 会话控制回执：close_session / cancel_turn 的幂等结果 */
      type: 'session_ack';
      taskId: string;
      operationId: string;
      action: 'close_session' | 'cancel_turn';
      ok: boolean;
      status?: string;
      errorCode?: string;
      at: string;
    }
  | {
      /** 权限 / Form / URL 交互请求（bridge → 平台） */
      type: 'task_interaction_request';
      taskId: string;
      requestId: string;
      turnId?: string;
      kind: 'permission' | 'form' | 'auth-url';
      payload: Record<string, unknown>;
      expiresAt?: string;
      eventSeq?: number;
    }
  | {
      /** 交互回复结果（bridge → 平台） */
      type: 'task_interaction_result';
      taskId: string;
      requestId: string;
      state: 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';
      responseId?: string;
      resultSeq?: number;
      resultPayload?: Record<string, unknown>;
      errorCode?: string;
      eventSeq?: number;
    }
  | {
      /** send_message 的幂等回执 */
      type: 'message_ack';
      taskId: string;
      messageId: string;
      turnId?: string;
      eventSeq?: number;
      delivery: 'queued' | 'duplicate' | 'rejected';
      errorCode?: string;
      at: string;
    }
  | {
      /**
       * 容量水位：每次调度状态变化（入队/启动/终态）后发送一次，
       * 反映平台与控制面两条通道的**合计**占用（它们共用同一调度器）。
       */
      type: 'capacity_update';
      running: number;
      queued: number;
      maxTasks: number;
      maxQueued: number;
    }
  | { type: 'pong'; at: number }
  | { type: 'scan_result'; requestId?: string; agents: AgentListItem[]; scannedAt: string };

export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';

/** 过程阶段：waiting_* 仍属于 running，不是终态 */
export type TaskPhase = 'queued' | 'running' | 'waiting_interaction' | 'waiting_user';

/**
 * 服务身份（P0-8）：任何第三方系统/后端服务都可以带一个 scoped service token 调进来。
 * `requestedBy` 是调用方标识（如 `svc:repair-orchestrator`），bridge 会回显到终态供平台审计。
 * 三个字段全部可选 —— 不带就完全等同 v1 行为（除本地显式开启 require_service_token）。
 */
export interface ServiceIdentity {
  /** 调用方/服务标识（≤128 字符） */
  requestedBy?: string;
  /** 业务意图，如 repair / test / free（≤64 字符） */
  purpose?: string;
  /** scoped 服务令牌（≤256 字符）；一旦携带，bridge 必须校验 */
  serviceToken?: string;
}

export interface RunTaskCommand extends ServiceIdentity {
  type: 'run_task';
  taskId: string;
  agentType: string;
  cwd: string;
  /** 传给 CLI 的参数（不含二进制本身）；平台可用 {{prompt}} 占位 */
  args: string[];
  prompt?: string;
  timeoutMs?: number;
  allowInteractive?: boolean;
  /** 任务终态时回传 cwd 下的 unified diff（P0-6） */
  captureDiff?: boolean;
  /** 1.0：缺省 task（一次性）；conversation 回合结束进入 waiting_user */
  sessionMode?: 'task' | 'conversation';
}

export interface MessagePart {
  kind: 'text';
  text: string;
}

export interface SendMessageCommand extends ServiceIdentity {
  type: 'send_message';
  taskId: string;
  messageId: string;
  /** queue = 新 Turn；steer 仅 adapter 声明且当前 Turn active */
  mode?: 'queue' | 'steer';
  parts: MessagePart[];
  /** 审计身份（可选） */
  respondedBy?: string;
}

export interface CancelTaskCommand extends ServiceIdentity {
  type: 'cancel_task';
  taskId: string;
}

export interface ScanCommand {
  type: 'scan';
  requestId?: string;
}

export interface PingCommand {
  type: 'ping';
  at?: number;
}

export interface CloseSessionCommand extends ServiceIdentity {
  type: 'close_session';
  taskId: string;
  /** 幂等键：同 operationId 重发返回同一结果 */
  operationId: string;
}

export interface CancelTurnCommand extends ServiceIdentity {
  type: 'cancel_turn';
  taskId: string;
  turnId: string;
  operationId: string;
}

export interface InteractionResponseCommand extends ServiceIdentity {
  type: 'task_interaction_response';
  taskId: string;
  requestId: string;
  responseId: string;
  state: 'accepted' | 'declined' | 'cancelled';
  payload?: Record<string, unknown>;
  respondedBy?: string;
}

export interface GetTaskCommand extends ServiceIdentity {
  type: 'get_task';
  taskId: string;
  /** 平台请求关联 id，原样回在 task_snapshot */
  requestId?: string;
  /** 只补取该序号之后的事件；缺省返回从最旧开始的有界窗口 */
  afterEventSeq?: number;
  limit?: number;
}

export type ServerMessage =
  | RunTaskCommand
  | CancelTaskCommand
  | ScanCommand
  | PingCommand
  | GetTaskCommand
  | CloseSessionCommand
  | CancelTurnCommand
  | SendMessageCommand
  | InteractionResponseCommand;

export class ProtocolError extends Error {}

/**
 * 运行时校验平台指令（不信任平台下发的任意结构）。
 * 只做形状校验；**指令白名单**（agentType / cwd）在 runner 里另行校验。
 */
export function assertServerMessage(raw: unknown): ServerMessage {
  if (!raw || typeof raw !== 'object') throw new ProtocolError('报文不是对象');
  const msg = raw as Record<string, unknown>;
  const type = msg['type'];
  if (type === 'run_task') {
    for (const key of ['taskId', 'agentType', 'cwd'] as const) {
      if (typeof msg[key] !== 'string' || !(msg[key] as string).length) {
        throw new ProtocolError(`run_task 缺少 ${key}`);
      }
    }
    if (!Array.isArray(msg['args']) || msg['args'].some((a) => typeof a !== 'string')) {
      throw new ProtocolError('run_task.args 必须是字符串数组');
    }
    return {
      type: 'run_task',
      taskId: String(msg['taskId']),
      agentType: String(msg['agentType']),
      cwd: String(msg['cwd']),
      args: msg['args'] as string[],
      prompt: typeof msg['prompt'] === 'string' ? msg['prompt'] : undefined,
      // 注意：平台**不得**下发 env（2026-10-22 移除）。这里刻意不透传，
      // 未知字段一律忽略 —— 子进程只用 bridge 自身进程的环境。
      timeoutMs: typeof msg['timeoutMs'] === 'number' ? msg['timeoutMs'] : undefined,
      allowInteractive: msg['allowInteractive'] === true,
      sessionMode: msg['sessionMode'] === 'conversation' ? 'conversation' : 'task',
      // P0-6：只有显式 true 才捕获 diff（本地 diff_default 可在 cli 层兜底）
      captureDiff: msg['captureDiff'] === true,
      // P0-8：服务身份三件套，形状不对就忽略（不因为新字段拒帧）
      requestedBy: strField(msg, 'requestedBy', MAX_META_LEN),
      purpose: strField(msg, 'purpose', MAX_PURPOSE_LEN),
      serviceToken: strField(msg, 'serviceToken', MAX_TOKEN_LEN),
    };
  }
  if (type === 'cancel_task') {
    if (typeof msg['taskId'] !== 'string') throw new ProtocolError('cancel_task 缺少 taskId');
    return {
      type: 'cancel_task',
      taskId: String(msg['taskId']),
      requestedBy: strField(msg, 'requestedBy', MAX_META_LEN),
      purpose: strField(msg, 'purpose', MAX_PURPOSE_LEN),
      serviceToken: strField(msg, 'serviceToken', MAX_TOKEN_LEN),
    };
  }
  if (type === 'scan') {
    return {
      type: 'scan',
      requestId: typeof msg['requestId'] === 'string' ? msg['requestId'] : undefined,
    };
  }
  if (type === 'ping') {
    return { type: 'ping', at: typeof msg['at'] === 'number' ? msg['at'] : undefined };
  }
  if (type === 'task_interaction_response') {
    for (const key of ['taskId', 'requestId', 'responseId'] as const) {
      if (typeof msg[key] !== 'string' || !msg[key]) {
        throw new ProtocolError(`task_interaction_response 缺少 ${key}`);
      }
    }
    const state = msg['state'];
    if (state !== 'accepted' && state !== 'declined' && state !== 'cancelled') {
      throw new ProtocolError('task_interaction_response.state 非法');
    }
    if (msg['payload'] !== undefined && (typeof msg['payload'] !== 'object' || msg['payload'] === null)) {
      throw new ProtocolError('task_interaction_response.payload 必须是对象');
    }
    return {
      type: 'task_interaction_response',
      taskId: String(msg['taskId']),
      requestId: String(msg['requestId']),
      responseId: String(msg['responseId']),
      state,
      payload: msg['payload'] as Record<string, unknown> | undefined,
      respondedBy: strField(msg, 'respondedBy', MAX_META_LEN),
      requestedBy: strField(msg, 'requestedBy', MAX_META_LEN),
      purpose: strField(msg, 'purpose', MAX_PURPOSE_LEN),
      serviceToken: strField(msg, 'serviceToken', MAX_TOKEN_LEN),
    };
  }
  if (type === 'send_message') {
    for (const key of ['taskId', 'messageId'] as const) {
      if (typeof msg[key] !== 'string' || !msg[key]) {
        throw new ProtocolError(`send_message 缺少 ${key}`);
      }
    }
    if (!Array.isArray(msg['parts']) || msg['parts'].length === 0) {
      throw new ProtocolError('send_message.parts 必须是非空数组');
    }
    const parts: MessagePart[] = [];
    for (const raw of msg['parts']) {
      if (!raw || typeof raw !== 'object') throw new ProtocolError('send_message part 非法');
      const part = raw as Record<string, unknown>;
      if (part['kind'] !== 'text' || typeof part['text'] !== 'string') {
        throw new ProtocolError('当前仅支持 text part');
      }
      parts.push({ kind: 'text', text: part['text'] });
    }
    return {
      type: 'send_message',
      taskId: String(msg['taskId']),
      messageId: String(msg['messageId']),
      mode: msg['mode'] === 'steer' ? 'steer' : 'queue',
      parts,
      respondedBy: strField(msg, 'respondedBy', MAX_META_LEN),
      requestedBy: strField(msg, 'requestedBy', MAX_META_LEN),
      purpose: strField(msg, 'purpose', MAX_PURPOSE_LEN),
      serviceToken: strField(msg, 'serviceToken', MAX_TOKEN_LEN),
    };
  }
  if (type === 'close_session') {
    if (typeof msg['taskId'] !== 'string' || !msg['taskId']) {
      throw new ProtocolError('close_session 缺少 taskId');
    }
    if (typeof msg['operationId'] !== 'string' || !msg['operationId']) {
      throw new ProtocolError('close_session 缺少 operationId');
    }
    return {
      type: 'close_session',
      taskId: String(msg['taskId']),
      operationId: String(msg['operationId']),
      requestedBy: strField(msg, 'requestedBy', MAX_META_LEN),
      purpose: strField(msg, 'purpose', MAX_PURPOSE_LEN),
      serviceToken: strField(msg, 'serviceToken', MAX_TOKEN_LEN),
    };
  }
  if (type === 'cancel_turn') {
    for (const key of ['taskId', 'turnId', 'operationId'] as const) {
      if (typeof msg[key] !== 'string' || !msg[key]) {
        throw new ProtocolError(`cancel_turn 缺少 ${key}`);
      }
    }
    return {
      type: 'cancel_turn',
      taskId: String(msg['taskId']),
      turnId: String(msg['turnId']),
      operationId: String(msg['operationId']),
      requestedBy: strField(msg, 'requestedBy', MAX_META_LEN),
      purpose: strField(msg, 'purpose', MAX_PURPOSE_LEN),
      serviceToken: strField(msg, 'serviceToken', MAX_TOKEN_LEN),
    };
  }
  if (type === 'get_task') {
    if (typeof msg['taskId'] !== 'string' || !msg['taskId']) {
      throw new ProtocolError('get_task 缺少 taskId');
    }
    const after =
      typeof msg['afterEventSeq'] === 'number' && Number.isFinite(msg['afterEventSeq'])
        ? Math.max(0, Math.floor(msg['afterEventSeq']))
        : undefined;
    const limit =
      typeof msg['limit'] === 'number' && Number.isFinite(msg['limit'])
        ? Math.min(1000, Math.max(1, Math.floor(msg['limit'])))
        : undefined;
    return {
      type: 'get_task',
      taskId: String(msg['taskId']),
      requestId: strField(msg, 'requestId', MAX_META_LEN),
      afterEventSeq: after,
      limit,
      requestedBy: strField(msg, 'requestedBy', MAX_META_LEN),
      purpose: strField(msg, 'purpose', MAX_PURPOSE_LEN),
      serviceToken: strField(msg, 'serviceToken', MAX_TOKEN_LEN),
    };
  }
  throw new ProtocolError(`未知指令类型: ${String(type)}`);
}

// ---------- CloudEvents 1.0 信封（可选，由 capabilities 协商） ----------

/**
 * 上行事件的 **CloudEvents 1.0** 信封（CNCF 标准）。
 *
 * 为什么提供：默认报文是扁平的自研结构，第三方要接必须读文档。给一条"标准信封"开关后，
 * 任何支持 CloudEvents 的事件系统（Kafka / Knative / 各类网关）可以直接消费，
 * 不必为 bridge 单独写解析器。
 *
 * 默认关闭（保持 v1 扁平报文）；平台在 `hello` 协商到 `cloud-events` 后请求启用。
 */
export const CLOUD_EVENTS_SPECVERSION = '1.0';

export interface CloudEvent<T = unknown> {
  specversion: '1.0';
  /** 事件唯一 id */
  id: string;
  /** 事件源，形如 `urn:agent-bridge:device:<deviceId>` */
  source: string;
  /** 事件类型，形如 `dev.agent-bridge.task_log.v1` */
  type: string;
  /** RFC 3339 时间戳 */
  time: string;
  datacontenttype?: 'application/json';
  /** 主体：任务场景恒为 taskId */
  subject?: string;
  /** 扩展属性：单调序号，便于平台检测空洞 */
  seq?: number;
  data: T;
}

/** 把一条上行报文包成 CloudEvents 1.0 信封（纯函数，便于单测） */
export function toCloudEvent(
  msg: ClientMessage,
  source: string,
  seq: number,
  at: Date = new Date(),
): CloudEvent {
  const type = `dev.agent-bridge.${msg.type}.v1`;
  const subject = 'taskId' in msg ? String(msg['taskId']) : undefined;
  return {
    specversion: CLOUD_EVENTS_SPECVERSION,
    id: `${seq}-${at.getTime()}`,
    source,
    type,
    time: at.toISOString(),
    datacontenttype: 'application/json',
    ...(subject ? { subject } : {}),
    seq,
    data: msg,
  };
}

/** 日志分片上限：平台侧按 4KB 收，避免单帧过大 */
export const LOG_CHUNK_BYTES = 4096;

/** 把一段输出切成 ≤4KB 的分片（按 UTF-8 字节切，且不切断多字节字符） */
export function chunkLog(data: string, maxBytes = LOG_CHUNK_BYTES): string[] {
  if (!data) return [];
  const out: string[] = [];
  let buf = '';
  for (const ch of data) {
    const next = buf + ch;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) {
      out.push(buf);
      buf = ch;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

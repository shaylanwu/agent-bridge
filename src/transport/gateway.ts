/**
 * A2A / ACP 网关处理器（proposal：add-a2a-acp-gateway）
 *
 * 定位：**适配层**——把外部 A2A / ACP 客户端接到现有
 * `TaskSupervisor / SessionStore / Emitter / TaskRegistry` 上，不复制调度、不复制持久化、
 * 不另开上行出口（所有事件仍只经 `Emitter.emit()`）。
 *
 * 安全模型（与 control-plane 同一套）：
 *  - 本模块**不监听端口**：`listen(` 只允许出现在 `control-plane.ts`（护栏红线），
 *    网关路由由 control-plane 的分发器挂载，天然继承回环绑定与纵深防御；
 *  - 默认关闭：`[gateway] enabled` 不配置时，control-plane 不挂这些路由（一律 404，不暴露存在性）；
 *  - 鉴权复用 `abs_` scoped token / JWT principal（`authorize` 由 control-plane 注入的绑定版本）；
 *  - 不返回 CORS 头；跨租户读取统一按「不存在」处理（A2A: TaskNotFoundError）。
 *
 * 版本协商：`A2A-Version` 请求头（空/缺省 = 0.3，规范规定；`1.0` = v1 拼写家族）。
 * 方法名同时接受 v1.0 PascalCase（`GetTask`）与 0.3 小写（`tasks/get`）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { SessionLog } from '../app/session-log.js';
import type { TaskRegistry } from '../app/task-registry.js';
import type { Emitter, Upstream } from '../core/emitter.js';
import type { SessionStore } from '../core/session-store.js';
import { DEFAULT_TENANT } from '../core/session-store.js';
import type { JwtPrincipal } from '../infra/jwt.js';
import type { ServiceScope } from '../infra/service-token.js';
import type { CancelTurnCommand, ClientMessage, InteractionResponseCommand, RunTaskCommand, SendMessageCommand, TaskStatus } from '../protocol.js';
import {
  A2A_JSONRPC_ERRORS,
  a2aEmitStyleFor,
  negotiateA2aVersion,
  toA2aTask,
  toA2aTaskState,
  type A2aTask,
  type A2aEmitStyle,
} from './a2a-mapping.js';
import {
  ACP_JSONRPC_ERRORS,
  acpMethodForInteractionKind,
  acpPromptToText,
  fromAcpElicitationResult,
  fromAcpPermissionOutcome,
  toAcpPermissionRequestParams,
  toAcpElicitationParams,
  toAcpUrlElicititationParams,
  type AcpgwElicitationParams,
  type AcpgwPermissionRequestParams,
} from './acp-gateway-mapping.js';

/** 注入的静态 agent 表（commands 层从适配器 AGENTS 表读出扁平列表，网关不依赖 adapters） */
export interface GatewayAgentInfo {
  /** 平台 agentType（= AGENTS.kind） */
  id: string;
  /** 显示名（= AGENTS.display） */
  name: string;
}

export interface GatewayDeps {
  store: SessionStore;
  registry: TaskRegistry;
  emitter: Emitter;
  version: string;
  log: SessionLog;
  /** 控制面基地址（scheme+host+port，无尾斜杠）——附件/日志端点引用用；惰性求值以支持端口自动分配 */
  baseUrl: () => string;
  /** 静态适配器表（skills 数据源；不触发 fresh 扫描，card 必须稳定快速） */
  agents: readonly GatewayAgentInfo[];
  /** 任务创建/取消编排（control-plane 注入，与 /v1/tasks 同一条路径） */
  ops: GatewayTaskOps;
  /**
   * 交互响应通道（ACP 网关用）：与 `POST /v1/interactions/{id}:respond` 同一条 dispatch 路径。
   * 缺省时 ACP 交互响应回 501（与 HTTP 通道同口径），而不是假装成功。
   */
  respondInteraction?: (msg: InteractionResponseCommand) => Promise<{
    ok: boolean;
    state?: string;
    responseId?: string;
    resultSeq?: number;
    errorCode?: string;
  }>;
  /**
   * conversation 编排（add-acp-session-memory）：ACP `session/prompt` 的多轮续接走这里。
   * 与 WS 通道同一份 dispatchOptions（鉴权/账本/residentSessions 单一真源）。
   * 缺省时 session/prompt 回 -32004（能力未接入），不降级为单发任务。
   */
  conversation?: GatewayConversationOps;
}

/** conversation 编排注入接口（BridgeSession.conversation 的形状） */
export interface GatewayConversationOps {
  /** 首轮：创建 conversation 会话并跑第一轮（run_task 语义） */
  run: (msg: RunTaskCommand) => void;
  /** 续轮：向已有会话追加一轮（send_message 语义；拒绝走 message_ack 上行） */
  message: (msg: SendMessageCommand) => Promise<void>;
  /** 取消指定 turn（cancel_turn 语义；operationId 幂等） */
  cancelTurn: (msg: CancelTurnCommand) => void;
}

/** control-plane 传进来的请求上下文（结构兼容其 RouteContext） */
export interface GatewayRequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
  principal?: JwtPrincipal;
  tenantId?: string;
}

/** 已绑定请求的鉴权函数（control-plane `authorize(ctx, scope)` 的 curry 版） */
export type GatewayAuthorize = (scope: ServiceScope | readonly ServiceScope[]) => boolean;

/**
 * 任务操作接口：由 control-plane 注入（`createTaskCore` / `cancelTaskCore`）。
 * 网关与 `POST /v1/tasks`、`:cancel` 走**同一条编排**——并发上限、权限策略、幂等、
 * 上行出口全部单一真源；网关层只做协议适配，绝不自己调 `startTask`。
 */
export interface GatewayTaskOps {
  /**
   * 创建并调度任务。`idempotencyKey` 是 A2A 的 `messageId`（重发同 messageId 得到同一 taskId）。
   * 抛错：`{code:'idempotency_conflict'}`（同 key 异参）；`startTask` 的受控拒绝（device_busy 等）。
   */
  createTask(input: {
    tenantId: string;
    agentType: string;
    cwd: string;
    prompt?: string;
    timeoutMs?: number;
    requestedBy?: string;
    idempotencyKey: string;
    idempotencyFingerprint: unknown;
  }): { taskId: string; replay: boolean };
  /** 取消语义与 `:cancel` 相同：见 control-plane `cancelTaskCore` 的四态返回 */
  cancelTask(id: string, tenantId: string): 'not_found' | 'terminal' | 'not_owned' | 'cancelled';
}

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 不返回 CORS 头（与 control-plane 同红线）
    'cache-control': 'no-store',
  });
  res.end(body);
};

/** JSON-RPC 成功响应 */
const rpcOk = (res: ServerResponse, id: unknown, result: unknown): void =>
  json(res, 200, { jsonrpc: '2.0', id, result });

/** JSON-RPC 错误响应（鉴权类失败已由 authorize 走 problem 响应终结，这里都是 200） */
const rpcErr = (
  res: ServerResponse,
  id: unknown,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void =>
  json(res, 200, {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data ? { data } : {}) },
  });

/** 统一的操作名（v1.0 / 0.3 两套拼写都归到这里） */
type A2aOperation = 'getTask' | 'sendMessage' | 'cancelTask' | 'subscribeToTask';

const A2A_METHODS: Record<string, A2aOperation> = {
  // v1.0 PascalCase
  GetTask: 'getTask',
  SendMessage: 'sendMessage',
  CancelTask: 'cancelTask',
  SubscribeToTask: 'subscribeToTask',
  // 0.3 小写
  'tasks/get': 'getTask',
  'message/send': 'sendMessage',
  'tasks/cancel': 'cancelTask',
  'tasks/resubscribe': 'subscribeToTask',
};

/** 全部四个操作已实现（SendMessage / CancelTask / SubscribeToTask 于第二批接入） */
const UNIMPLEMENTED: Record<A2aOperation, string | undefined> = {
  getTask: undefined,
  sendMessage: undefined,
  cancelTask: undefined,
  subscribeToTask: undefined,
};

export interface GatewayHandlers {
  /** `GET /.well-known/agent-card.json`（静态描述，免鉴权——与面板页壳同口径，不含任务数据） */
  agentCard: (ctx: GatewayRequestContext) => void;
  /** `POST /a2a`（JSON-RPC 2.0；逐方法鉴权） */
  a2a: (ctx: GatewayRequestContext, authorize: GatewayAuthorize) => void;
  /**
   * `POST /acp`（ACP v1 over HTTP，vendor-specific 承载：请求走 POST、
   * session/prompt 的下行通知与 agent→client 请求走 SSE 流）。
   */
  acp: (ctx: GatewayRequestContext, authorize: GatewayAuthorize) => void;
}

export function createGatewayHandlers(deps: GatewayDeps): GatewayHandlers {
  const baseUrl = (): string => deps.baseUrl();
  const buildAgentCard = (): Record<string, unknown> => ({
    name: 'agent-bridge',
    description:
      'A2A gateway surface of agent-bridge: routes tasks to locally installed AI coding CLIs (single outbound WebSocket to the platform; loopback gateway for external orchestrators).',
    version: deps.version,
    // v1.0 字段：preferredTransport + supportedInterfaces；0.3 客户端读 url/protocolVersion
    protocolVersion: '1.0',
    preferredTransport: 'JSONRPC',
    url: `${baseUrl()}/a2a`,
    capabilities: {
      // 真实能力声明（capability 真源原则：没实现的不写 true）
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: deps.agents.map((a) => ({
      id: a.id,
      name: a.name,
      tags: ['coding-agent', a.id],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
    })),
    supportedInterfaces: [
      {
        url: `${baseUrl()}/a2a`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
  });

  const handleAgentCard = (ctx: GatewayRequestContext): void => {
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') {
      json(ctx.res, 405, { error: 'method not allowed' });
      return;
    }
    json(ctx.res, 200, buildAgentCard());
  };


  /**
   * `tasks/get`：SQLite 快照 → A2A Task。
   * 跨租户/不存在统一 TaskNotFoundError（-32001）：不泄露「存在但不是你的」。
   */
  const handleGetTask = (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    rpcId: unknown,
    taskId: unknown,
    style: A2aEmitStyle,
  ): void => {
    // 只读口径与 /v1/sessions/{id} 一致：session:read 窄 scope 优先，旧 task:read 兼容
    if (!authorize(['session:read', 'task:read'])) return;
    if (typeof taskId !== 'string' || !taskId) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'params.id 必须是非空字符串');
      return;
    }
    let task: A2aTask;
    try {
      const snap = deps.store.snapshot(taskId, {
        afterEventSeq: 0,
        limit: 1000,
        tenantId: ctx.tenantId,
      });
      task = toA2aTask({
        session: snap.session,
        events: snap.events,
        artifacts: snap.artifacts,
        style,
        baseUrl: baseUrl(),
      });
    } catch {
      // SessionStoreError（含跨租户按 not found 处理）
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.taskNotFound, `任务不存在：${String(taskId)}`);
      return;
    }
    rpcOk(ctx.res, rpcId, task);
  };

  /**
   * `SendMessage`（message/send）：message.parts → prompt，message.metadata 带 bridge 扩展字段
   * （agentType / cwd 必填；timeoutMs / captureDiff / permissionMode 可选）。
   * messageId 即幂等键：客户端重发同 messageId 拿回同一 taskId，不会跑两遍。
   * 网关**永远立即返回**（等价 returnImmediately）：bridge 任务是分钟级长任务，阻塞到终态
   * 会把 A2A 客户端的 HTTP 超时拖穿；后续状态走 GetTask 轮询或 SubscribeToTask 订阅。
   */
  const handleSendMessage = (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    rpcId: unknown,
    params: Record<string, unknown> | null | undefined,
    style: A2aEmitStyle,
  ): void => {
    if (!authorize('task:create')) return;
    const message = params?.['message'] as Record<string, unknown> | null | undefined;
    if (!message || typeof message !== 'object') {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'params.message 必须是 Message 对象');
      return;
    }
    const role = message['role'];
    if (role !== 'user' && role !== 'ROLE_USER') {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, '创建任务的 message.role 必须是 user（ROLE_USER）');
      return;
    }
    const parts = message['parts'];
    if (!Array.isArray(parts) || parts.length === 0) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'message.parts 必须是非空数组');
      return;
    }
    const texts: string[] = [];
    for (const p of parts) {
      const part = p as Record<string, unknown> | null | undefined;
      const kind = part?.['kind'] ?? part?.['type'];
      if (kind !== 'text') {
        rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.contentTypeNotSupported, '只支持 text part（file/data part 暂不支持）');
        return;
      }
      const text = part?.['text'];
      if (typeof text !== 'string') {
        rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'text part 缺 text 字段');
        return;
      }
      texts.push(text);
    }
    const prompt = texts.join('\n');
    if (!prompt.trim()) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'prompt 不能为空');
      return;
    }
    const metadata = message['metadata'] as Record<string, unknown> | null | undefined;
    const agentType = typeof metadata?.['agentType'] === 'string' ? metadata['agentType'] : undefined;
    const cwd = typeof metadata?.['cwd'] === 'string' ? metadata['cwd'] : undefined;
    if (!agentType || !cwd) {
      rpcErr(
        ctx.res,
        rpcId,
        A2A_JSONRPC_ERRORS.invalidParams,
        'message.metadata 缺 bridge 扩展字段：agentType（12 个受管 CLI 之一）与 cwd（须存在且在 allowed_cwd 内）',
      );
      return;
    }
    if (!deps.agents.some((a) => a.id === agentType)) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, `未知 agentType：${agentType}（不在受管适配器白名单内）`);
      return;
    }
    const timeoutMs = typeof metadata?.['timeoutMs'] === 'number' ? metadata['timeoutMs'] : undefined;
    const messageId = typeof message['messageId'] === 'string' && message['messageId'] ? message['messageId'] : undefined;
    if (!messageId) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'message.messageId 必须是非空字符串（幂等键）');
      return;
    }
    let taskId: string;
    let replay: boolean;
    try {
      const created = deps.ops.createTask({
        tenantId: ctx.tenantId ?? DEFAULT_TENANT,
        agentType,
        cwd,
        prompt,
        timeoutMs,
        requestedBy: typeof metadata?.['requestedBy'] === 'string' ? metadata['requestedBy'] : undefined,
        idempotencyKey: messageId,
        idempotencyFingerprint: { agentType, cwd, prompt, timeoutMs },
      });
      ({ taskId, replay } = created);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'idempotency_conflict') {
        rpcErr(ctx.res, rpcId, -32000, '同 messageId 的请求内容不同（幂等冲突）', { code });
        return;
      }
      // startTask 的受控拒绝（device_busy / tool_not_installed / cwd_* 等）：code 放进 data，客户端按 code 分支
      rpcErr(ctx.res, rpcId, -32000, `任务创建被拒绝：${(error as Error).message}`, code ? { code } : undefined);
      return;
    }
    let task: A2aTask;
    try {
      const snap = deps.store.snapshot(taskId, { afterEventSeq: 0, limit: 1000, tenantId: ctx.tenantId });
      task = toA2aTask({ session: snap.session, events: snap.events, artifacts: snap.artifacts, style, baseUrl: baseUrl() });
    } catch {
      // 创建成功但快照读取失败：任务确实已调度，不能谎报失败 —— 给可用的最小 Task
      task = {
        id: taskId,
        contextId: taskId,
        status: { state: style.state('TASK_STATE_SUBMITTED') },
        metadata: { bridge: { replay } },
      };
      if (style.taskKindDiscriminator) task.kind = 'task';
      rpcOk(ctx.res, rpcId, task);
      return;
    }
    if (replay) (task.metadata ??= {})['idempotentReplay'] = true;
    rpcOk(ctx.res, rpcId, task);
  };

  /**
   * `CancelTask`（tasks/cancel）：走 control-plane 的取消语义（SIGTERM → 2s → SIGKILL，终态经 Emitter 回传）。
   * A2A 规范语义：终态任务取消回 TaskNotCancelableError（-32002）；跨租户/不存在统一 -32001。
   */
  const handleCancelTask = (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    rpcId: unknown,
    params: Record<string, unknown> | null | undefined,
    style: A2aEmitStyle,
  ): void => {
    if (!authorize('task:cancel')) return;
    const id = params?.['id'];
    if (typeof id !== 'string' || !id) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'params.id 必须是非空字符串');
      return;
    }
    const outcome = deps.ops.cancelTask(id, ctx.tenantId ?? DEFAULT_TENANT);
    if (outcome === 'not_found') {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.taskNotFound, `任务不存在：${id}`);
      return;
    }
    if (outcome === 'terminal') {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.taskNotCancelable, `任务已终态，不可取消：${id}`);
      return;
    }
    if (outcome === 'not_owned') {
      // 平台下发的任务网关无权替它做取消决定；对外按「不可取消」表达，不暴露所有权细节
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.taskNotCancelable, `任务 ${id} 不是网关通道创建，无法从这里取消`);
      return;
    }
    // cancelled：终态还没落库（supervisor 异步回传），返回当前快照（working 态）
    try {
      const snap = deps.store.snapshot(id, { afterEventSeq: 0, limit: 1000, tenantId: ctx.tenantId });
      rpcOk(ctx.res, rpcId, toA2aTask({ session: snap.session, events: snap.events, artifacts: snap.artifacts, style, baseUrl: baseUrl() }));
    } catch {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.taskNotFound, `任务不存在：${id}`);
    }
  };

  /**
   * `SubscribeToTask`（tasks/resubscribe）：SSE 流，`eventSeq` 补洞。
   * 帧格式是 bridge 网关自定义（不声称 A2A v1.0 StreamResponse 兼容——card 的 streaming 仍为 false）：
   *  - `event: task`     → A2A Task 完整快照（首帧与终帧）
   *  - `event: message`  → { eventSeq, message: A2A Message }
   *  - `event: status`   → { eventSeq, status: A2A TaskStatus }
   *  - `event: artifact` → { eventSeq, artifact: A2A Artifact }
   *  - `event: log|step` → 调试扩展（task_log/task_step，按 proposal 不冒充标准消息）
   *  - `event: done`     → { taskId, status }
   * 补洞起点：`params.metadata.afterEventSeq`（缺省 0 = 全量回放）；终态任务按规范回 -32004。
   */
  const handleSubscribeToTask = (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    rpcId: unknown,
    params: Record<string, unknown> | null | undefined,
    style: A2aEmitStyle,
  ): void => {
    if (!authorize(['session:read', 'task:read'])) return;
    const id = params?.['id'];
    if (typeof id !== 'string' || !id) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidParams, 'params.id 必须是非空字符串');
      return;
    }
    // 闭包别名：function 声明（emitStoreEvent）不保留参数 narrowing，显式固定为 string
    const taskKey: string = id;
    const meta = params?.['metadata'] as Record<string, unknown> | null | undefined;
    const afterRaw = Number(meta?.['afterEventSeq'] ?? 0);
    const after = Number.isFinite(afterRaw) ? Math.max(0, Math.floor(afterRaw)) : 0;
    let snap: ReturnType<SessionStore['snapshot']>;
    try {
      snap = deps.store.snapshot(id, { afterEventSeq: 0, limit: 1, tenantId: ctx.tenantId });
    } catch {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.taskNotFound, `任务不存在：${id}`);
      return;
    }
    // 规范：终态任务不再可订阅（SubscribeToTask on terminal task → UnsupportedOperationError）
    if (snap.session.status !== 'running') {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.unsupportedOperation, `任务已终态（${snap.session.status}），订阅已关闭：${id}`);
      return;
    }
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let lastSeq = after;
    const writeEvent = (event: string, data: unknown): void => {
      try {
        ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* 客户端已断开 */
      }
    };
    writeEvent(
      'task',
      toA2aTask({
        session: snap.session,
        events: snap.events,
        artifacts: snap.artifacts,
        style,
        baseUrl: baseUrl(),
      }),
    );
    // 回放：按 eventSeq 追平持久化事件（慢消费者断线后可能落后很多，分批补）
    for (;;) {
      const replay = deps.store.listEvents(id, { afterEventSeq: lastSeq, limit: 1000, tenantId: ctx.tenantId });
      for (const item of replay) emitStoreEvent(item);
      if (replay.length < 1000) break;
      const next = replay.at(-1)?.eventSeq;
      if (next === undefined || next <= lastSeq) break;
      lastSeq = next;
    }
    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      off();
      clearInterval(heartbeat);
      try {
        ctx.res.end();
      } catch {
        /* already ended */
      }
    };
    const send = (upstream: Upstream): void => {
      if (closed) return;
      const msg = upstream as ClientMessage;
      if (!('taskId' in msg) || msg.taskId !== id) return;
      const seq = 'eventSeq' in msg && typeof msg.eventSeq === 'number' ? msg.eventSeq : undefined;
      if (seq !== undefined && seq <= lastSeq) return;
      if (seq !== undefined) lastSeq = seq;
      switch (msg.type) {
        case 'task_message':
          if (msg.state !== 'complete') return; // delta 是流式增量，不进订阅流（快照语义）
          writeEvent('message', {
            eventSeq: seq,
            message: {
              role: style.role('agent'),
              parts: [{ [style.partDiscriminator]: 'text', text: msg.text }],
              messageId: msg.messageId,
              taskId: id,
            },
          });
          break;
        case 'task_status': {
          writeEvent('status', {
            eventSeq: seq,
            status: {
              state: style.state(toA2aTaskState(msg.status, msg.phase)),
              timestamp: new Date().toISOString(),
              ...(msg.status !== 'running' && msg.error ? { message: { role: style.role('agent'), parts: [{ [style.partDiscriminator]: 'text', text: msg.error }], messageId: `err_${seq ?? 0}` } } : {}),
            },
          });
          if (msg.status !== 'running') {
            // 终态：回一个最终快照再关流（订阅方拿到确定结束点）
            const current = deps.store.getSession(id, ctx.tenantId);
            if (current) {
              const finalSnap = deps.store.snapshot(id, { afterEventSeq: 0, limit: 1, tenantId: ctx.tenantId });
              writeEvent('task', toA2aTask({ session: finalSnap.session, events: finalSnap.events, artifacts: finalSnap.artifacts, style, baseUrl: baseUrl() }));
            }
            writeEvent('done', { taskId: id, status: msg.status });
            cleanup();
          }
          break;
        }
        case 'task_artifact':
          writeEvent('artifact', {
            eventSeq: seq,
            artifact: {
              artifactId: msg.artifactId,
              name: msg.name,
              parts: [{ [style.partDiscriminator]: 'file', file: { uri: `${baseUrl()}/v1/sessions/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(msg.artifactId)}`, mimeType: msg.mimeType || 'application/octet-stream', name: msg.name } }],
              metadata: { size: msg.size, sha256: msg.sha256, kind: msg.kind },
            },
          });
          break;
        default:
          break; // task_log / task_step：持久化回放里有（emitStoreEvent），实时流里不重复发
      }
    };
    /** 持久化事件 → 帧映射（回放用；与实时 send 保持同一 vocab） */
    function emitStoreEvent(item: { eventSeq: number; type: string; payload: unknown; createdAt: string }): void {
      const payload = (item.payload ?? {}) as Record<string, unknown>;
      if (item.type === 'task_message' && payload['state'] === 'complete') {
        writeEvent('message', {
          eventSeq: item.eventSeq,
          message: {
            role: style.role(payload['role'] === 'user' ? 'user' : 'agent'),
            parts: [{ [style.partDiscriminator]: 'text', text: typeof payload['text'] === 'string' ? payload['text'] : '' }],
            messageId: typeof payload['messageId'] === 'string' ? payload['messageId'] : `msg_${item.eventSeq}`,
            taskId: taskKey,
          },
        });
      } else if (item.type === 'task_status') {
        const status = payload['status'];
        if (typeof status === 'string') {
          writeEvent('status', {
            eventSeq: item.eventSeq,
            status: { state: style.state(toA2aTaskState(status as TaskStatus, undefined)), timestamp: item.createdAt },
          });
        }
      } else if (item.type === 'task_artifact') {
        const artId = typeof payload['artifactId'] === 'string' && payload['artifactId'] ? payload['artifactId'] : `ar_${item.eventSeq}`;
        writeEvent('artifact', {
          eventSeq: item.eventSeq,
          artifact: {
            artifactId: artId,
            name: typeof payload['name'] === 'string' ? payload['name'] : undefined,
            parts: [
              {
                [style.partDiscriminator]: 'file',
                file: { uri: `${baseUrl()}/v1/sessions/${encodeURIComponent(taskKey)}/artifacts/${encodeURIComponent(artId)}` },
              },
            ],
          },
        });
      } else if (item.type === 'task_log' || item.type === 'task_step') {
        // 调试扩展：透传 type + eventSeq（按 proposal：task_log 不冒充标准消息）
        writeEvent(item.type === 'task_log' ? 'log' : 'step', { eventSeq: item.eventSeq, payload: item.payload });
      }
    }
    const off = deps.emitter.subscribe(send);
    const heartbeat = setInterval(() => writeEvent('heartbeat', { at: Date.now() }), 15_000);
    heartbeat.unref?.();
    ctx.req.on('close', cleanup);
    ctx.res.on('close', cleanup);
  };

  const handleA2a = (ctx: GatewayRequestContext, authorize: GatewayAuthorize): void => {
    const header = ctx.req.headers['a2a-version'];
    const headerStr = Array.isArray(header) ? header[0] : header;
    const version = negotiateA2aVersion(headerStr);
    const rawId = (ctx.body as Record<string, unknown> | null | undefined)?.['id'];
    const rpcId = rawId === undefined ? null : rawId;
    if (version === 'unsupported') {
      rpcErr(
        ctx.res,
        rpcId,
        A2A_JSONRPC_ERRORS.versionNotSupported,
        `不支持的 A2A-Version：${String(headerStr)}`,
      );
      return;
    }
    const style = a2aEmitStyleFor(version);
    const body = ctx.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      rpcErr(ctx.res, null, A2A_JSONRPC_ERRORS.invalidRequest, '请求体必须是单个 JSON-RPC 2.0 对象');
      return;
    }
    if (body['jsonrpc'] !== '2.0') {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidRequest, 'jsonrpc 字段必须是 "2.0"');
      return;
    }
    const method = body['method'];
    if (typeof method !== 'string' || !method) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.invalidRequest, 'method 必须是非空字符串');
      return;
    }
    const op = A2A_METHODS[method];
    if (!op) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.methodNotFound, `未知方法：${method}`);
      return;
    }
    const unimplemented = UNIMPLEMENTED[op];
    if (unimplemented) {
      rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.unsupportedOperation, unimplemented);
      return;
    }
    const params = body['params'] as Record<string, unknown> | null | undefined;
    if (op === 'getTask') {
      handleGetTask(ctx, authorize, rpcId, params?.['id'], style);
      return;
    }
    if (op === 'sendMessage') {
      handleSendMessage(ctx, authorize, rpcId, params, style);
      return;
    }
    if (op === 'cancelTask') {
      handleCancelTask(ctx, authorize, rpcId, params, style);
      return;
    }
    if (op === 'subscribeToTask') {
      handleSubscribeToTask(ctx, authorize, rpcId, params, style);
      return;
    }
    // 理论不可达（上面 UNIMPLEMENTED 已挡），保留兜底防未来漏分支
    rpcErr(ctx.res, rpcId, A2A_JSONRPC_ERRORS.unsupportedOperation, '操作未实现');
  };

  // ==================== ACP server（tasks 3.x） ====================
  // ACP v1 over HTTP：请求 POST /acp（JSON-RPC 2.0）；session/prompt 的下行走 SSE
  // （`event: update` 通知帧 / `event: request` agent→client 请求帧 / `event: result` 终帧）。
  // 客户端对 agent→client 请求的应答用另一条 POST /acp 发「响应报文」（无 method、带 id+result），
  // 网关按出站 id 关联 pending 交互后走与 /v1/interactions/{id}:respond 同一条 dispatch 路径。

  /** ACP 会话登记：acpSessionId → 启动参数与 conversation 绑定（add-acp-session-memory） */
  const acpSessions = new Map<
    string,
    {
      agentType: string;
      cwd: string;
      tenantId: string;
      /** 首轮 prompt 后绑定的 bridge conversation 会话（多轮续接同一会话） */
      bridgeSessionId?: string;
      /** 当前进行中的 turn（prompt SSE 流的生命周期内；waiting_user/终态后清空） */
      currentTurnId?: string;
    }
  >();
  /** 出站交互请求：JSON-RPC id → pending 交互定位（客户端应答时反向解析） */
  const outboundRequests = new Map<
    string,
    { requestId: string; sessionId: string; tenantId: string; kind: 'permission' | 'form' | 'auth-url' }
  >();
  let outboundSeq = 0;

  /** 交互记录 → ACP agent→client 请求帧的 params（按 kind 分派，畸形 payload 报错不透传） */
  const toAcpRequestFrame = (
    kind: 'permission' | 'form' | 'auth-url',
    interaction: { sessionId: string; payload: unknown },
  ): { method: string; params: AcpgwPermissionRequestParams | AcpgwElicitationParams } | { invalid: string } => {
    if (kind === 'permission') {
      const params = toAcpPermissionRequestParams(interaction);
      return 'invalid' in params ? params : { method: acpMethodForInteractionKind(kind), params };
    }
    if (kind === 'auth-url') {
      const params = toAcpUrlElicititationParams(interaction);
      return 'invalid' in params ? params : { method: 'elicitation/create', params };
    }
    const params = toAcpElicitationParams(interaction);
    return 'invalid' in params ? params : { method: acpMethodForInteractionKind(kind), params };
  };

  /**
   * ACP `initialize`：只声明真实能力（loadSession=false —— 会话不持久续接；
   * prompt 只收 text block；fs/terminal 客户端能力默认不开放）。
   */
  const handleAcpInitialize = (ctx: GatewayRequestContext): void => {
    rpcOk(ctx.res, 'acp-init', {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
      },
      agentInfo: { name: 'agent-bridge', title: 'agent-bridge ACP gateway', version: deps.version },
      authMethods: [],
    });
  };

  /** ACP `session/new`：固化 agentType/cwd（`params._meta.agentType` 扩展字段）；prompt 逐轮建任务 */
  const handleAcpSessionNew = (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    rpcId: unknown,
    params: Record<string, unknown> | null | undefined,
  ): void => {
    // initialize / session/new 用 device:read（握手与会话登记，不涉及任务数据）
    if (!authorize('device:read')) return;
    const cwd = typeof params?.['cwd'] === 'string' ? params['cwd'] : undefined;
    const meta = (params?.['_meta'] ?? params?.['meta']) as Record<string, unknown> | null | undefined;
    const agentType =
      typeof meta?.['agentType'] === 'string'
        ? meta['agentType']
        : typeof params?.['agentType'] === 'string'
          ? params['agentType']
          : undefined;
    if (!agentType || !cwd) {
      rpcErr(
        ctx.res,
        rpcId,
        ACP_JSONRPC_ERRORS.invalidParams,
        'session/new 需要 params.cwd 与 params._meta.agentType（bridge 有 12 个 CLI，必须显式选择）',
      );
      return;
    }
    if (!deps.agents.some((a) => a.id === agentType)) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.invalidParams, `未知 agentType：${agentType}（不在受管适配器白名单内）`);
      return;
    }
    const acpSessionId = `acp_${randomBytes(8).toString('hex')}`;
    acpSessions.set(acpSessionId, {
      agentType,
      cwd,
      tenantId: ctx.tenantId ?? DEFAULT_TENANT,
    });
    rpcOk(ctx.res, rpcId, { sessionId: acpSessionId });
  };

  /**
   * ACP `session/prompt`：一轮 prompt = 一个 bridge 任务（proposal：session/prompt 映射到 run_task）。
   * SSE 下行：`event: prompt`（taskId 对照）→ `event: update`（session/update 通知）→
   * 交互时 `event: request`（agent→client 请求）→ `event: result`（stopReason 终帧）。
   */
  /**
   * ACP `session/prompt`（add-acp-session-memory：conversation 多轮语义）。
   * 首轮 = `run_task(sessionMode=conversation)`（创建 bridge 会话）；后续轮 = `send_message`
   * （续接同一会话，CLI 原生续接，token 只传增量）。SSE 下行：`event: prompt` →
   * `event: update`（agent_message_chunk）→ 交互时 `event: request` → `event: result`
   * （本轮 turn 结束：waiting_user → end_turn；turn 失败 → JSON-RPC error，会话随之关闭）。
   */
  const handleAcpSessionPrompt = (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    rpcId: unknown,
    params: Record<string, unknown> | null | undefined,
  ): void => {
    if (!authorize('task:create')) return;
    const conversation = deps.conversation;
    if (!conversation) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.unsupportedOperation, 'conversation 编排未接入（该进程未启用多轮会话）');
      return;
    }
    const sessionId = params?.['sessionId'];
    if (typeof sessionId !== 'string' || !sessionId) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.invalidParams, 'params.sessionId 必须是非空字符串');
      return;
    }
    const session = acpSessions.get(sessionId);
    // 跨租户：统一按不存在处理（不暴露「存在但不是你的」）
    if (!session || session.tenantId !== (ctx.tenantId ?? DEFAULT_TENANT)) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.sessionNotFound, `ACP 会话不存在：${sessionId}`);
      return;
    }
    if (session.currentTurnId) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.promptBusy, `会话 ${sessionId} 已有进行中的轮次（turn ${session.currentTurnId}），先 session/cancel`);
      return;
    }
    const text = acpPromptToText(params?.['prompt']);
    if ('unsupported' in text) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.invalidParams, text.unsupported);
      return;
    }
    // 续轮前置检查：bridge 会话已终态（空闲回收/失败）→ 如实拒绝，让客户端 session/new 重开
    // （重启后的 acpSession 登记丢失走 sessionNotFound，同一条诚实原则）
    if (session.bridgeSessionId) {
      const bridge = deps.store.getSession(session.bridgeSessionId, session.tenantId);
      if (!bridge || bridge.status !== 'running') {
        rpcErr(
          ctx.res,
          rpcId,
          ACP_JSONRPC_ERRORS.sessionNotFound,
          `会话已结束（${bridge?.status ?? 'missing'}）：请 session/new 新建会话`,
        );
        return;
      }
    }
    // 透传 Bearer（dispatch 层的服务身份校验与 HTTP 鉴权同一令牌体系）
    const header = ctx.req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;

    const bridgeSessionId = session.bridgeSessionId ?? `bt_${randomBytes(6).toString('hex')}`;
    const isFirstTurn = session.bridgeSessionId === undefined;
    session.bridgeSessionId = bridgeSessionId;

    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const writeFrame = (event: string, data: unknown): void => {
      try {
        ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* 客户端已断开 */
      }
    };
    writeFrame('prompt', { sessionId, taskId: bridgeSessionId, turn: isFirstTurn ? 'first' : 'continue' });

    let lastContent: string | undefined;
    let currentTurnId: string | undefined;
    let closed = false;
    const writeUpdate = (text: string): void => {
      writeFrame('update', {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        },
      });
    };
    /** 本轮 turn 收尾：waiting_user → end_turn（会话保持开放）；终帧后关流、清 currentTurnId */
    const finishTurn = (stopReason: 'end_turn' | 'cancelled'): void => {
      const current = acpSessions.get(sessionId);
      if (current && current.currentTurnId === currentTurnId) current.currentTurnId = undefined;
      writeFrame('result', { jsonrpc: '2.0', id: rpcId, result: { sessionId, stopReason, content: lastContent } });
      cleanup();
    };
    /** 会话终态（turn 失败/超时）：conversation 语义是会话随之关闭；error 帧不用假成功 */
    const finishSession = (status: TaskStatus, info?: { error?: string; exitCode?: number }): void => {
      const current = acpSessions.get(sessionId);
      if (current && current.currentTurnId === currentTurnId) current.currentTurnId = undefined;
      writeFrame('result', {
        jsonrpc: '2.0',
        id: rpcId,
        error: {
          code: -32000,
          message: `会话${status === 'timeout' ? '超时' : status === 'cancelled' ? '被取消' : '失败'}：${info?.error ?? 'no detail'}`,
          data: { bridgeStatus: status, exitCode: info?.exitCode },
        },
      });
      cleanup();
    };
    const reject = (errorCode: string): void => {
      const current = acpSessions.get(sessionId);
      if (current) current.currentTurnId = undefined;
      writeFrame('result', {
        jsonrpc: '2.0',
        id: rpcId,
        error: { code: -32000, message: `消息被拒绝：${errorCode}`, data: { code: errorCode } },
      });
      cleanup();
    };
    /** 等待人工交互：把 pending 交互转成 agent→client 请求帧 */
    const sendPendingInteractions = (): void => {
      const pendings = deps.store.queryInteractions({ sessionId: bridgeSessionId, tenantId: session.tenantId, state: 'pending', limit: 10 });
      for (const interaction of pendings) {
        const key = `gwir_${++outboundSeq}`;
        const frame = toAcpRequestFrame(interaction.kind, interaction);
        if ('invalid' in frame) {
          deps.log('error', `[gateway] ACP 交互 ${interaction.requestId} 映射失败：${frame.invalid}`);
          continue;
        }
        outboundRequests.set(key, {
          requestId: interaction.requestId,
          sessionId: bridgeSessionId,
          tenantId: session.tenantId,
          kind: interaction.kind,
        });
        writeFrame('request', { jsonrpc: '2.0', id: key, method: frame.method, params: frame.params });
      }
    };
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      off();
      clearInterval(heartbeat);
      // 出站请求登记随流结束清理（客户端应答晚到 → 404 出站请求不存在，诚实失败）
      for (const [key, value] of outboundRequests) {
        if (value.sessionId === bridgeSessionId && value.kind === 'permission') outboundRequests.delete(key);
      }
      try {
        ctx.res.end();
      } catch {
        /* already ended */
      }
    };
    const send = (upstream: Upstream): void => {
      if (closed) return;
      const msg = upstream as ClientMessage;
      if (!('taskId' in msg) || msg.taskId !== bridgeSessionId) return;
      // message_ack：queued/duplicate 锁定本轮 turnId；rejected → 拒绝帧
      if (msg.type === 'message_ack') {
        if (typeof msg.turnId === 'string' && currentTurnId === undefined) currentTurnId = msg.turnId;
        if (msg.delivery === 'rejected') reject(String(msg.errorCode ?? 'rejected'));
        return;
      }
      // turn 过滤：currentTurnId 锁定前，第一个带 turnId 的事件即本轮（订阅先于发起，无旧轮噪声）
      const turnId = 'turnId' in msg && typeof msg.turnId === 'string' ? msg.turnId : undefined;
      if (turnId !== undefined && currentTurnId === undefined) currentTurnId = turnId;
      if (turnId !== undefined && currentTurnId !== undefined && turnId !== currentTurnId) return;
      if (msg.type === 'task_message' && msg.state === 'complete') {
        lastContent = msg.text;
        writeUpdate(msg.text);
      } else if (msg.type === 'task_status') {
        if (msg.status !== 'running') {
          finishSession(msg.status, { error: msg.error, exitCode: msg.exitCode });
          return;
        }
        if (msg.phase === 'waiting_user') {
          finishTurn('end_turn');
          return;
        }
        if (msg.phase === 'waiting_interaction') sendPendingInteractions();
      }
    };
    // 订阅先于发起：run/message 的同步 emit（turn 建立、ack）全部实时可达，无需回放
    const off = deps.emitter.subscribe(send);
    const heartbeat = setInterval(() => writeFrame('heartbeat', { at: Date.now() }), 15_000);
    heartbeat.unref?.();
    ctx.req.on('close', cleanup);
    ctx.res.on('close', cleanup);

    // 发起本轮（在 SSE 与订阅就绪之后）
    void (async () => {
      try {
        if (isFirstTurn) {
          conversation.run({
            type: 'run_task',
            taskId: bridgeSessionId,
            agentType: session.agentType,
            cwd: session.cwd,
            args: [],
            prompt: text.text,
            sessionMode: 'conversation',
            requestedBy: 'acp-gateway',
            ...(token ? { serviceToken: token } : {}),
          });
          // 首轮 turn：dispatchConversationRun 同步建 turn
          const turn = deps.store.listTurns(bridgeSessionId, session.tenantId).at(-1);
          if (turn && currentTurnId === undefined) {
            currentTurnId = turn.turnId;
            session.currentTurnId = turn.turnId;
          }
        } else {
          const messageId = `acpmsg_${randomBytes(6).toString('hex')}`;
          await conversation.message({
            type: 'send_message',
            taskId: bridgeSessionId,
            messageId,
            parts: [{ kind: 'text', text: text.text }],
            ...(token ? { serviceToken: token } : {}),
          });
          // 续轮 turn：message_ack(queued).turnId 已由 send 捕获；兜底查 store（queued/running 的最新 turn）
          if (currentTurnId === undefined) {
            const turn = deps.store.listTurns(bridgeSessionId, session.tenantId).at(-1);
            if (turn && (turn.status === 'queued' || turn.status === 'running')) {
              currentTurnId = turn.turnId;
              session.currentTurnId = turn.turnId;
            }
          } else {
            session.currentTurnId = currentTurnId;
          }
        }
      } catch (error) {
        reject((error as { code?: string })?.code ?? 'conversation_error');
      }
    })();
  };

  /** ACP `session/cancel`：取消当前轮次（cancel_turn 编排；无活动轮次静默成功——notification 语义） */
  const handleAcpSessionCancel = (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    rpcId: unknown,
    params: Record<string, unknown> | null | undefined,
  ): void => {
    if (!authorize('task:cancel')) return;
    const conversation = deps.conversation;
    const sessionId = params?.['sessionId'];
    if (typeof sessionId !== 'string' || !sessionId) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.invalidParams, 'params.sessionId 必须是非空字符串');
      return;
    }
    const session = acpSessions.get(sessionId);
    if (!session || session.tenantId !== (ctx.tenantId ?? DEFAULT_TENANT)) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.sessionNotFound, `ACP 会话不存在：${sessionId}`);
      return;
    }
    if (!session.currentTurnId || !session.bridgeSessionId) {
      // v1 notification 语义：无活动轮次时静默成功（不报错）
      rpcOk(ctx.res, rpcId, { cancelled: false });
      return;
    }
    if (!conversation) {
      rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.unsupportedOperation, 'conversation 编排未接入');
      return;
    }
    // 先取局部快照：cancel 会经 Emitter 触发 prompt 流 finish，把 currentTurnId 清掉
    const turnId = session.currentTurnId;
    const taskId = session.bridgeSessionId;
    const header = ctx.req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;
    conversation.cancelTurn({
      type: 'cancel_turn',
      taskId,
      turnId,
      operationId: `acpcancel_${randomBytes(6).toString('hex')}`,
      ...(token ? { serviceToken: token } : {}),
    });
    rpcOk(ctx.res, rpcId, { cancelled: true, taskId, turnId });
  };

  /**
   * ACP 客户端应答 agent→client 请求（响应报文：无 method、带 id + result）。
   * 走与 `POST /v1/interactions/{id}:respond` **同一条** dispatch 路径（权限判定双保险）。
   */
  const handleAcpInteractionAnswer = async (
    ctx: GatewayRequestContext,
    authorize: GatewayAuthorize,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const respond = deps.respondInteraction;
    const key = body['id'];
    if (typeof key !== 'string') {
      json(ctx.res, 400, { error: '交互应答的 id 必须是网关下发的字符串' });
      return;
    }
    const pending = outboundRequests.get(key);
    if (!pending) {
      json(ctx.res, 404, { error: `未找到出站请求 ${key}（流已结束或不存在）` });
      return;
    }
    // 按交互种类要 scope（与 HTTP :respond 同规则）；dispatch 内部还会复核一次
    if (!authorize(pending.kind === 'permission' ? 'task:approve' : 'task:respond')) return;
    const kind = pending.kind;
    let state: 'accepted' | 'declined' | 'cancelled';
    let payload: Record<string, unknown> | undefined;
    if (kind === 'permission') {
      const outcome = fromAcpPermissionOutcome(body['result']);
      if ('invalid' in outcome) {
        json(ctx.res, 400, { error: outcome.invalid });
        return;
      }
      if (outcome.state === 'accepted') {
        state = 'accepted';
        payload = { optionId: outcome.optionId };
      } else {
        state = 'cancelled';
      }
    } else {
      const outcome = fromAcpElicitationResult(body['result']);
      if ('invalid' in outcome) {
        json(ctx.res, 400, { error: outcome.invalid });
        return;
      }
      if (outcome.state === 'accepted') {
        state = 'accepted';
        payload = { content: outcome.content };
      } else {
        state = outcome.state === 'declined' ? 'declined' : 'cancelled';
      }
    }
    if (!respond) {
      json(ctx.res, 501, { error: '当前进程未启用交互响应通道（只读模式）' });
      return;
    }
    const header = ctx.req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    const token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;
    const outcome = await respond({
      type: 'task_interaction_response',
      taskId: pending.sessionId,
      requestId: pending.requestId,
      responseId: `rs_${key.replace(/[^a-z0-9_]/gi, '').slice(0, 24) || 'gw'}`,
      tenantId: pending.tenantId,
      state,
      ...(payload ? { payload } : {}),
      ...(token ? { serviceToken: token } : {}),
    });
    if (outcome.ok) {
      json(ctx.res, 200, { ok: true, state: outcome.state, resultSeq: outcome.resultSeq });
    } else {
      json(ctx.res, 409, { ok: false, errorCode: outcome.errorCode });
    }
  };

  const handleAcp = (ctx: GatewayRequestContext, authorize: GatewayAuthorize): void => {
    const body = ctx.body as Record<string, unknown> | null | undefined;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      json(ctx.res, 400, { error: '请求体必须是单个 JSON-RPC 2.0 对象' });
      return;
    }
    if (body['jsonrpc'] !== '2.0') {
      json(ctx.res, 400, { error: 'jsonrpc 字段必须是 "2.0"' });
      return;
    }
    // 响应报文（客户端应答 agent→client 请求）：无 method、带 id+result
    if (typeof body['method'] !== 'string' || !body['method']) {
      if (body['result'] !== undefined || body['error'] !== undefined) {
        void handleAcpInteractionAnswer(ctx, authorize, body);
        return;
      }
      json(ctx.res, 400, { error: '缺 method（请求）或 result/error（应答）' });
      return;
    }
    const method = body['method'];
    const rpcId = body['id'] === undefined ? null : body['id'];
    const params = body['params'] as Record<string, unknown> | null | undefined;
    if (method === 'initialize') {
      handleAcpInitialize(ctx);
      return;
    }
    if (method === 'session/new') {
      handleAcpSessionNew(ctx, authorize, rpcId, params);
      return;
    }
    if (method === 'session/prompt') {
      handleAcpSessionPrompt(ctx, authorize, rpcId, params);
      return;
    }
    if (method === 'session/cancel') {
      handleAcpSessionCancel(ctx, authorize, rpcId, params);
      return;
    }
    rpcErr(ctx.res, rpcId, ACP_JSONRPC_ERRORS.methodNotFound, `ACP 方法未实现：${method}（当前支持 initialize/session/new/session/prompt/session/cancel）`);
  };

  return {
    agentCard: handleAgentCard,
    a2a: handleA2a,
    acp: handleAcp,
  };
}

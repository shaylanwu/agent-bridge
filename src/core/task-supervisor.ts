/**
 * 任务调度领域对象（架构第二期）
 *
 * 之前的问题：`runner.ts` 用**模块级变量**承载调度状态（`runningTasks` / `queue` / `currentMaxTasks`），
 * 而且 `currentMaxTasks` 会被"最近一次下发的请求"覆盖 —— 这是隐式全局配置，
 * 两个用例会互相污染，也无法在一台机器上跑两个独立调度域。
 *
 * 现在：所有调度状态内聚进 `TaskSupervisor` 实例，可注入、可单测、可多实例。
 * `runner.ts` 只保留一个薄兼容包装（现有调用方零改动）。
 *
 * 状态机（显式）：
 *
 *      submit ──▶ queued ──(有空位)──▶ running ──▶ settled
 *         │          │                     │
 *         └──────────┴──(取消/超时)────────┴──▶ settled
 *
 * settled 是吸收态：只 settle 一次、只释放一次名额（终态上行的幂等由 Emitter 负责）。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  AcpAuthRequiredError,
  runAcpPrompt,
  type AcpAgentSpec,
  type AcpFormResponse,
} from '../adapters/acp-codebuddy.js';
import { codexNoticeText, runCodexPrompt } from '../adapters/codex-app-server.js';
import { runClaudeStreamPrompt } from '../adapters/claude-stream.js';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { agentDefOf, killCliProcess, resolveBin, taskArgsForPermission, type AgentDef } from '../adapters/agent-adapters.js';
import { captureWorktreeDiff, type DiffCapture } from '../infra/git.js';
import {
  chunkLog,
  type PermissionMode,
  type SnapshotPartialMessage,
  type StopReason,
  type TaskPhase,
  type TaskStatus,
} from '../protocol.js';
import { buildWinCommandLine, isWinShim } from '../adapters/win-exec.js';
import { withoutHostEnv } from '../adapters/host-env.js';
import { createStepParser, claudeToolCallOf, type ParsedStep, type PlanItem, type StepFormat } from '../adapters/step-parsers.js';
import { BridgeError, type BridgeErrorCode } from './errors.js';
import { looksLikeContextOverflow } from './context-overflow.js';
import { PartialMessageTracker, acpChunkText, claudeBlockText, codexDeltaText } from './partial-messages.js';
import { decidePermissionMode, fullResidualPermissionOutcome, permissionEnvFor, type PermissionPolicyName } from './permission-policy.js';
import { externalProxyEnv } from '../infra/proxy-env.js';
import { InteractionBroker } from './interaction-broker.js';

export interface RunTaskRequest {
  taskId: string;
  agentType: string;
  cwd: string;
  args: string[];
  /** bridge 内部生成的续接 argv；不是平台 args，不参与受管模式的自定义参数拒绝。 */
  internalArgs?: string[];
  prompt?: string;
  timeoutMs?: number;
  allowedCwd?: string[];
  /** 并发上限（缺省 DEFAULT_MAX_TASKS） */
  maxConcurrent?: number;
  /** 队列长度上限（缺省 DEFAULT_MAX_QUEUED；0 表示不允许排队） */
  maxQueued?: number;
  /** 终态时回传 cwd 下的 unified diff（P0-6） */
  captureDiff?: boolean;
  /** diff 文本上限（字节）；缺省用 git.ts 的 DEFAULT_DIFF_MAX_BYTES */
  diffMaxBytes?: number;
  /**
   * 本任务是否申请交互（决定审批请求转人工还是直接 decline）。
   *
   * ⚠️ 它**不**控制 stdin：headless 子进程恒 `stdio[0]='ignore'`，交互一律走
   * ACP / app-server / stream-json 协议（见 `launch` 里的说明）。
   */
  interactive?: boolean;
  /** 走该 CLI 的原生 ACP 会话 */
  acp?: boolean;
  /** 走 Codex app-server JSON-RPC */
  appServer?: boolean;
  /** 走 Claude 双向 stream-json（支持 same-turn steer） */
  claudeStream?: boolean;
  /** 交互所属原 Session（conversation 的执行 ID 是 session__turn）。 */
  interactionSessionId?: string;
  interactionTenantId?: string;
  /** ACP 启动方式；缺省回落 CodeBuddy */
  acpSpec?: AcpAgentSpec;
  /** ACP 续接已有 native session */
  nativeSessionId?: string;
  /**
   * ACP 续接失败时的兜底 prompt（完整 transcript）。
   * 只有「本来要续、结果没续上」才会用到 —— 否则新会话会静默丢掉此前全部上下文。
   */
  replayPrompt?: string;
  /** 请求的权限模式（1.0）；缺省由本机 permission_policy 决定 */
  permissionMode?: PermissionMode;
  /** 本机权限策略（缺省 default） */
  permissionPolicy?: PermissionPolicyName;
  /** 本机是否声明运行在外部沙箱内（CodeBuddy full 必需） */
  externalSandbox?: boolean;
}

/** 终态附加信息。diff 三个字段只在 captureDiff 开启时出现 */
export interface TaskFinishInfo {
  exitCode?: number;
  error?: string;
  /** 机器可读错误码（受控枚举，见 core/errors.ts） */
  errorCode?: BridgeErrorCode;
  diff?: string;
  changedFiles?: string[];
  diffTruncated?: boolean;
  /** 最终回答文本（步骤流解析器从 result 事件提取；仅结构化输出的工具） */
  result?: string;
  /** 排队语义（v1 兼容：status 仍为 running，phase 区分排队/执行中） */
  phase?: TaskPhase;
  /** 队列位次（从 1 开始） */
  queuePosition?: number;
  /** 本次任务实际采用的权限模式（bridge 的选择，不是 CLI 权限证明） */
  permissionMode?: PermissionMode;
  /** 等待交互时的当前 requestId；回到 running / 终态时必须为空 */
  interactionId?: string;
  /** ACP session/prompt 的结算原因（拿到才回显） */
  stopReason?: StopReason;
  /** canonical feed 未完整收尾（上游回合异常结束 / 输出无法收尾） */
  feedIncomplete?: boolean;
}

export interface TaskHooks {
  onLog: (stream: 'stdout' | 'stderr', data: string) => void;
  onStatus: (status: TaskStatus, info?: TaskFinishInfo) => void;
  /** spawn/adapter 前的同步持久化闸门；返回 false 时零副作用启动。 */
  onBeforeLaunch?: () => boolean;
  /** 步骤流（仅适配器声明了 steps 格式的工具会触发；seq 从 1 单调递增，finished 按 ref 配对不另占号） */
  onStep?: (step: ParsedStep & { seq: number }) => void;
  /**
   * 中间 agent 消息（4.7）：headless 结构化输出里已定稿的 assistant 文本
   *（此前只埋在 task_log）。messageId 优先用 CLI 原生 ID，缺省由调用方生成稳定 ID；
   * 消息是 complete 语义（一次到位），流式增量走 partialMessages 通道。
   */
  onAgentMessage?: (message: { messageId?: string; text: string }) => void;
  /** 待办计划快照（TodoWrite 类工具；每次调用覆盖，items 为空表示无计划能力/未调用） */
  onPlan?: (items: PlanItem[]) => void;
  /** CLI 事件里首次出现的原生 session/thread/conversation id */
  onSession?: (nativeSessionId: string) => void;
  /** ACP 权限请求（由调用方落库并上行 task_interaction_request） */
  onInteraction?: (request: AcpInteractionRequest) => void;
  /**
   * 持久授权查询（1.0 approval ledger）。
   *
   * 由调用方持有账本存储，supervisor 只问「这条请求有没有人工授权过」——
   * 返回命中的 optionId 就直接批，返回 undefined 就走正常交互。
   * ⚠️ 只有 permissionMode=default 时才问（full 残留请求必须问人，见 permission-ledger 规则）。
   */
  onApprovalLookup?: (input: ApprovalLookupInput) => ApprovalLookupResult | undefined;
}

/** 账本查询入参：只带结构化字段，不带模型输出文本 */
export interface ApprovalLookupInput {
  agentType: string;
  cwd: string;
  permissionMode: PermissionMode;
  toolCall: unknown;
  options: unknown;
}

export interface ApprovalLookupResult {
  /** 实际要回给 ACP 的 optionId（必须是请求里真实存在的选项） */
  optionId: string;
  approvalId: string;
}

export interface AcpInteractionRequest {
  requestId: string;
  kind: 'permission' | 'form';
  payload: Record<string, unknown>;
  expiresAt?: string;
}

export interface InteractionAnswer {
  /** ACP permission 选项；空表示拒绝 */
  optionId?: string;
  /** form 的接受/拒绝/取消 */
  action?: 'accept' | 'decline' | 'cancel';
  /** MCP form / elicitation 的结构化内容 */
  content?: Record<string, unknown>;
}

export interface TaskHandle {
  taskId: string;
  cancel: () => void;
  done: Promise<TaskStatus>;
  /**
   * 向 headless 子进程 stdin 写一行（历史 API）。
   *
   * headless 通道的 stdin 恒 `ignore`（见 `launch` 里的说明），因此对 headless 任务
   * **总是返回 false**；真实交互走 `respondInteraction`（ACP / app-server 协议应答）。
   */
  write?: (line: string) => boolean;
  /** 交互响应：等待 adapter 实际写入；false/异常均表示交付结果不确定。 */
  respondInteraction?: (requestId: string, answer?: InteractionAnswer) => boolean | Promise<boolean>;
  /** 仅原生支持 same-turn steer 的适配器（如 Codex app-server）存在 */
  steer?: (text: string) => Promise<boolean>;
}

/** 显式状态机：settled 是吸收态 */
export type TaskState = 'queued' | 'running' | 'waiting' | 'settled';

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const KILL_GRACE_MS = 2000;
/** 默认并发上限：30（2026-10-24 面向平台批量调度调整，原为 3）；防呆夹取上限见 config.ts */
export const DEFAULT_MAX_TASKS = 30;
/** 默认队列上限：再长的排队对调用方也没意义（2026-10-24 由 32 调整为 60） */
export const DEFAULT_MAX_QUEUED = 60;
/** 单个任务最多上行多少条 codex 非内容通知（去重后）；重连风暴时防刷屏 */
const CODEX_NOTICE_LIMIT = 40;

/**
 * 失败分类用输出尾部的上限（字符）。
 * 只用来读「上下文超限」这类终局文案，2 KiB 足够（各家报错都在一两行内）。
 */
export const CONTEXT_TAIL_LIMIT = 2048;

/** 追加到有界尾部缓冲：超出即从头部截掉 */
function appendTail(tail: string, text: string): string {
  const next = tail + text;
  return next.length > CONTEXT_TAIL_LIMIT ? next.slice(next.length - CONTEXT_TAIL_LIMIT) : next;
}

interface Entry {
  req: RunTaskRequest;
  hooks: TaskHooks;
  cmd: string;
  argv: string[];
  state: TaskState;
  status: TaskStatus;
  /** 终态快照（含 diff 产物）：settle 时计算一次，幂等重放直接复用，不重跑 git */
  finishInfo?: TaskFinishInfo;
  /** 步骤流格式（适配器声明）；有值时 launch 挂解析器 */
  stepFormat?: StepFormat;
  /** 步骤解析器实例（launch 时创建；settle 时用于提取最终回答） */
  stepParser?: import('../adapters/step-parsers.js').StepParser;
  /** 已发出的步骤数（seq 分配器） */
  stepSeq: number;
  /** 本次任务采用的权限模式（1.0） */
  permissionMode: PermissionMode;
  /** 需要固定注入的环境变量（目前只有 CodeBuddy full 的 CODEBUDDY_IS_SANDBOX） */
  permissionEnv?: Record<string, string>;
  /** agy 等外部 CLI 使用显式/Windows 系统代理 */
  preferSystemProxy?: boolean;
  /** ref → seq：finished 事件配对回同一步，不另占序号（tool_use/tool_result 不拆成两步） */
  stepRefs: Map<string, number>;
  /** 未登录挂死守卫（适配器声明；agy 实测：不 kill 会干等到总超时） */
  authGuard?: AgentDef['authGuard'];
  /** 守卫匹配用的 stderr 有界缓冲（防模式跨 chunk 断裂） */
  authStderr: string;
  /**
   * 输出尾部有界缓冲（stdout+stderr 合计 ≤2 KiB），**只用于失败分类**。
   *
   * 为什么需要：很多 CLI 把「上下文超限」报在 stderr 上，而结算时能拿到的
   * `info.error` 往往只有一句「CLI 退出码 1」——没有这个尾部就永远判不出超限
   * （见 core/context-overflow.ts）。不上行、不落库，终态即随 entry 回收。
   */
  tail: string;
  child?: ChildProcess;
  acpAbort?: AbortController;
  acpPermissions?: Map<string, (answer?: InteractionAnswer) => Promise<boolean>>;
  /** waiting 时当前交互；只保存 requestId，不保存响应内容。 */
  interactionId?: string;
  codexSteer?: (text: string) => Promise<void>;
  /** codex 非内容型通知（error/warning）已上行的去重键；有界，防重连风暴刷屏 */
  codexNotices?: Set<string>;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  resolve: (s: TaskStatus) => void;
  done: Promise<TaskStatus>;
}

/** 容量水位快照：每次调度状态变化后广播一次（A2） */
export interface CapacitySnapshot {
  running: number;
  queued: number;
  maxTasks: number;
  maxQueued: number;
}

/**
 * `child` 是否位于 `parent` 目录之下（含相等）。
 * 必须按目录边界判断；Windows 路径大小写不敏感，比较前统一折叠。
 */
export function isUnder(child: string, parent: string): boolean {
  const fold = (p: string): string => {
    const abs = resolvePath(p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

function buildArgs(template: string[], prompt?: string): string[] {
  return template.map((a) => (prompt === undefined ? a : a.replaceAll('{{prompt}}', prompt)));
}

/**
 * 认证守卫的有界缓冲匹配（纯函数便于单测）：
 * 模式可能跨 stderr 分片断裂，所以合并最近 4KB 再匹配；命中即「未登录/凭据失效」。
 */
export function feedAuthGuard(
  guard: { patterns: RegExp[]; hint: string },
  buffer: string,
  text: string,
): { buffer: string; hit: boolean } {
  const merged = (buffer + text).slice(-4096);
  return { buffer: merged, hit: guard.patterns.some((re) => re.test(merged)) };
}

/**
 * 从 stdout 分片中提取首个原生 session id。
 * 字段可能跨 chunk（DSH 实测为 sessionId）；只保留最近 512 字符作为拼接尾，命中后停止扫描。
 */
export function createNativeSessionDetector(): (chunk: string) => string | undefined {
  let tail = '';
  let found = false;
  return (chunk) => {
    if (found) return undefined;
    const merged = tail + chunk;
    const match = /"(?:session_id|thread_id|conversation_id|sessionId|sessionID)"\s*:\s*"([A-Za-z0-9._:-]{1,200})"/.exec(
      merged,
    );
    if (match?.[1]) {
      found = true;
      return match[1];
    }
    tail = merged.slice(-512);
    return undefined;
  };
}

function timeoutOf(req: RunTaskRequest): number {
  return req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function diffOf(req: RunTaskRequest): DiffCapture | undefined {
  if (!req.captureDiff) return undefined;
  return captureWorktreeDiff(req.cwd, { maxBytes: req.diffMaxBytes });
}

/** 把 diff 并进终态信息（无 diff 时不给调用方发空字段噪音） */
function withDiff(req: RunTaskRequest, info: TaskFinishInfo): TaskFinishInfo {
  const cap = diffOf(req);
  if (!cap) return info;
  return { ...info, diff: cap.diff, changedFiles: cap.changedFiles, diffTruncated: cap.truncated };
}

/** 命令与参数解析失败时，同时给出人类可读串与机器可读码 */
function reject(
  req: RunTaskRequest,
  hooks: TaskHooks,
  code: BridgeErrorCode,
  message: string,
): TaskHandle {
  hooks.onStatus('failed', withDiff(req, { error: message, errorCode: code }));
  return { taskId: req.taskId, cancel: () => undefined, done: Promise.resolve('failed' as TaskStatus) };
}

export class TaskSupervisor {
  /** 每个调度域独立的交互状态/交付 flight；不得使用模块级共享 Broker。 */
  readonly interactions = new InteractionBroker();
  private running = 0;
  private readonly queue: Entry[] = [];
  private maxTasks: number;
  /**
   * 活跃任务跟踪表（WS 重发同一 taskId 不重复 spawn 的内存快路径）。
   *
   * 只保留 queued/running/waiting 条目：settle 在 hooks.onStatus（生产 = SQLite 落库）
   * 同步返回后即回收，容量天然有界（并发 + 队列上限）。
   * 终态后的同 ID 重发由调度入口的 SQLite 前置检查拦截回放（task-dispatch 的
   * getSession 终态回放 / control-plane 的 runIdempotent / conversation 的每轮新 executionId）
   * —— SQLite 是唯一权威，这里不再保留 MAX_TRACKED 式的终态容量淘汰。
   */
  private readonly byId = new Map<string, Entry>();
  /** 最近一次提交生效的队列上限（上限本是请求级字段，水位上报取最近值） */
  private lastMaxQueued = DEFAULT_MAX_QUEUED;
  private readonly capacityListeners = new Set<(s: CapacitySnapshot) => void>();
  /**
   * 运行中任务的半截文本（`task_snapshot.partialMessages`）。
   * 只放内存、只放**当前**回合，终态即清 —— 理由见 `core/partial-messages.ts` 的注释。
   */
  private readonly partials = new PartialMessageTracker();

  constructor(maxConcurrent = DEFAULT_MAX_TASKS) {
    this.maxTasks = maxConcurrent > 0 ? Math.floor(maxConcurrent) : DEFAULT_MAX_TASKS;
  }

  /**
   * 半截消息读取入口（`get_task` 用）。
   * 放在实例上而不是模块级变量：调度状态必须可实例化，两个调度域不能互相串数据。
   */
  listPartialMessages(taskId: string): SnapshotPartialMessage[] {
    return this.partials.list(taskId);
  }

  /**
   * 三条流式通道（ACP `agent_message_chunk` / codex `item/agentMessage/delta` /
   * claude stream `text` block）的唯一写入口 —— 收敛到一个方法，才不会有的通道记、有的忘。
   */
  recordPartialText(taskId: string, text: string): void {
    this.partials.append(taskId, text);
  }

  get runningCount(): number {
    return this.running;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** 内存中跟踪的任务数（活跃 + 尚未被落库回调释放的瞬态）。观测/测试用；终态语义见 byId 注释。 */
  get trackedTaskCount(): number {
    return this.byId.size;
  }

  /** 订阅容量水位（每次调度状态变化后回调一次；回调异常不影响调度） */
  subscribeCapacity(fn: (s: CapacitySnapshot) => void): () => void {
    this.capacityListeners.add(fn);
    return () => this.capacityListeners.delete(fn);
  }

  capacitySnapshot(): CapacitySnapshot {
    return {
      running: this.running,
      queued: this.queue.length,
      maxTasks: this.maxTasks,
      maxQueued: this.lastMaxQueued,
    };
  }

  private notifyCapacity(): void {
    const snap = this.capacitySnapshot();
    for (const fn of this.capacityListeners) {
      try {
        fn(snap);
      } catch {
        /* 观察者绝不阻断调度 */
      }
    }
  }

  /** 登记活跃任务（终态在 settle 的落库回调后回收，见 settle()） */
  private track(entry: Entry): void {
    this.byId.set(entry.req.taskId, entry);
  }

  /** 取消逻辑收口：首个句柄与幂等重放句柄共用（取消本身是幂等的） */
  private cancelEntry(entry: Entry): void {
    if (entry.state === 'settled') return;
    if (entry.state === 'queued') {
      this.settle(entry, 'cancelled', { error: '任务已取消（排队中被取消）', errorCode: 'cancelled' });
      return;
    }
    entry.status = 'cancelled';
    this.terminate(entry);
  }

  /**
   * 幂等重放（A1）：同一 taskId 重复提交时不再 spawn。
   * 未终态回当前状态快照。settled 分支正常情况下不可达（终态条目在落库回调后即回收），
   * 仅作为直接调用方无 SQLite 前置时的防御保留；生产幂等以 SQLite 为权威（见 byId 注释）。
   */
  private replay(entry: Entry, hooks: TaskHooks): TaskHandle {
    if (entry.state === 'settled') {
      hooks.onStatus(entry.status, entry.finishInfo ?? {});
    } else if (entry.state === 'queued') {
      hooks.onStatus('running', {
        phase: 'queued',
        queuePosition: this.queue.indexOf(entry) + 1,
        error: '任务已存在（幂等去重，未重复执行）',
      });
    } else if (entry.state === 'waiting') {
      hooks.onStatus('running', {
        phase: 'waiting_interaction',
        interactionId: entry.interactionId,
        permissionMode: entry.permissionMode,
      });
    } else {
      hooks.onStatus('running');
    }
    return {
      taskId: entry.req.taskId,
      cancel: () => this.cancelEntry(entry),
      done: entry.done,
      write: (line: string) => this.writeTo(entry, line),
      respondInteraction: (requestId: string, answer?: InteractionAnswer) =>
        this.respondAcp(entry, requestId, answer),
      steer: (text: string) => this.steerEntry(entry, text),
    };
  }

  /** 提交任务：校验 → 排队或立即启动。返回句柄（可取消、可 await 终态） */
  submit(req: RunTaskRequest, hooks: TaskHooks): TaskHandle {
    // 幂等去重在最前：重发一律回放，不重复校验、不重复 spawn
    const dup = this.byId.get(req.taskId);
    if (dup) return this.replay(dup, hooks);

    // 新一次运行从干净桶开始：同一 taskId 被重试/复用时，不能带上一次的半截文本。
    // 放在 dup 之后 —— 回放路径不该清掉正在跑的那个任务的累积。
    this.partials.clear(req.taskId);

    const def = agentDefOf(req.agentType);
    if (!def) {
      return reject(req, hooks, 'tool_not_installed', `不支持的工具：${req.agentType}`);
    }
    if (!existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) {
      return reject(req, hooks, 'cwd_missing', `工作目录不存在：${req.cwd}`);
    }
    if (req.allowedCwd?.length && !req.allowedCwd.some((root) => isUnder(req.cwd, root))) {
      return reject(req, hooks, 'cwd_not_allowed', `工作目录不在允许范围内：${req.cwd}`);
    }

    // 权限策略（1.0）：在 spawn 前定判，拒绝即不产生任何子进程；不允许静默降级到 default
    const permission = decidePermissionMode({
      policy: req.permissionPolicy,
      requested: req.permissionMode,
      args: req.args,
      fullArgs: def.fullArgs,
      kind: def.kind,
      externalSandbox: req.externalSandbox,
    });
    if (!permission.ok) {
      return reject(req, hooks, permission.code, permission.message);
    }

    // 非 headless 通道尚未实现 full 权限映射：必须在解析/启动 CLI 前拒绝，不能丢掉 fullArgs 后按 default 跑。
    if (permission.mode === 'full' && (req.acp || req.appServer || req.claudeStream)) {
      return reject(
        req,
        hooks,
        'permission_mode_unsupported',
        '该执行通道尚未实现 full 权限映射；请使用 headless default/full 组合，不以 default 静默降级',
      );
    }

    const template = taskArgsForPermission(def, permission.mode);
    /**
     * `{{prompt}}` 的替换必须覆盖**两条来源**，不能只处理 adapter 模板：
     *  1. 平台可以自己传 args，协议明写「平台可用 {{prompt}} 占位」（protocol.ts RunTaskCommand.args）；
     *  2. 会话续接是 bridge 自己拼的 `resumeArgs`（conversation.ts 只替换 {{sessionId}}）。
     * 原来只在「args 为空」时替换，这两条来源里的占位符会被原样交给 CLI ——
     * 表现是任务照常 success，但模型收到的是字面量 `{{prompt}}`，用户这一轮说的话根本没进去。
     */
    const selectedArgs = req.args.length > 0 ? req.args : (req.internalArgs ?? template);
    const args = buildArgs(selectedArgs, req.prompt ?? '');
    let cmd: string;
    let argv: string[];
    if (def.npxSpec && !resolveBin([def.bin, ...(def.altBins ?? [])])) {
      cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      argv = ['-y', def.npxSpec, ...args];
    } else {
      const binPath = resolveBin([def.bin, ...(def.altBins ?? [])]);
      if (!binPath) {
        return reject(req, hooks, 'tool_not_installed', `本机没有安装 ${def.display}（未找到 ${def.bin}）`);
      }
      cmd = binPath;
      argv = args;
    }

    if (req.maxConcurrent && req.maxConcurrent > 0) this.maxTasks = Math.floor(req.maxConcurrent);
    const maxQueued =
      req.maxQueued !== undefined && req.maxQueued >= 0 ? Math.floor(req.maxQueued) : DEFAULT_MAX_QUEUED;
    this.lastMaxQueued = maxQueued;

    if (this.running >= this.maxTasks && this.queue.length >= maxQueued) {
      return reject(
        req,
        hooks,
        'device_busy',
        `任务队列已满（并发 ${this.maxTasks}，排队 ${maxQueued}），请稍后重试`,
      );
    }

    let resolve!: (s: TaskStatus) => void;
    const done = new Promise<TaskStatus>((r) => {
      resolve = r;
    });
    const entry: Entry = {
      req,
      hooks,
      cmd,
      argv,
      state: 'queued',
      status: 'running',
      stepFormat: def.steps,
      stepSeq: 0,
      permissionMode: permission.mode,
      permissionEnv: permissionEnvFor(def.kind, permission.mode),
      preferSystemProxy: def.preferSystemProxy,
      stepRefs: new Map(),
      authGuard: def.authGuard,
      authStderr: '',
      tail: '',
      resolve,
      done,
    };
    this.track(entry);

    // timeoutMs 从入队开始算：排队也是调用方的等待时间
    entry.timer = setTimeout(() => {
      if (entry.state === 'settled') return;
      if (entry.state === 'queued') {
        this.settle(entry, 'timeout', { error: `排队超时（等待超过 ${timeoutOf(req)}ms）`, errorCode: 'timeout' });
        return;
      }
      entry.status = 'timeout';
      this.terminate(entry);
    }, timeoutOf(req));

    if (this.running < this.maxTasks) this.launch(entry);
    else {
      this.queue.push(entry);
      hooks.onStatus('running', {
        phase: 'queued',
        queuePosition: this.queue.length,
        permissionMode: permission.mode,
        error: `排队中（第 ${this.queue.length} 位，并发上限 ${this.maxTasks}）`,
      });
    }
    this.notifyCapacity();

    return {
      taskId: req.taskId,
      cancel: () => this.cancelEntry(entry),
      done,
      write: (line: string) => this.writeTo(entry, line),
      respondInteraction: (requestId: string, answer?: InteractionAnswer) =>
        this.respondAcp(entry, requestId, answer),
      steer: (text: string) => this.steerEntry(entry, text),
    };
  }

  private steerEntry(entry: Entry, text: string): Promise<boolean> {
    if (entry.state !== 'running' || !entry.codexSteer) return Promise.resolve(false);
    return entry.codexSteer(text).then(
      () => true,
      () => false,
    );
  }

  private waitForInteraction(entry: Entry, requestId: string): void {
    if (entry.state !== 'running') return;
    entry.state = 'waiting';
    entry.interactionId = requestId;
    // waiting 仍占 running 名额，总 timeout 不从新计时。
    entry.hooks.onStatus('running', {
      phase: 'waiting_interaction',
      interactionId: requestId,
      permissionMode: entry.permissionMode,
    });
  }

  private async respondAcp(entry: Entry, requestId: string, answer?: InteractionAnswer): Promise<boolean> {
    const deliver = entry.acpPermissions?.get(requestId);
    if (!deliver) return false;
    entry.acpPermissions?.delete(requestId);
    let delivered = false;
    try {
      delivered = await deliver(answer);
    } catch {
      delivered = false;
    }
    return delivered;
  }

  /** Broker 在 result 落库并上行后调用，保证 result 先于 running。 */
  completeInteraction(taskId: string, requestId: string): void {
    const entry = [...this.byId.values()].find(
      (item) => item.interactionId === requestId && (item.req.interactionSessionId ?? item.req.taskId) === taskId,
    );
    if (!entry || entry.state !== 'waiting') return;
    entry.state = 'running';
    entry.interactionId = undefined;
    entry.hooks.onStatus('running', { phase: 'running', permissionMode: entry.permissionMode });
  }

  /** 首次 delivery unknown 的 result 上行后，再终止对应回合。 */
  failInteraction(taskId: string, requestId: string): void {
    const entry = [...this.byId.values()].find(
      (item) => item.interactionId === requestId && (item.req.interactionSessionId ?? item.req.taskId) === taskId,
    );
    if (!entry || entry.state === 'settled') return;
    entry.status = 'failed';
    entry.acpAbort?.abort();
    this.settle(entry, 'failed', {
      error: '交互响应交付结果不确定，已终止回合且禁止重试',
      errorCode: 'interaction_delivery_unknown',
    });
  }

  /**
   * 单次交互等待到期且无 reject_once 可选（spec「等待状态、超时与取消」）：
   * 已以 cancelled outcome 完成请求，这里取消回合并以 interaction_timeout 结算。
   */
  expireInteraction(taskId: string, requestId: string): void {
    const entry = [...this.byId.values()].find(
      (item) => item.interactionId === requestId && (item.req.interactionSessionId ?? item.req.taskId) === taskId,
    );
    if (!entry || entry.state === 'settled') return;
    entry.status = 'cancelled';
    entry.acpAbort?.abort();
    this.settle(entry, 'cancelled', {
      error: `交互等待超时（${requestId}），已取消回合`,
      errorCode: 'interaction_timeout',
    });
  }

  private writeTo(entry: Entry, line: string): boolean {
    const stdin = entry.child?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    try {
      return stdin.write(line.endsWith('\n') ? line : `${line}\n`);
    } catch {
      return false;
    }
  }

  // ---------- 内部 ----------

  private pump(): void {
    while (this.running < this.maxTasks && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) return;
      this.launch(next);
    }
  }

  private launch(entry: Entry): void {
    if (entry.state !== 'queued') return;
    if (entry.hooks.onBeforeLaunch && !entry.hooks.onBeforeLaunch()) {
      this.settle(entry, 'failed', {
        error: 'Turn 启动前持久化闸门未通过，未启动 CLI',
        errorCode: 'internal',
      });
      return;
    }
    entry.state = 'running';
    this.running += 1;

    if (entry.req.acp) {
      this.launchAcp(entry);
      return;
    }
    if (entry.req.appServer) {
      this.launchAppServer(entry);
      return;
    }
    if (entry.req.claudeStream) {
      this.launchClaudeStream(entry);
      return;
    }

    // 子进程环境恒为 bridge 自身进程环境：平台**不能**注入环境变量。
    // 唯一例外是 full 模式下 bridge 自己固定注入的那一个键（CodeBuddy 的沙箱声明）。
    //
    // 但「bridge 自身环境」里还混着宿主注入的会话上下文（CODEBUDDY_SESSION_ID /
    // CODEBUDDY_MCP_CONFIG / SERVER__PORT…），子 CLI 继承会冒充宿主会话：
    // 实测 codebuddy `-p` 因此去抢宿主端口，`listen EADDRINUSE 127.0.0.1:57193` 直接失败。
    // 清理表与 ACP 通道共用（adapters/host-env.ts），认证令牌等例外也在那里声明。
    const baseEnv = withoutHostEnv(process.env);
    const childEnvBase = entry.permissionEnv ? { ...baseEnv, ...entry.permissionEnv } : baseEnv;
    const childEnv = entry.preferSystemProxy ? externalProxyEnv(childEnvBase) : childEnvBase;
    const shim = isWinShim(entry.cmd);
    /**
     * headless 子进程的 stdin **恒为 ignore**，即使 `interactive=true`。
     *
     * 受控交互的读写通道是协议（ACP `session/request_permission`、app-server 的
     * `item/…/requestApproval` 系列、claude stream-json 控制帧），**不是**子进程 stdin ——
     * 没有任何适配器从 stdin 读审批答复。而给 stdin 打开 pipe 会直接毁掉那些
     * 「先等 stdin EOF 再开工」的 CLI：实测 `codex exec --json` 在 `ignore` 下 20s 完成并
     * 输出 879 字节，改成 pipe 且不写入内容后 25s **零字节**、进程不退出
     * （2026-11-28 复现的「codex 交互模式回合挂死」就是这条：外部只看到 heartbeat）。
     * 规格也写明：除受控交互适配器外，子进程 stdin SHALL 保持 ignore。
     */
    const stdinMode = 'ignore';
    const child: ChildProcess = shim
      ? spawn(buildWinCommandLine(entry.cmd, entry.argv), {
          cwd: entry.req.cwd,
          env: childEnv,
          shell: true,
          windowsHide: true,
          stdio: [stdinMode, 'pipe', 'pipe'],
        })
      : spawn(entry.cmd, entry.argv, {
          cwd: entry.req.cwd,
          env: childEnv,
          windowsHide: true,
          stdio: [stdinMode, 'pipe', 'pipe'],
        });
    entry.child = child;

    // 步骤流解析器（B 批次）：仅声明了 steps 格式的工具；stdout 原样上行 task_log 不受影响
    const stepParser = entry.stepFormat ? createStepParser(entry.stepFormat) : undefined;
    entry.stepParser = stepParser;

    const feedSteps = (text: string): void => {
      // 终态后不再产生 step/plan 上行：close 的 EOF flush 在 settle 之前喂（顺序见下方 close 回调），
      // 守卫只拦「settle 之后才到达的迟到输出」——「拒绝终态后 log/step」的第一道闸门。
      if (entry.state === 'settled') return;
      if (!stepParser) return;
      // 即使调用方不关心 onStep，也必须喂解析器：finalOutcome/finalText 是任务真实性的独立闸门。
      for (const step of stepParser.feed(text)) {
        const onStep = entry.hooks.onStep;
        if (!onStep) continue;
        // finished 按 ref 配对回 started 的序号：tool_use/tool_result 是同一步的两半。
        const paired = step.state === 'finished' && step.ref !== undefined ? entry.stepRefs.get(step.ref) : undefined;
        if (paired !== undefined) {
          onStep({ ...step, seq: paired });
          continue;
        }
        entry.stepSeq += 1;
        if (step.ref !== undefined) entry.stepRefs.set(step.ref, entry.stepSeq);
        onStep({ ...step, seq: entry.stepSeq });
      }
      // 中间 agent 消息（4.7）：drain 语义，取走即清空；终态后由守卫拦住不再产生
      const onAgentMessage = entry.hooks.onAgentMessage;
      if (onAgentMessage && stepParser.drainMessages) {
        for (const message of stepParser.drainMessages()) onAgentMessage(message);
      }
      const plan = stepParser.plan?.();
      if (plan && entry.hooks.onPlan) entry.hooks.onPlan(plan);
    };

    const detectNativeSession = createNativeSessionDetector();
    const emit = (stream: 'stdout' | 'stderr', buf: Buffer): void => {
      // authGuard 命中路径是 kill 与 settle 同步连发：kill 生效前残余 data 已入队的
      // 输出会在 settle 之后到达这里 —— 终态后一律不再上行（Emitter.settled 只是纵深防御）。
      if (entry.state === 'settled') return;
      const text = buf.toString('utf8');
      // 失败分类用的输出尾部（有界，不上行）：很多 CLI 把「上下文超限」只写在 stderr 上
      entry.tail = appendTail(entry.tail, text);
      if (stream === 'stdout' && entry.hooks.onSession) {
        const nativeSessionId = detectNativeSession(text);
        if (nativeSessionId) entry.hooks.onSession(nativeSessionId);
      }
      for (const piece of chunkLog(text)) entry.hooks.onLog(stream, piece);
      // 未登录挂死守卫（agy 实测）：认证提示在 stderr 上**立即**出现，先于任何 stdout 事件；
      // 不 kill 的话它会静默等 60s、吐完 status:"ERROR" 还不退出（干等总超时）。
      if (stream === 'stderr' && entry.authGuard) {
        const fed = feedAuthGuard(entry.authGuard, entry.authStderr, text);
        entry.authStderr = fed.buffer;
        if (fed.hit) {
          if (entry.child) killCliProcess(entry.child, entry.cmd);
          this.settle(entry, 'failed', { error: entry.authGuard.hint, errorCode: 'tool_no_credentials' });
        }
      }
      if (stream === 'stdout') feedSteps(text);
    };
    child.stdout?.on('data', (b: Buffer) => emit('stdout', b));
    child.stderr?.on('data', (b: Buffer) => emit('stderr', b));

    child.on('error', (e) =>
      this.settle(entry, 'failed', {
        error: `进程启动失败：${e.message}`,
        errorCode: 'agent_error',
      }),
    );
    child.on('close', (code) => {
      // EOF 未必带末尾换行；只补解析器输入，不伪造一条 task_log。
      feedSteps('\n');
      if (entry.status === 'timeout') {
        this.settle(entry, 'timeout', {
          exitCode: code ?? undefined,
          error: '任务超时，进程已终止',
          errorCode: 'timeout',
        });
      } else if (entry.status === 'cancelled') {
        this.settle(entry, 'cancelled', {
          exitCode: code ?? undefined,
          error: '任务已取消',
          errorCode: 'cancelled',
        });
      } else if (code === 0) {
        // 退出码 0 ≠ 完成（agy 官方文档：--print-timeout 到期以 0 结束并给部分结果）。
        // 解析器见过流内终态且明示失败时推翻「成功」；没见过终态的流维持退出码语义。
        const outcome = entry.stepParser?.finalOutcome?.();
        if (outcome && outcome.ok === false) {
          this.settle(entry, 'failed', {
            exitCode: 0,
            error: outcome.error ?? 'CLI 报告本回合未成功完成',
            errorCode: 'agent_error',
            ...(outcome.result !== undefined ? { result: outcome.result } : {}),
          });
        } else {
          this.settle(entry, 'success', { exitCode: 0 });
        }
      } else {
        // agy 类：退出码非 0 时流内终态错误（如 status=ERROR 的信封 error）比「退出码 N」可操作得多；
        // 其他解析器不实现 finalOutcome，维持原文案不变
        const outcome = entry.stepParser?.finalOutcome?.();
        this.settle(entry, 'failed', {
          exitCode: code ?? undefined,
          error: outcome?.error ?? `CLI 退出码 ${code ?? 'unknown'}`,
          errorCode: 'agent_error',
          ...(outcome?.result !== undefined ? { result: outcome.result } : {}),
        });
      }
    });

    entry.hooks.onStatus('running');
  }

  private launchClaudeStream(entry: Entry): void {
    const controller = new AbortController();
    entry.acpAbort = controller;
    entry.hooks.onStatus('running');

    void runClaudeStreamPrompt({
      // entry.cmd 是 startTask 里 resolveBin 出来的绝对路径。不传的话 adapter 会默认 'claude'，
      // 于是 qoder-cli 的 stream 通道会去跑 claude 本体 —— 看起来「成功」，其实是别的工具在答。
      command: entry.cmd,
      cwd: entry.req.cwd,
      prompt: entry.req.prompt ?? '',
      nativeSessionId: entry.req.nativeSessionId,
      timeoutMs: timeoutOf(entry.req),
      signal: controller.signal,
      onSession: (sessionId) => entry.hooks.onSession?.(sessionId),
      onUpdate: (event) => {
        // 终态后 stream-json 通道的残余 assistant 消息不再上行（同 onAcpUpdate 的在途窗口）
        if (entry.state === 'settled') return;
        if (event['type'] !== 'assistant') return;
        const message = event['message'] as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          const item = block as Record<string, unknown>;
          const blockText = claudeBlockText(item);
          if (blockText !== undefined) {
            entry.hooks.onLog('stdout', blockText);
            // claude stream-json 给的是整条 assistant 消息（不是 token 增量），
            // 但相对「回合终态」它仍是半截 —— 刷新后照样该看得到
            this.recordPartialText(entry.req.taskId, blockText);
          }
          if (!entry.hooks.onStep) continue;
          if (item['type'] === 'tool_use' && typeof item['name'] === 'string') {
            entry.stepSeq += 1;
            const ref = typeof item['id'] === 'string' ? item['id'] : undefined;
            if (ref) entry.stepRefs.set(ref, entry.stepSeq);
            entry.hooks.onStep({
              action: item['name'],
              label: typeof item['input'] === 'object' ? JSON.stringify(item['input']).slice(0, 200) : undefined,
              state: 'started',
              ref,
              seq: entry.stepSeq,
              // 富 toolCall（4.8）：与 headless 解析器同一映射（kind/locations；rawInput 不上行）
              toolCall: claudeToolCallOf(item['name'], item['id'], item['input']),
            });
          }
          if (item['type'] === 'tool_result' && typeof item['tool_use_id'] === 'string') {
            const seq = entry.stepRefs.get(item['tool_use_id']);
            if (seq !== undefined) {
              entry.hooks.onStep({
                action: 'tool_result',
                state: 'finished',
                ok: item['is_error'] !== true,
                ref: item['tool_use_id'],
                seq,
              });
            }
          }
        }
      },
    })
      .then((result) => {
        if (entry.state === 'settled') return;
        this.settle(entry, 'success', { exitCode: 0, result: result.text });
      })
      .catch((error) => {
        if (entry.state === 'settled') return;
        if (entry.status === 'cancelled') {
          this.settle(entry, 'cancelled', { error: '任务已取消', errorCode: 'cancelled' });
          return;
        }
        if (entry.status === 'timeout') {
          this.settle(entry, 'timeout', { error: '任务超时，Claude stream 已中断', errorCode: 'timeout' });
          return;
        }
        this.settle(entry, 'failed', {
          error: (error as Error).message,
          errorCode: 'agent_error',
        });
      });
  }

  private launchAppServer(entry: Entry): void {
    const controller = new AbortController();
    entry.acpAbort = controller;
    entry.acpPermissions = new Map();
    entry.hooks.onStatus('running');

    void runCodexPrompt({
      // 同 launchClaudeStream：不让 adapter 用裸名 'codex' 依赖 PATH
      command: entry.cmd,
      cwd: entry.req.cwd,
      prompt: entry.req.prompt ?? '',
      nativeThreadId: entry.req.nativeSessionId,
      timeoutMs: timeoutOf(entry.req),
      signal: controller.signal,
      onTurn: (turn) => {
        entry.codexSteer = turn.steer;
      },
      onUpdate: (notification) => this.onCodexUpdate(entry, notification),
      onApproval: (request) => {
        // full 残余权限（同 ACP onPermission 的 fail closed）：有 reject_once（decline）自动拒绝，
        // 否则 cancelled + 取消回合（interaction_denied）—— 不转人工、不伪造选项。
        if (entry.permissionMode === 'full') {
          const outcome = fullResidualPermissionOutcome([
            { optionId: 'accept', kind: 'allow_once' },
            { optionId: 'acceptForSession', kind: 'allow_always' },
            { optionId: 'decline', kind: 'reject_once' },
          ]);
          if ('optionId' in outcome) return 'decline';
          entry.status = 'cancelled';
          entry.acpAbort?.abort();
          this.settle(entry, 'cancelled', {
            error: 'full 模式的残余权限请求已被拒绝，取消回合',
            errorCode: 'interaction_denied',
          });
          return 'decline';
        }
        // 每任务一个 pending：已有未决请求时直接拒绝，不上行
        if (entry.acpPermissions?.size) return 'decline';
        // 交互关闭（interactionEnabled=false → interactive=false）时必须直接拒绝，
        // 否则 Promise 永远悬着，任务会一直等到总超时
        if (!entry.req.interactive || !entry.hooks.onInteraction) return 'decline';
        const requestId = `ir_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const answer = new Promise<string | undefined>((resolve) => {
          entry.acpPermissions?.set(requestId, (value) => {
            resolve(value?.optionId);
            return request.delivery;
          });
        });
        const options = [
          { optionId: 'accept', kind: 'allow_once', name: '允许一次' },
          { optionId: 'acceptForSession', kind: 'allow_always', name: '本会话允许' },
          { optionId: 'decline', kind: 'reject_once', name: '拒绝' },
        ];
        entry.hooks.onInteraction({
          requestId,
          kind: 'permission',
          payload: {
            protocol: 'codex-app-server',
            method: request.method,
            toolCall: request.payload,
            options,
          },
        });
        this.waitForInteraction(entry, requestId);
        return answer;
      },
    })
      .then((result) => {
        if (entry.state === 'settled') return;
        entry.hooks.onSession?.(result.threadId);
        if (entry.acpPermissions?.size) {
          this.settle(entry, 'failed', {
            error: 'Codex 回合结束时仍有未决交互',
            errorCode: 'agent_protocol_error',
            feedIncomplete: true,
          });
          return;
        }
        this.settle(entry, 'success', { exitCode: 0, result: result.text });
      })
      .catch((error) => {
        if (entry.state === 'settled') return;
        if (entry.status === 'cancelled') {
          this.settle(entry, 'cancelled', { error: '任务已取消', errorCode: 'cancelled' });
          return;
        }
        if (entry.status === 'timeout') {
          this.settle(entry, 'timeout', { error: '任务超时，Codex turn 已中断', errorCode: 'timeout' });
          return;
        }
        this.settle(entry, 'failed', {
          error: (error as Error).message,
          errorCode: 'agent_error',
        });
      });
  }

  private onCodexUpdate(entry: Entry, notification: Record<string, unknown>): void {
    // 终态后 app-server 通知仍可能到达（回合结束与通知流关闭不同步）——不再上行
    if (entry.state === 'settled') return;
    const method = String(notification['method'] ?? '');
    const params = (notification['params'] ?? {}) as Record<string, unknown>;
    // 非内容型通知（重连/回退/配置告警）必须上行：静默是「挂死」误判的温床
    const notice = codexNoticeText(notification);
    if (notice !== undefined) {
      const key = notice.slice(0, 160);
      const seen = (entry.codexNotices ??= new Set<string>());
      if (seen.has(key) || seen.size >= CODEX_NOTICE_LIMIT) return;
      seen.add(key);
      entry.hooks.onLog('stderr', `[codex] ${notice}${notice.endsWith('\n') ? '' : '\n'}`);
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const delta = codexDeltaText(notification);
      if (delta !== undefined) {
        entry.hooks.onLog('stdout', delta);
        this.recordPartialText(entry.req.taskId, delta);
      }
      return;
    }
    if (method !== 'item/started' && method !== 'item/completed') return;
    if (!entry.hooks.onStep) return;
    const item = (params['item'] ?? {}) as Record<string, unknown>;
    const ref = String(item['id'] ?? '');
    const type = String(item['type'] ?? 'item');
    const finished = method === 'item/completed';
    if (finished && !ref) return;
    let seq = ref ? entry.stepRefs.get(ref) : undefined;
    if (seq === undefined) {
      entry.stepSeq += 1;
      seq = entry.stepSeq;
      if (ref) entry.stepRefs.set(ref, seq);
    }
    entry.hooks.onStep({
      action: type,
      label: String(item['command'] ?? item['path'] ?? item['title'] ?? ''),
      state: finished ? 'finished' : 'started',
      ...(finished ? { ok: !item['error'] } : {}),
      ref: ref || undefined,
      seq,
    });
  }

  private launchAcp(entry: Entry): void {
    const controller = new AbortController();
    entry.acpAbort = controller;
    entry.acpPermissions = new Map();
    entry.hooks.onStatus('running');

    void runAcpPrompt({
      cwd: entry.req.cwd,
      prompt: entry.req.prompt ?? '',
      spec: entry.req.acpSpec,
      timeoutMs: timeoutOf(entry.req),
      nativeSessionId: entry.req.nativeSessionId,
      replayPrompt: entry.req.replayPrompt,
      signal: controller.signal,
      onUpdate: (update) => this.onAcpUpdate(entry, update),
      onPermission: (request) => {
        // 持久授权（1.0）：只问一次账本，命中就不再打扰平台（这个问题人工已经回答过）。
        // 三个前提缺一不可 —— default 模式、请求真实提供 persistent 选项、指纹匹配；
        // 判定在 permission-ledger.canAutoApprove()，这里只负责「问」和「用」。
        const approved =
          entry.permissionMode === 'default' && entry.hooks.onApprovalLookup
            ? entry.hooks.onApprovalLookup({
                agentType: entry.req.agentType,
                cwd: entry.req.cwd,
                permissionMode: entry.permissionMode,
                toolCall: request.toolCall,
                options: request.options,
              })
            : undefined;
        if (approved) {
          entry.hooks.onLog('stdout', `[ledger] 命中持久授权 ${approved.approvalId}，已自动允许\n`);
          return approved.optionId;
        }
        // full 残余权限（spec「权限与问题的组合语义」）：fail closed，不转交人工。
        // 只有 options 真实提供 reject_once 才按原 optionId 自动拒绝（回合继续）；
        // 否则以 cancelled outcome 回复、取消回合并以 interaction_denied 结束 —— 不伪造选项。
        if (entry.permissionMode === 'full') {
          const outcome = fullResidualPermissionOutcome(
            Array.isArray(request.options)
              ? (request.options as unknown as Array<Record<string, unknown>>)
              : undefined,
          );
          if ('optionId' in outcome) return outcome.optionId;
          entry.status = 'cancelled';
          entry.acpAbort?.abort();
          this.settle(entry, 'cancelled', {
            error: 'full 模式的残余权限请求已被拒绝（无 reject_once 可选），取消回合',
            errorCode: 'interaction_denied',
          });
          return undefined;
        }
        // 每任务最多一个 pending（design §7.1）：已有未决请求时新请求直接以 cancel outcome 完成，
        // 不再上行 —— 平台永远只会看到一个待答问题。
        if (entry.acpPermissions?.size) return undefined;
        if (!entry.req.interactive || !entry.hooks.onInteraction) return undefined;
        const requestId = `ir_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const answer = new Promise<string | undefined>((resolve) => {
          entry.acpPermissions?.set(requestId, (value) => {
            resolve(value?.optionId);
            return request.delivery;
          });
        });
        entry.hooks.onInteraction({
          requestId,
          kind: 'permission',
          payload: { toolCall: request.toolCall, options: request.options },
        });
        this.waitForInteraction(entry, requestId);
        return answer;
      },
      onForm: (request) => {
        // 每任务一个 pending：已有未决请求时 Form 直接 cancel，不上行
        if (entry.acpPermissions?.size) return { action: 'cancel' };
        if (!entry.req.interactive || !entry.hooks.onInteraction) return { action: 'cancel' };
        const answer = new Promise<AcpFormResponse>((resolve) => {
          entry.acpPermissions?.set(request.requestId, (value) => {
            if (value?.action === 'accept') {
              resolve({ action: 'accept', content: value.content ?? {} });
            } else {
              resolve({ action: value?.action === 'decline' ? 'decline' : 'cancel' });
            }
            return request.delivery;
          });
        });
        entry.hooks.onInteraction({
          requestId: request.requestId,
          kind: 'form',
          payload: { message: request.message, requestedSchema: request.requestedSchema },
          ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        });
        this.waitForInteraction(entry, request.requestId);
        return answer;
      },
    })
      .then((result) => {
        if (entry.state === 'settled') return;
        entry.hooks.onSession?.(result.sessionId);
        // 收到 result ≠ 成功：必须按 stopReason 结算，否则 max_tokens / refusal 会被当成正常完成
        const stop = knownStopReason(result.stopReason);
        if (entry.acpPermissions?.size) {
          this.settle(entry, 'failed', {
            error: 'ACP 回合结束时仍有未决交互',
            errorCode: 'agent_protocol_error',
            feedIncomplete: true,
          });
          return;
        }
        if (result.stopReason === 'end_turn' || result.stopReason === undefined) {
          this.settle(entry, 'success', {
            exitCode: 0,
            result: result.text,
            ...(stop ? { stopReason: stop } : {}),
          });
          return;
        }
        if (result.stopReason === 'cancelled') {
          this.settle(entry, 'cancelled', {
            error: 'ACP 回合已取消',
            errorCode: 'cancelled',
            stopReason: 'cancelled',
          });
          return;
        }
        this.settle(entry, 'failed', {
          error: `ACP 回合未正常结束（stopReason=${result.stopReason}）`,
          errorCode: 'agent_error',
          // 回合没有 end_turn，canonical feed 必然不完整 —— 如实标注，别让 UI 当完整历史
          feedIncomplete: true,
          ...(stop ? { stopReason: stop } : {}),
          ...(result.text.trim() ? { result: result.text } : {}),
        });
      })
      .catch((error) => {
        if (entry.state === 'settled') return;
        if (entry.status === 'cancelled') {
          this.settle(entry, 'cancelled', { error: '任务已取消', errorCode: 'cancelled' });
          return;
        }
        if (entry.status === 'timeout') {
          this.settle(entry, 'timeout', { error: '任务超时，ACP 会话已终止', errorCode: 'timeout' });
          return;
        }
        const auth = error instanceof AcpAuthRequiredError;
        this.settle(entry, 'failed', {
          error: (error as Error).message,
          errorCode: auth ? 'tool_no_credentials' : 'agent_error',
        });
      });
  }

  private onAcpUpdate(entry: Entry, update: Record<string, unknown>): void {
    // 终态后 agent 的 session/update 仍可能在途（取消/超时先结算，子进程清理是异步的）——不再上行
    if (entry.state === 'settled') return;
    const kind = String(update['sessionUpdate'] ?? '');
    if (kind === 'agent_message_chunk') {
      const text = acpChunkText(update);
      if (text !== undefined) {
        entry.hooks.onLog('stdout', text);
        // 真正的流式增量（ACP）：同时喂给半截消息累积器，刷新后才能看到这半段
        this.recordPartialText(entry.req.taskId, text);
      }
      return;
    }
    if (kind === 'plan' && entry.hooks.onPlan && Array.isArray(update['entries'])) {
      const items: PlanItem[] = [];
      for (const raw of update['entries'] as Array<Record<string, unknown>>) {
        const text = String(raw['content'] ?? raw['text'] ?? '');
        if (!text) continue;
        const state = String(raw['status'] ?? 'pending');
        items.push({
          text,
          state: state === 'completed' ? 'completed' : state === 'in_progress' ? 'in_progress' : 'pending',
        });
      }
      entry.hooks.onPlan(items);
      return;
    }
    if ((kind === 'tool_call' || kind === 'tool_call_update') && entry.hooks.onStep) {
      const ref = String(update['toolCallId'] ?? '');
      const status = String(update['status'] ?? 'pending');
      const finished = status === 'completed' || status === 'failed';
      const paired = ref ? entry.stepRefs.get(ref) : undefined;
      if (!finished && paired !== undefined) return;
      let seq = paired;
      if (seq === undefined) {
        entry.stepSeq += 1;
        seq = entry.stepSeq;
        if (ref) entry.stepRefs.set(ref, seq);
      }
      entry.hooks.onStep({
        action: String(update['kind'] ?? update['title'] ?? 'tool'),
        label: String(update['title'] ?? ''),
        state: finished ? 'finished' : 'started',
        ...(finished ? { ok: status === 'completed' } : {}),
        ref: ref || undefined,
        seq,
        // 富 toolCall（4.8）：ACP 原生 kind/title/locations/content 直传；
        // rawInput/rawOutput 不上行（ACP 字段本就未透传）。
        toolCall: {
          ...(ref ? { toolCallId: ref } : {}),
          name: String(update['kind'] ?? update['title'] ?? 'tool'),
          ...(acpToolKind(update['kind']) ? { kind: acpToolKind(update['kind']) } : {}),
          ...(typeof update['title'] === 'string' && update['title'] ? { title: update['title'] } : {}),
          status,
          ...acpToolLocations(update['locations']),
          ...acpToolContent(update['content']),
        },
      });
    }
  }

  private terminate(entry: Entry): void {
    if (!entry.child) {
      if (entry.acpAbort) {
        entry.acpAbort.abort();
        const status = entry.status === 'timeout' ? 'timeout' : 'cancelled';
        this.settle(entry, status, {
          error: status === 'timeout' ? '任务超时，ACP 会话已终止' : '任务已取消',
          errorCode: status,
        });
      }
      return;
    }
    if (isWinShim(entry.cmd)) {
      killCliProcess(entry.child, entry.cmd);
    } else {
      entry.child.kill('SIGTERM');
    }
    entry.killTimer = setTimeout(() => {
      if (!entry.child) return;
      if (isWinShim(entry.cmd)) killCliProcess(entry.child, entry.cmd);
      else entry.child.kill('SIGKILL');
    }, KILL_GRACE_MS);
  }

  /** 唯一终态收口：只 settle 一次、只释放一次名额 */
  private settle(entry: Entry, status: TaskStatus, info: TaskFinishInfo = {}): void {
    if (entry.state === 'settled') return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    // 终态之后半截文本就该消失：平台该读事件里的 complete，而不是 pm_ 桶里那半段
    this.partials.clear(entry.req.taskId);

    // 权限模式回显：终态必须带（平台据此区分「按 full 跑的」与「按 default 跑的」）
    if (info.permissionMode === undefined) info = { ...info, permissionMode: entry.permissionMode };

    // 最终回答：步骤解析器从事件流提取（C 批次；面板结果视图与平台同享），上限 16KB
    const resultText = entry.stepParser?.finalText?.();
    if (resultText && info.result === undefined) {
      info = { ...info, result: resultText.length > 16_384 ? `${resultText.slice(0, 16_384)}…` : resultText };
    }

    if (entry.state === 'running' || entry.state === 'waiting') {
      this.running = Math.max(0, this.running - 1);
    } else {
      const idx = this.queue.indexOf(entry);
      if (idx >= 0) this.queue.splice(idx, 1);
    }
    entry.state = 'settled';
    entry.status = status;
    for (const requestId of entry.acpPermissions?.keys() ?? []) {
      this.interactions.cancelRequest(
        entry.req.interactionSessionId ?? entry.req.taskId,
        entry.req.interactionTenantId ?? 'default',
        requestId,
      );
    }
    for (const resolve of entry.acpPermissions?.values() ?? []) resolve(undefined);
    entry.acpPermissions?.clear();

    /**
     * 上下文超限的反应式改判（`context_exhausted`）。
     *
     * 判定只来自 CLI 自己的失败文本（`info.error` 或输出尾部），**不做预算预测**；
     * 只替换 `agent_error`，success / cancelled / timeout 与其它受控码一律不动，
     * 识别不出来就维持 `agent_error` —— 宁可不报，不得虚报。
     */
    if (
      status === 'failed' &&
      info.errorCode === 'agent_error' &&
      looksLikeContextOverflow(info.error, entry.tail)
    ) {
      info = { ...info, errorCode: 'context_exhausted' };
    }

    // 终态快照存 entry：本条调用链内的重放直接用，不重跑 git diff
    entry.finishInfo = withDiff(entry.req, info);
    entry.hooks.onStatus(status, entry.finishInfo);
    // 落库回调（生产 = SQLite 同步写）返回后，内存条目即可回收：
    // 同 ID 重发的终态回放由调度入口的 SQLite 前置检查负责，这里不再持有终态历史。
    this.byId.delete(entry.req.taskId);
    entry.resolve(status);
    this.pump();
    this.notifyCapacity();
  }
}

/** 进程内的默认调度域（`runner.ts` 的 `startTask` 走它，保持 v1 调用方零改动） */
export const defaultSupervisor = new TaskSupervisor();

// ---------- ACP 富 toolCall（4.8）的宽松字段提取 ----------

type AcpToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

const ACP_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

function acpToolKind(raw: unknown): AcpToolKind | undefined {
  const kind = String(raw ?? '');
  return ACP_TOOL_KINDS.has(kind) ? (kind as AcpToolKind) : undefined;
}

function acpToolLocations(raw: unknown): { locations?: Array<{ path?: string; line?: number }> } {
  if (!Array.isArray(raw)) return {};
  const locations: Array<{ path?: string; line?: number }> = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const path = typeof o['path'] === 'string' ? o['path'] : undefined;
    const line = typeof o['line'] === 'number' ? o['line'] : undefined;
    if (path === undefined && line === undefined) continue;
    locations.push({ ...(path !== undefined ? { path } : {}), ...(line !== undefined ? { line } : {}) });
  }
  return locations.length > 0 ? { locations } : {};
}

/** ACP tool_call 的 content 块：只收 text/diff/terminal 三类，单块 16KB 截断、最多 8 块 */
function acpToolContent(raw: unknown): { content?: Array<{ kind: 'text' | 'diff' | 'terminal'; text: string }> } {
  if (!Array.isArray(raw)) return {};
  const blocks: Array<{ kind: 'text' | 'diff' | 'terminal'; text: string }> = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const kind = String(o['kind'] ?? '');
    if (kind !== 'text' && kind !== 'diff' && kind !== 'terminal') continue;
    const text = typeof o['text'] === 'string' ? o['text'] : '';
    if (!text) continue;
    blocks.push({
      kind,
      text: text.length > 16_384 ? `${text.slice(0, 16_383)}…` : text,
    });
  }
  return blocks.length > 0 ? { content: blocks } : {};
}

/** 给 CLI 展示用的摘要（不含任何路径/密钥细节） */
export function describeTask(req: RunTaskRequest): string {
  return `${req.agentType} @ ${realpathOr(req.cwd)}`;
}

function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * 把上游的 stopReason 收敛到受控枚举：只认这五个值，其他（含 `unknown`）一律当未知，
 * 于是不会被写进 wire 的受限字段 —— 未知原因只体现为 failed + agent_error。
 */
const STOP_REASONS: readonly StopReason[] = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'];

export function knownStopReason(raw: unknown): StopReason | undefined {
  return typeof raw === 'string' && (STOP_REASONS as readonly string[]).includes(raw)
    ? (raw as StopReason)
    : undefined;
}

export { BridgeError };

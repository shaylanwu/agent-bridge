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
import { runCodexPrompt } from '../adapters/codex-app-server.js';
import { runClaudeStreamPrompt } from '../adapters/claude-stream.js';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { agentDefOf, resolveBin } from '../adapters/agent-adapters.js';
import { captureWorktreeDiff, type DiffCapture } from '../infra/git.js';
import { chunkLog, type TaskStatus } from '../protocol.js';
import { buildWinCommandLine, isWinShim } from '../adapters/win-exec.js';
import { createStepParser, type ParsedStep, type PlanItem, type StepFormat } from '../adapters/step-parsers.js';
import { BridgeError, type BridgeErrorCode } from './errors.js';

export interface RunTaskRequest {
  taskId: string;
  agentType: string;
  cwd: string;
  args: string[];
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
  /** 打开 stdin 管道（steer / ACP 交互）；默认 false，保持 v1 行为 */
  interactive?: boolean;
  /** 走该 CLI 的原生 ACP 会话 */
  acp?: boolean;
  /** 走 Codex app-server JSON-RPC */
  appServer?: boolean;
  /** 走 Claude/Qoder 双向 stream-json（支持 same-turn steer） */
  claudeStream?: boolean;
  /** ACP 启动方式；缺省回落 CodeBuddy */
  acpSpec?: AcpAgentSpec;
  /** ACP 续接已有 native session */
  nativeSessionId?: string;
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
  phase?: 'queued' | 'running';
  /** 队列位次（从 1 开始） */
  queuePosition?: number;
}

export interface TaskHooks {
  onLog: (stream: 'stdout' | 'stderr', data: string) => void;
  onStatus: (status: TaskStatus, info?: TaskFinishInfo) => void;
  /** 步骤流（仅适配器声明了 steps 格式的工具会触发；seq 从 1 单调递增，finished 按 ref 配对不另占号） */
  onStep?: (step: ParsedStep & { seq: number }) => void;
  /** 待办计划快照（TodoWrite 类工具；每次调用覆盖，items 为空表示无计划能力/未调用） */
  onPlan?: (items: PlanItem[]) => void;
  /** CLI 事件里首次出现的原生 session/thread/conversation id */
  onSession?: (nativeSessionId: string) => void;
  /** ACP 权限请求（由调用方落库并上行 task_interaction_request） */
  onInteraction?: (request: AcpInteractionRequest) => void;
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
  /** 仅 request.interactive=true 且 stdin 可用时存在；写入一行并返回是否成功 */
  write?: (line: string) => boolean;
  /** 交互响应：permission 用 optionId，form 用 content */
  respondInteraction?: (requestId: string, answer?: InteractionAnswer) => boolean;
  /** 仅原生支持 same-turn steer 的适配器（如 Codex app-server）存在 */
  steer?: (text: string) => Promise<boolean>;
}

/** 显式状态机：settled 是吸收态 */
export type TaskState = 'queued' | 'running' | 'settled';

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const KILL_GRACE_MS = 2000;
/** 默认并发上限：30（2026-10-24 面向平台批量调度调整，原为 3）；防呆夹取上限见 config.ts */
export const DEFAULT_MAX_TASKS = 30;
/** 默认队列上限：再长的排队对调用方也没意义（2026-10-24 由 32 调整为 60） */
export const DEFAULT_MAX_QUEUED = 60;

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
  /** ref → seq：finished 事件配对回同一步，不另占序号（tool_use/tool_result 不拆成两步） */
  stepRefs: Map<string, number>;
  child?: ChildProcess;
  acpAbort?: AbortController;
  acpPermissions?: Map<string, (answer?: InteractionAnswer) => void>;
  codexSteer?: (text: string) => Promise<void>;
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
  private running = 0;
  private readonly queue: Entry[] = [];
  private maxTasks: number;
  /**
   * 幂等去重表（A1）：WS 重发同一 taskId 不重复 spawn。
   * 终态条目保留用于终态回放；有界 LRU（只淘汰已终态的，活跃任务绝不被挤出）。
   */
  private readonly byId = new Map<string, Entry>();
  private static readonly MAX_TRACKED = 1000;
  /** 最近一次提交生效的队列上限（上限本是请求级字段，水位上报取最近值） */
  private lastMaxQueued = DEFAULT_MAX_QUEUED;
  private readonly capacityListeners = new Set<(s: CapacitySnapshot) => void>();

  constructor(maxConcurrent = DEFAULT_MAX_TASKS) {
    this.maxTasks = maxConcurrent > 0 ? Math.floor(maxConcurrent) : DEFAULT_MAX_TASKS;
  }

  get runningCount(): number {
    return this.running;
  }

  get queuedCount(): number {
    return this.queue.length;
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

  /** 登记任务并按 LRU 淘汰最旧的已终态条目（活跃任务不淘汰，宁可暂时超限） */
  private track(entry: Entry): void {
    this.byId.set(entry.req.taskId, entry);
    if (this.byId.size <= TaskSupervisor.MAX_TRACKED) return;
    for (const [id, e] of this.byId) {
      if (e.state === 'settled') {
        this.byId.delete(id);
        break;
      }
    }
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
   * 未终态回当前状态快照；已终态回放终态快照。平台断线重发场景靠它对账。
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

    const args = req.args.length > 0 ? req.args : buildArgs(def.taskArgs, req.prompt ?? '');
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
      stepRefs: new Map(),
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

  private respondAcp(entry: Entry, requestId: string, answer?: InteractionAnswer): boolean {
    const resolve = entry.acpPermissions?.get(requestId);
    if (!resolve) return false;
    entry.acpPermissions?.delete(requestId);
    resolve(answer);
    return true;
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

    // 子进程环境恒为 bridge 自身进程环境：平台**不能**注入环境变量
    const shim = isWinShim(entry.cmd);
    const stdinMode = entry.req.interactive ? 'pipe' : 'ignore';
    const child: ChildProcess = shim
      ? spawn(buildWinCommandLine(entry.cmd, entry.argv), {
          cwd: entry.req.cwd,
          env: process.env,
          shell: true,
          windowsHide: true,
          stdio: [stdinMode, 'pipe', 'pipe'],
        })
      : spawn(entry.cmd, entry.argv, {
          cwd: entry.req.cwd,
          env: process.env,
          windowsHide: true,
          stdio: [stdinMode, 'pipe', 'pipe'],
        });
    entry.child = child;

    // 步骤流解析器（B 批次）：仅声明了 steps 格式的工具；stdout 原样上行 task_log 不受影响
    const stepParser = entry.stepFormat ? createStepParser(entry.stepFormat) : undefined;
    entry.stepParser = stepParser;

    let nativeSessionSeen = false;
    const emit = (stream: 'stdout' | 'stderr', buf: Buffer): void => {
      const text = buf.toString('utf8');
      if (!nativeSessionSeen && stream === 'stdout' && entry.hooks.onSession) {
        const match = /"(?:session_id|thread_id|conversation_id)"\s*:\s*"([A-Za-z0-9._:-]{1,200})"/.exec(
          text,
        );
        if (match?.[1]) {
          nativeSessionSeen = true;
          entry.hooks.onSession(match[1]);
        }
      }
      for (const piece of chunkLog(text)) entry.hooks.onLog(stream, piece);
      if (stepParser && stream === 'stdout' && entry.hooks.onStep) {
        for (const step of stepParser.feed(text)) {
          // finished 按 ref 配对回 started 的序号：tool_use/tool_result 是**同一步**的两半，
          // 不能各占一个 seq（否则时间线会把一步显示成两步，且 started 永远悬在"进行中"）
          const paired = step.state === 'finished' && step.ref !== undefined ? entry.stepRefs.get(step.ref) : undefined;
          if (paired !== undefined) {
            entry.hooks.onStep({ ...step, seq: paired });
            continue;
          }
          entry.stepSeq += 1;
          if (step.ref !== undefined) entry.stepRefs.set(step.ref, entry.stepSeq);
          entry.hooks.onStep({ ...step, seq: entry.stepSeq });
        }
        // 待办计划（TodoWrite 类工具）：解析器每次产出最新快照即上行
        const plan = stepParser.plan?.();
        if (plan && entry.hooks.onPlan) entry.hooks.onPlan(plan);
      }
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
        this.settle(entry, 'success', { exitCode: 0 });
      } else {
        this.settle(entry, 'failed', {
          exitCode: code ?? undefined,
          error: `CLI 退出码 ${code ?? 'unknown'}`,
          errorCode: 'agent_error',
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
      cwd: entry.req.cwd,
      prompt: entry.req.prompt ?? '',
      nativeSessionId: entry.req.nativeSessionId,
      timeoutMs: timeoutOf(entry.req),
      signal: controller.signal,
      onSession: (sessionId) => entry.hooks.onSession?.(sessionId),
      onUpdate: (event) => {
        if (event['type'] !== 'assistant') return;
        const message = event['message'] as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of blocks) {
          if (!block || typeof block !== 'object') continue;
          const item = block as Record<string, unknown>;
          if (item['type'] === 'text' && typeof item['text'] === 'string') {
            entry.hooks.onLog('stdout', item['text']);
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
        if (!entry.hooks.onInteraction) return 'decline';
        const requestId = `ir_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const answer = new Promise<string | undefined>((resolve) => {
          entry.acpPermissions?.set(requestId, (value) => resolve(value?.optionId));
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
        return answer;
      },
    })
      .then((result) => {
        if (entry.state === 'settled') return;
        entry.hooks.onSession?.(result.threadId);
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
    const method = String(notification['method'] ?? '');
    const params = (notification['params'] ?? {}) as Record<string, unknown>;
    if (method === 'item/agentMessage/delta') {
      const delta = params['delta'];
      if (typeof delta === 'string') entry.hooks.onLog('stdout', delta);
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
      signal: controller.signal,
      onUpdate: (update) => this.onAcpUpdate(entry, update),
      onPermission: (request) => {
        if (!entry.hooks.onInteraction) return undefined;
        const requestId = `ir_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
        const answer = new Promise<string | undefined>((resolve) => {
          entry.acpPermissions?.set(requestId, (value) => resolve(value?.optionId));
        });
        entry.hooks.onInteraction({
          requestId,
          kind: 'permission',
          payload: { toolCall: request.toolCall, options: request.options },
        });
        return answer;
      },
      onForm: (request) => {
        if (!entry.hooks.onInteraction) return { action: 'cancel' };
        const answer = new Promise<AcpFormResponse>((resolve) => {
          entry.acpPermissions?.set(request.requestId, (value) => {
            if (value?.action === 'accept') {
              resolve({ action: 'accept', content: value.content ?? {} });
            } else {
              resolve({ action: value?.action === 'decline' ? 'decline' : 'cancel' });
            }
          });
        });
        entry.hooks.onInteraction({
          requestId: request.requestId,
          kind: 'form',
          payload: { message: request.message, requestedSchema: request.requestedSchema },
          ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
        });
        return answer;
      },
    })
      .then((result) => {
        if (entry.state === 'settled') return;
        entry.hooks.onSession?.(result.sessionId);
        this.settle(entry, 'success', { exitCode: 0, result: result.text });
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
    const kind = String(update['sessionUpdate'] ?? '');
    if (kind === 'agent_message_chunk') {
      const content = update['content'] as Record<string, unknown> | undefined;
      if (content?.['type'] === 'text' && typeof content['text'] === 'string') {
        entry.hooks.onLog('stdout', content['text']);
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
    entry.child.kill('SIGTERM');
    entry.killTimer = setTimeout(() => entry.child?.kill('SIGKILL'), KILL_GRACE_MS);
  }

  /** 唯一终态收口：只 settle 一次、只释放一次名额 */
  private settle(entry: Entry, status: TaskStatus, info: TaskFinishInfo = {}): void {
    if (entry.state === 'settled') return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.killTimer) clearTimeout(entry.killTimer);

    // 最终回答：步骤解析器从事件流提取（C 批次；面板结果视图与平台同享），上限 16KB
    const resultText = entry.stepParser?.finalText?.();
    if (resultText && info.result === undefined) {
      info = { ...info, result: resultText.length > 16_384 ? `${resultText.slice(0, 16_384)}…` : resultText };
    }

    if (entry.state === 'running') {
      this.running = Math.max(0, this.running - 1);
    } else {
      const idx = this.queue.indexOf(entry);
      if (idx >= 0) this.queue.splice(idx, 1);
    }
    entry.state = 'settled';
    entry.status = status;
    for (const resolve of entry.acpPermissions?.values() ?? []) resolve(undefined);
    entry.acpPermissions?.clear();
    // 终态快照存 entry：幂等重放直接用，不重跑 git diff
    entry.finishInfo = withDiff(entry.req, info);
    entry.hooks.onStatus(status, entry.finishInfo);
    entry.resolve(status);
    this.pump();
    this.notifyCapacity();
  }
}

/** 进程内的默认调度域（`runner.ts` 的 `startTask` 走它，保持 v1 调用方零改动） */
export const defaultSupervisor = new TaskSupervisor();

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

export { BridgeError };

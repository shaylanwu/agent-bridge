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
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { agentDefOf, resolveBin } from '../adapters/agent-adapters.js';
import { captureWorktreeDiff, type DiffCapture } from '../infra/git.js';
import { chunkLog, type TaskStatus } from '../protocol.js';
import { buildWinCommandLine, isWinShim } from '../adapters/win-exec.js';
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
  /** 排队语义（v1 兼容：status 仍为 running，phase 区分排队/执行中） */
  phase?: 'queued' | 'running';
  /** 队列位次（从 1 开始） */
  queuePosition?: number;
}

export interface TaskHooks {
  onLog: (stream: 'stdout' | 'stderr', data: string) => void;
  onStatus: (status: TaskStatus, info?: TaskFinishInfo) => void;
}

export interface TaskHandle {
  taskId: string;
  cancel: () => void;
  done: Promise<TaskStatus>;
}

/** 显式状态机：settled 是吸收态 */
export type TaskState = 'queued' | 'running' | 'settled';

export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
export const KILL_GRACE_MS = 2000;
/** 默认并发上限：几个大模型 CLI 同时跑就能卡死整机 */
export const DEFAULT_MAX_TASKS = 3;
/** 默认队列上限：再长的排队对调用方也没意义 */
export const DEFAULT_MAX_QUEUED = 32;

interface Entry {
  req: RunTaskRequest;
  hooks: TaskHooks;
  cmd: string;
  argv: string[];
  state: TaskState;
  status: TaskStatus;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  resolve: (s: TaskStatus) => void;
  done: Promise<TaskStatus>;
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

  constructor(maxConcurrent = DEFAULT_MAX_TASKS) {
    this.maxTasks = maxConcurrent > 0 ? Math.floor(maxConcurrent) : DEFAULT_MAX_TASKS;
  }

  get runningCount(): number {
    return this.running;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /** 提交任务：校验 → 排队或立即启动。返回句柄（可取消、可 await 终态） */
  submit(req: RunTaskRequest, hooks: TaskHooks): TaskHandle {
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
      resolve,
      done,
    };

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

    return {
      taskId: req.taskId,
      cancel: () => {
        if (entry.state === 'settled') return;
        if (entry.state === 'queued') {
          this.settle(entry, 'cancelled', { error: '任务已取消（排队中被取消）', errorCode: 'cancelled' });
          return;
        }
        entry.status = 'cancelled';
        this.terminate(entry);
      },
      done,
    };
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

    // 子进程环境恒为 bridge 自身进程环境：平台**不能**注入环境变量
    const shim = isWinShim(entry.cmd);
    const child: ChildProcess = shim
      ? spawn(buildWinCommandLine(entry.cmd, entry.argv), {
          cwd: entry.req.cwd,
          env: process.env,
          shell: true,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawn(entry.cmd, entry.argv, {
          cwd: entry.req.cwd,
          env: process.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
    entry.child = child;

    const emit = (stream: 'stdout' | 'stderr', buf: Buffer): void => {
      for (const piece of chunkLog(buf.toString('utf8'))) entry.hooks.onLog(stream, piece);
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

  private terminate(entry: Entry): void {
    if (!entry.child) return;
    entry.child.kill('SIGTERM');
    entry.killTimer = setTimeout(() => entry.child?.kill('SIGKILL'), KILL_GRACE_MS);
  }

  /** 唯一终态收口：只 settle 一次、只释放一次名额 */
  private settle(entry: Entry, status: TaskStatus, info: TaskFinishInfo = {}): void {
    if (entry.state === 'settled') return;
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.killTimer) clearTimeout(entry.killTimer);

    if (entry.state === 'running') {
      this.running = Math.max(0, this.running - 1);
    } else {
      const idx = this.queue.indexOf(entry);
      if (idx >= 0) this.queue.splice(idx, 1);
    }
    entry.state = 'settled';
    entry.status = status;
    entry.hooks.onStatus(status, withDiff(entry.req, info));
    entry.resolve(status);
    this.pump();
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

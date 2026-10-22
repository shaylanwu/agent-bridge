/**
 * 任务执行器：拉起目标 CLI、流式回传输出、支持取消与超时、并发上限 + 有界 FIFO 队列
 *
 * 安全边界（本地强校验，不信任平台）：
 *  - agentType 必须在白名单（AGENTS 表）内
 *  - 平台不能下发任意 shell 命令：只拼「白名单二进制 + 参数数组」，不经过 shell
 *    （Windows 的 .cmd 垫片必须经 cmd.exe，这是唯一例外，且命令名固定为白名单里的 bin）
 *  - 平台不能注入环境变量：子进程环境恒为 bridge 自身 process.env
 *  - cwd 必须存在且是目录；配置了 allowed_cwd 时还必须是其子目录
 *  - 每个任务强制 timeout，到点 SIGTERM → 2s 后 SIGKILL
 *
 * 调度（2026-10-22）：超出并发上限的任务**排队**而不是拒绝 —— 排队是任务系统的标准做法，
 * 平台不必自己实现重试。队列有界（`max_queue`），满了才拒绝；排队任务可取消，
 * `timeoutMs` 从**入队**开始计算（含排队等待），避免"排队半小时再跑十分钟"击穿平台自己的超时。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { agentDefOf, resolveBin } from './agent-adapters.js';
import { chunkLog, type TaskStatus } from './protocol.js';
import { buildWinCommandLine, isWinShim } from './win-exec.js';

export interface RunTaskRequest {
  taskId: string;
  agentType: string;
  cwd: string;
  args: string[];
  prompt?: string;
  timeoutMs?: number;
  allowedCwd?: string[];
  /** 并发上限（由 cli 从 config.toml / 环境变量解析后传入；缺省 DEFAULT_MAX_TASKS） */
  maxConcurrent?: number;
  /** 队列长度上限（缺省 DEFAULT_MAX_QUEUED；0 表示不允许排队） */
  maxQueued?: number;
}

export interface TaskHooks {
  onLog: (stream: 'stdout' | 'stderr', data: string) => void;
  onStatus: (status: TaskStatus, info?: { exitCode?: number; error?: string }) => void;
}

export interface TaskHandle {
  taskId: string;
  cancel: () => void;
  done: Promise<TaskStatus>;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const KILL_GRACE_MS = 2000;
/** 默认并发上限：开发机 4~8 核，几个大模型 CLI 同时跑就会卡死整机。可用 config.toml 的 max_tasks 调整 */
const DEFAULT_MAX_TASKS = 3;
/** 默认队列上限：再长的排队对平台来说也没有意义（真那么忙应该换台机器） */
const DEFAULT_MAX_QUEUED = 32;

/** 当前运行中的任务数（只在本进程内有效） */
let runningTasks = 0;
/** 当前生效的并发上限（cli 每次下发都带同一个值；pump 时按最近一次的值算） */
let currentMaxTasks = DEFAULT_MAX_TASKS;
/** 排队中的任务（FIFO） */
const queue: Entry[] = [];

/** 仅用于测试与诊断 */
export function runningTaskCount(): number {
  return runningTasks;
}
export function queuedTaskCount(): number {
  return queue.length;
}

interface Entry {
  req: RunTaskRequest;
  hooks: TaskHooks;
  cmd: string;
  argv: string[];
  status: TaskStatus;
  started: boolean;
  finished: boolean;
  child?: ChildProcess;
  timer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  resolve: (s: TaskStatus) => void;
  done: Promise<TaskStatus>;
}

/**
 * `child` 是否位于 `parent` 目录之下（含相等）。
 * 必须按目录边界判断：`/a/b-old` 不能因为字符串前缀是 `/a/b` 就放行。
 * Windows 路径大小写不敏感（`C:\Work` 与 `c:\work` 是同一目录），比较前统一折叠。
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

/** 参数模板替换：{{prompt}} → prompt（作为单个参数传入，不拼 shell 字符串） */
function buildArgs(template: string[], prompt?: string): string[] {
  return template.map((a) => (prompt === undefined ? a : a.replaceAll('{{prompt}}', prompt)));
}

function timeoutOf(req: RunTaskRequest): number {
  return req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS;
}

/** 统一收口：任何路径进入终态都走这里（保证只 settle 一次、只释放一次名额） */
function finish(entry: Entry, status: TaskStatus, exitCode?: number, error?: string): void {
  if (entry.finished) return;
  entry.finished = true;
  entry.status = status;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.killTimer) clearTimeout(entry.killTimer);
  if (entry.started) {
    runningTasks = Math.max(0, runningTasks - 1);
    entry.hooks.onStatus(status, { exitCode, error });
    entry.resolve(status);
    pump();
    return;
  }
  // 排队中就被取消/超时：从队列里摘掉
  const idx = queue.indexOf(entry);
  if (idx >= 0) queue.splice(idx, 1);
  entry.hooks.onStatus(status, { exitCode, error });
  entry.resolve(status);
}

/** 有空位就从队列取任务启动（FIFO） */
function pump(): void {
  while (runningTasks < currentMaxTasks && queue.length > 0) {
    const next = queue[0];
    if (!next) return;
    queue.shift();
    launch(next);
  }
}

/** 真正 spawn 一个任务（入队与直跑共用） */
function launch(entry: Entry): void {
  if (entry.finished) return;
  const { req } = entry;
  entry.started = true;
  runningTasks += 1;

  // 子进程环境 = bridge 自身进程环境。平台**不能**注入任何环境变量（见 protocol.ts 的说明）
  const shim = isWinShim(entry.cmd);
  const child: ChildProcess = shim
    ? spawn(buildWinCommandLine(entry.cmd, entry.argv), {
        cwd: req.cwd,
        env: process.env,
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(entry.cmd, entry.argv, {
        cwd: req.cwd,
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

  child.on('error', (e) => finish(entry, 'failed', undefined, `进程启动失败：${e.message}`));
  child.on('close', (code) => {
    if (entry.status === 'timeout') finish(entry, 'timeout', code ?? undefined, '任务超时，进程已终止');
    else if (entry.status === 'cancelled') finish(entry, 'cancelled', code ?? undefined, '任务已取消');
    else if (code === 0) finish(entry, 'success', 0);
    else finish(entry, 'failed', code ?? undefined, `CLI 退出码 ${code ?? 'unknown'}`);
  });

  entry.hooks.onStatus('running');
}

/** 终止一个已启动的进程：先礼后兵 */
function terminate(entry: Entry): void {
  if (!entry.child) return;
  entry.child.kill('SIGTERM');
  entry.killTimer = setTimeout(() => entry.child?.kill('SIGKILL'), KILL_GRACE_MS);
}

export function startTask(req: RunTaskRequest, hooks: TaskHooks): TaskHandle {
  const def = agentDefOf(req.agentType);
  const finishEarly = (status: TaskStatus, error: string): TaskHandle => {
    hooks.onStatus(status, { error });
    return { taskId: req.taskId, cancel: () => undefined, done: Promise.resolve(status) };
  };

  if (!def) return finishEarly('failed', `不支持的工具：${req.agentType}`);
  if (!existsSync(req.cwd) || !statSync(req.cwd).isDirectory()) {
    return finishEarly('failed', `工作目录不存在：${req.cwd}`);
  }
  if (req.allowedCwd?.length && !req.allowedCwd.some((root) => isUnder(req.cwd, root))) {
    return finishEarly('failed', `工作目录不在允许范围内：${req.cwd}`);
  }

  // 命令 = 白名单 bin（或 npx 免安装），参数 = 模板（有显式 args 时以平台为准）
  const args = req.args.length > 0 ? req.args : buildArgs(def.taskArgs, req.prompt ?? '');
  let cmd: string;
  let argv: string[];
  if (def.npxSpec && !resolveBin([def.bin, ...(def.altBins ?? [])])) {
    cmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    argv = ['-y', def.npxSpec, ...args];
  } else {
    const binPath = resolveBin([def.bin, ...(def.altBins ?? [])]);
    if (!binPath) return finishEarly('failed', `本机没有安装 ${def.display}（未找到 ${def.bin}）`);
    cmd = binPath;
    argv = args;
  }

  const maxTasks = req.maxConcurrent && req.maxConcurrent > 0 ? Math.floor(req.maxConcurrent) : DEFAULT_MAX_TASKS;
  const maxQueued = req.maxQueued !== undefined && req.maxQueued >= 0 ? Math.floor(req.maxQueued) : DEFAULT_MAX_QUEUED;
  currentMaxTasks = maxTasks;

  // 队列满才拒绝（标准做法：先排队，排不下才算过载）
  if (runningTasks >= maxTasks && queue.length >= maxQueued) {
    return finishEarly('failed', `任务队列已满（并发 ${maxTasks}，排队 ${maxQueued}），请稍后重试`);
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
    status: 'running',
    started: false,
    finished: false,
    resolve,
    done,
  };

  // timeoutMs 从入队开始算：排队也是用户的等待时间，不能让它无限堆积
  entry.timer = setTimeout(() => {
    if (entry.finished) return;
    if (!entry.started) {
      finish(entry, 'timeout', undefined, `排队超时（等待超过 ${timeoutOf(req)}ms）`);
      return;
    }
    entry.status = 'timeout';
    terminate(entry);
  }, timeoutOf(req));

  if (runningTasks < maxTasks) launch(entry);
  else {
    queue.push(entry);
    hooks.onStatus('running', { error: `排队中（第 ${queue.length} 位，并发上限 ${maxTasks}）` });
  }

  return {
    taskId: req.taskId,
    cancel: () => {
      if (entry.finished) return;
      if (!entry.started) {
        finish(entry, 'cancelled', undefined, '任务已取消（排队中被取消）');
        return;
      }
      entry.status = 'cancelled';
      terminate(entry);
    },
    done,
  };
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

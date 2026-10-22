/**
 * 任务执行器：拉起目标 CLI、流式回传输出、支持取消与超时
 *
 * 安全边界（本地强校验，不信任平台）：
 *  - agentType 必须在白名单（AGENTS 表）内
 *  - 平台不能下发任意 shell 命令：只拼「白名单二进制 + 参数数组」，不经过 shell
 *    （Windows 的 .cmd 垫片必须经 cmd.exe，这是唯一例外，且命令名固定为白名单里的 bin）
 *  - cwd 必须存在且是目录；配置了 allowed_cwd 时还必须是其子目录
 *  - 每个任务强制 timeout，到点 SIGTERM → 2s 后 SIGKILL
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
  env?: Record<string, string>;
  timeoutMs?: number;
  allowedCwd?: string[];
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
  const explicitArgs = req.args.length > 0;
  const args = explicitArgs ? req.args : buildArgs(def.taskArgs, req.prompt ?? '');

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

  // Windows 的 .cmd 垫片：自己拼完整命令行 + shell（路径带空格也不会断，见 win-exec.ts）
  const shim = isWinShim(cmd);
  const child: ChildProcess = shim
    ? spawn(buildWinCommandLine(cmd, argv), {
        cwd: req.cwd,
        env: { ...process.env, ...(req.env ?? {}) },
        shell: true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    : spawn(cmd, argv, {
        cwd: req.cwd,
        env: { ...process.env, ...(req.env ?? {}) },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  let status: TaskStatus = 'running';
  let settled = false;
  const timeoutMs = req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : DEFAULT_TIMEOUT_MS;
  let killTimer: NodeJS.Timeout | undefined;

  const timer = setTimeout(() => {
    status = 'timeout';
    child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  }, timeoutMs);

  const emit = (stream: 'stdout' | 'stderr', buf: Buffer): void => {
    for (const piece of chunkLog(buf.toString('utf8'))) hooks.onLog(stream, piece);
  };
  child.stdout?.on('data', (b: Buffer) => emit('stdout', b));
  child.stderr?.on('data', (b: Buffer) => emit('stderr', b));

  const done = new Promise<TaskStatus>((resolve) => {
    const settle = (next: TaskStatus, exitCode?: number, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      status = next;
      hooks.onStatus(next, { exitCode, error });
      resolve(next);
    };
    child.on('error', (e) => settle('failed', undefined, `进程启动失败：${e.message}`));
    child.on('close', (code) => {
      if (status === 'timeout') settle('timeout', code ?? undefined, '任务超时，进程已终止');
      else if (status === 'cancelled') settle('cancelled', code ?? undefined, '任务已取消');
      else if (code === 0) settle('success', 0);
      else settle('failed', code ?? undefined, `CLI 退出码 ${code ?? 'unknown'}`);
    });
  });

  hooks.onStatus('running');

  return {
    taskId: req.taskId,
    cancel: () => {
      if (settled) return;
      status = 'cancelled';
      // 先礼后兵：SIGTERM 给 CLI 保存现场的机会，2s 后强杀
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
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

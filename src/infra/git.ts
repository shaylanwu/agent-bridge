/**
 * 工作区差异捕获（P0-6）
 *
 * 为什么单独一块：diff 是"任务产物"级别的通用能力 —— 人工审核、变更清单、未来的隔离工作区
 * （prepare_workspace）都要用同一份实现。放在 runner 里只会变成一堆内联 git 调用，且无法单测。
 *
 * 三条硬边界：
 *  1. 非 git 目录 → 返回空结果，**不报错**（平台不该因为用户没用 git 就看到任务失败）；
 *  2. 实际上只读：未跟踪文件先 `git add -N` 才能进 diff，取完立刻 `git reset -q -- <paths>`
 *     把 intent-to-add 还原掉，索引不留副作用（失败也在 finally 里还原）；
 *  3. 永不经过 shell：一律 `spawnSync('git', [...])` 参数数组；任何异常都降级成空 diff。
 */

import { spawnSync } from 'node:child_process';

/** diff 文本上限（字节）：人工审核看不了几 MB，超了截断并置 truncated */
export const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;
/** changedFiles 上限（条）：清单要完整可见，但也要防极端仓库把报文撑爆 */
export const DEFAULT_MAX_CHANGED_FILES = 500;

export type DiffSkipReason =
  | 'not-a-git-repo'
  | 'git-unavailable'
  | 'timeout'
  | 'git-error'
  | 'disabled';

export interface DiffCapture {
  /** unified diff 文本（空串 = 无改动或非 git 目录） */
  diff: string;
  /** 变更文件清单（仓库相对路径，去重、有上限） */
  changedFiles: string[];
  /** diff 文本是否被截断（changedFiles 始终完整到上限） */
  truncated: boolean;
  /** 没拿到 diff 的原因（诊断用，不上行） */
  reason?: DiffSkipReason;
}

export interface DiffOptions {
  maxBytes?: number;
  maxFiles?: number;
  /** 单次 git 调用超时（毫秒） */
  timeoutMs?: number;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  timedOut: boolean;
}

/** 唯一 git 调用入口：参数数组、无 shell、超时即杀、永不抛异常 */
function git(cwd: string, args: string[], timeoutMs: number): GitResult {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      // 输出可能很大（大仓库 diff），但受 diff_max_bytes 约束；这里给 32MB 兜底
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) return { ok: false, stdout: '', timedOut: false };
    if (r.signal || r.status === null) return { ok: false, stdout: r.stdout ?? '', timedOut: true };
    return { ok: r.status === 0, stdout: r.stdout ?? '', timedOut: false };
  } catch {
    return { ok: false, stdout: '', timedOut: false };
  }
}

export function isGitWorkTree(cwd: string, timeoutMs = 5000): boolean {
  const r = git(cwd, ['rev-parse', '--is-inside-work-tree'], timeoutMs);
  return r.ok && r.stdout.trim() === 'true';
}

/** 未跟踪（且未被 .gitignore 排除）的文件清单，NUL 分隔，空格路径也安全 */
function listUntracked(cwd: string, timeoutMs: number): string[] {
  const r = git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], timeoutMs);
  if (!r.ok) return [];
  return r.stdout.split('\0').map((s) => s.trim()).filter(Boolean);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 按**行边界**截断，保证截断后仍是合法 unified diff 的前缀（不切半行、不切多字节字符）。
 * 单行就超过上限时退化为按码点切（复用 protocol 的 chunkLog，避免重复实现"不切断多字节"）。
 */
export function truncateDiff(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false };
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > maxBytes) break;
    kept.push(line);
    used += size;
  }
  if (kept.length === 0) {
    const first = lines[0] ?? '';
    const head = chunkLogHead(first, maxBytes);
    return { text: head, truncated: true };
  }
  return { text: `${kept.join('\n')}\n`, truncated: true };
}

/** 单行的兜底截断：按码点累加，绝不切断多字节字符 */
function chunkLogHead(line: string, maxBytes: number): string {
  let buf = '';
  for (const ch of line) {
    const next = buf + ch;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break;
    buf = next;
  }
  return buf;
}

function emptyCapture(reason: DiffSkipReason): DiffCapture {
  return { diff: '', changedFiles: [], truncated: false, reason };
}

/**
 * 捕获 `cwd` 下的工作区差异。
 *
 * 调用方（runner）只在任务终态调用一次；本函数对异常零容忍 —— 任何失败都返回空 diff，
 * 绝不改变任务本身的终态。
 */
export function captureWorktreeDiff(cwd: string, opts: DiffOptions = {}): DiffCapture {
  const maxBytes = opts.maxBytes && opts.maxBytes > 0 ? Math.floor(opts.maxBytes) : DEFAULT_DIFF_MAX_BYTES;
  const maxFiles = opts.maxFiles && opts.maxFiles > 0 ? Math.floor(opts.maxFiles) : DEFAULT_MAX_CHANGED_FILES;
  const t = opts.timeoutMs && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : 8000;

  if (!isGitWorkTree(cwd, t)) return emptyCapture('not-a-git-repo');

  const untracked = listUntracked(cwd, t);
  // 已 add -N 成功的路径，finally 里要逐个还原
  const staged: string[] = [];
  try {
    if (untracked.length > 0) {
      for (const batch of chunk(untracked, 64)) {
        const r = git(cwd, ['add', '-N', '--', ...batch], Math.max(t, 15_000));
        if (r.ok) staged.push(...batch);
        else if (r.timedOut) return emptyCapture('timeout');
      }
    }

    const diffRes = git(cwd, ['diff', '--no-color'], Math.max(t, 30_000));
    if (diffRes.timedOut) return emptyCapture('timeout');
    if (!diffRes.ok) return emptyCapture('git-error');

    const names = git(cwd, ['diff', '--name-only'], Math.max(t, 15_000)).stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const changedFiles = [...new Set(names)].slice(0, maxFiles);

    const cut = truncateDiff(diffRes.stdout, maxBytes);
    return { diff: cut.text, changedFiles, truncated: cut.truncated };
  } catch {
    return emptyCapture('git-error');
  } finally {
    // 还原 intent-to-add：只 reset 我们刚加进去、且本来就是未跟踪的路径（不影响用户已暂存的内容）
    for (const batch of chunk(staged, 64)) {
      git(cwd, ['reset', '-q', '--', ...batch], Math.max(t, 15_000));
    }
  }
}

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import { TaskSupervisor } from '../src/core/task-supervisor.js';
import type { TaskStatus } from '../src/protocol.js';

/**
 * headless 子进程的 stdin 必须恒为 `ignore` —— 即使任务申请了交互。
 *
 * 真实世界的坑（2026-11-28 复现）：`codex exec --json` 这类 CLI 会**先读 stdin 到 EOF 再开工**。
 * 一旦调度器因为 `interactive=true` 把 `stdio[0]` 从 `ignore` 改成 `pipe` 且不写入内容，
 * 子进程就永远等不到 EOF：零字节输出、不退出，外部只看到 heartbeat，直到任务总超时。
 * 微实验对照：`ignore` → 20s 完成、879 字节；`pipe`（不写入）→ 25s 零字节。
 *
 * 交互的读取通道是 ACP / app-server / stream-json 协议，不是 stdin
 *（规格：除受控交互适配器外，子进程 stdin SHALL 保持 ignore）。
 *
 * 用**真子进程**而不是 fake child：这个缺陷的本质就是「子进程在等 EOF」，
 * mock 掉 spawn 会把要验的时序一起 mock 掉。假 CLI 只做一件事 —— 等 stdin EOF 再吐一行。
 */
const FAKE_CLI = `
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('STDIN_EOF_OK\\n');
  process.exit(0);
});
process.stdin.on('error', () => process.exit(1));
// 兜底：真的没收到 end（stdin 是永不关闭的 pipe）就一直等着，模拟 codex exec 的静默
`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function harness(): { script: string; cwd: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-stdin-'));
  const script = join(dir, 'fake-cli.cjs');
  writeFileSync(script, FAKE_CLI);
  const def = agentDefOf('kimi-code');
  if (!def) throw new Error('kimi-code 定义缺失');
  const before = { bin: def.bin, taskArgs: def.taskArgs, steps: def.steps };
  def.bin = 'node';
  def.taskArgs = [script];
  def.steps = undefined;
  cleanups.push(() => {
    def.bin = before.bin;
    def.taskArgs = before.taskArgs;
    def.steps = before.steps;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { script, cwd: dir };
}

function submit(sv: TaskSupervisor, taskId: string, cwd: string, interactive: boolean) {
  const logs: string[] = [];
  const statuses: TaskStatus[] = [];
  const handle = sv.submit(
    { taskId, agentType: 'kimi-code', cwd, args: [], interactive, timeoutMs: 4_000 },
    {
      onLog: (_stream, data) => logs.push(data),
      onStatus: (status) => statuses.push(status),
    },
  );
  return { handle, logs, statuses };
}

describe('headless 子进程的 stdin 恒为 ignore', () => {
  it('interactive=true 也不给 stdin 开 pipe：等 EOF 的 CLI 照常完成', async () => {
    const { cwd } = harness();
    const sv = new TaskSupervisor();
    const rec = submit(sv, 't_stdin_interactive', cwd, true);

    // 修复前：stdio[0]='pipe' 且不写入 → 子进程等不到 EOF → 4s 超时变 timeout（红）
    await expect(rec.handle.done).resolves.toBe('success');
    expect(rec.logs.join('')).toContain('STDIN_EOF_OK');
  }, 30_000);

  it('interactive=false 与 interactive=true 行为一致（stdin 不是交互开关）', async () => {
    const { cwd } = harness();
    const sv = new TaskSupervisor();
    const plain = submit(sv, 't_stdin_plain', cwd, false);
    await expect(plain.handle.done).resolves.toBe('success');

    const interactive = submit(new TaskSupervisor(), 't_stdin_interactive_2', cwd, true);
    await expect(interactive.handle.done).resolves.toBe('success');
  }, 30_000);
});

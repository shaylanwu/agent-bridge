import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeResident } from '../src/app/claude-resident.js';
import type { TaskHooks } from '../src/core/task-supervisor.js';

const FAKE = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let n = 0;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
send({ type: 'system', subtype: 'init', session_id: 'sess_resident' });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.type !== 'user') return;
  n += 1;
  const text = 'answer-' + n;
  send({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  send({ type: 'result', session_id: 'sess_resident', result: text, stop_reason: 'end_turn' });
});
`;

const itWindows = process.platform === 'win32' ? it : it.skip;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放滞后 */
    }
  }
});

describe('ClaudeResident', () => {
  it('同一进程连续两个 Turn，session_id 复用', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-resident-'));
    dirs.push(dir);
    const script = join(dir, 'fake.cjs');
    writeFileSync(script, FAKE);
    const resident = new ClaudeResident({
      command: process.execPath,
      args: [script],
      cwd: dir,
    });
    const logs: string[] = [];
    let session = '';
    const hooks: TaskHooks = {
      onStatus: vi.fn(),
      onLog: (_stream, data) => logs.push(data),
      onSession: (id) => {
        session = id;
      },
    };
    const first = await resident.send('one', hooks, 5000);
    const second = await resident.send('two', hooks, 5000);
    expect(first.result).toBe('answer-1');
    expect(second.result).toBe('answer-2');
    expect(session).toBe('sess_resident');
    expect(resident.nativeSessionId).toBe('sess_resident');
    expect(logs).toEqual(['answer-1', 'answer-2']);
    resident.close();
  });

  itWindows('Windows .cmd 垫片也能启动常驻进程并完成回合', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-resident-shim-'));
    dirs.push(dir);
    const script = join(dir, 'fake.cjs');
    const shim = join(dir, 'fake.cmd');
    writeFileSync(script, FAKE);
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
    const resident = new ClaudeResident({ command: shim, args: [], cwd: dir });
    const hooks: TaskHooks = { onStatus: vi.fn(), onLog: vi.fn() };
    expect((await resident.send('one', hooks, 5000)).result).toBe('answer-1');
    resident.close();
  });

  itWindows('关闭 .cmd 常驻会话会回收真实 CLI 子孙进程，而不只是外壳', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-resident-tree-'));
    dirs.push(dir);
    const script = join(dir, 'child.cjs');
    const pidFile = join(dir, 'child.pid');
    const shim = join(dir, 'fake.cmd');
    writeFileSync(
      script,
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "%~dp0child.cjs"\r\n`);
    const resident = new ClaudeResident({ command: shim, args: [], cwd: dir, idleMs: 0 });
    const hooks: TaskHooks = { onStatus: vi.fn(), onLog: vi.fn() };
    const pending = resident.send('never finishes', hooks, 5000);
    let pid = 0;
    for (let i = 0; i < 50 && !existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
    expect(pid).toBeGreaterThan(0);
    resident.close();
    await expect(pending).rejects.toThrow('已关闭');
    let alive = true;
    for (let i = 0; i < 50 && alive; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    // 红灯时也清理这个测试专用的 fake CLI，不能把孤儿留在开发机。
    if (alive) {
      try {
        process.kill(pid);
      } catch {
        /* 已退出 */
      }
    }
    expect(alive).toBe(false);
  });

  it('常驻 result 明确 is_error 时 reject，不结算成功', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-resident-error-'));
    dirs.push(dir);
    const script = join(dir, 'error.cjs');
    writeFileSync(
      script,
      String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', () => process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'error_during_execution', is_error: true, error: 'Models is required'
}) + '\n'));
`,
    );
    const resident = new ClaudeResident({ command: process.execPath, args: [script], cwd: dir });
    const hooks: TaskHooks = { onStatus: vi.fn(), onLog: vi.fn() };
    await expect(resident.send('one', hooks, 5000)).rejects.toThrow('Models is required');
    resident.close();
  });

  it('空闲超时关闭进程，下一次 send 自动重启', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-resident-idle-'));
    dirs.push(dir);
    const script = join(dir, 'fake.cjs');
    writeFileSync(script, FAKE);
    const resident = new ClaudeResident({
      command: process.execPath,
      args: [script],
      cwd: dir,
      idleMs: 50,
    });
    const hooks: TaskHooks = { onStatus: vi.fn(), onLog: vi.fn() };
    expect((await resident.send('one', hooks, 5000)).result).toBe('answer-1');
    expect(resident.isRunning).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(resident.isRunning).toBe(false);
    expect((await resident.send('two', hooks, 5000)).result).toBe('answer-1');
    resident.close();
  });
});

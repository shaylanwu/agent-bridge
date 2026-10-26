import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

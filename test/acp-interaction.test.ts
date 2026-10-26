import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runAcpPrompt } from '../src/adapters/acp-codebuddy.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const FAKE_ACP = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
let selected = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
    return;
  }
  if (m.method === 'session/new') {
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_fake' } });
    return;
  }
  if (m.method === 'session/prompt') {
    promptId = m.id;
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: 'sess_fake',
      toolCall: { toolCallId: 'call_1', title: 'Run tests' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    }});
    return;
  }
  if (m.id === 900 && m.result) {
    selected = m.result?.outcome?.optionId ?? null;
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'sess_fake',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: selected === 'allow_once' ? 'OK' : 'DENIED' } },
    }});
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (m.method === 'session/cancel') {
    process.exit(0);
  }
});
`;

describe('ACP permission interaction', () => {
  it('permission 选择回送 ACP 子进程并继续 prompt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-fake-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 下子进程句柄释放可能滞后；临时目录可留给系统清理 */
      }
    });
    const script = join(dir, 'fake-acp.cjs');
    writeFileSync(script, FAKE_ACP);
    let asked = '';
    const result = await runAcpPrompt({
      cwd: dir,
      prompt: 'run tests',
      spec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
      timeoutMs: 15_000,
      onPermission: (request) => {
        asked = request.toolCall?.['title'] as string;
        return 'allow_once';
      },
    });
    expect(asked).toBe('Run tests');
    expect(result.text).toBe('OK');
    expect(result.stopReason).toBe('end_turn');
  });

  it('畸形帧被忽略，后续合法帧仍可完成握手', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-malformed-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 下子进程句柄释放可能滞后；临时目录可留给系统清理 */
      }
    });
    const script = join(dir, 'fake-acp.cjs');
    writeFileSync(
      script,
      String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    process.stdout.write('not-json\n');
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  } else if (m.method === 'session/new') {
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_fake' } });
  } else if (m.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_fake', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } });
    send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
  }
});
`,
    );
    const result = await runAcpPrompt({
      cwd: dir,
      prompt: 'hi',
      spec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
      timeoutMs: 15_000,
    });
    expect(result.text).toBe('OK');
  });

  it('帧被拆成两段仍按 NDJSON 拼接', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-fragment-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 下子进程句柄释放可能滞后；临时目录可留给系统清理 */
      }
    });
    const script = join(dir, 'fake-acp.cjs');
    writeFileSync(
      script,
      String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    const frame = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
    process.stdout.write(frame.slice(0, 10));
    setTimeout(() => process.stdout.write(frame.slice(10) + '\n'), 20);
  } else if (m.method === 'session/new') {
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_fake' } });
  } else if (m.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_fake', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } } } });
    send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
  }
});
`,
    );
    const result = await runAcpPrompt({
      cwd: dir,
      prompt: 'hi',
      spec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
      timeoutMs: 15_000,
    });
    expect(result.text).toBe('OK');
  });

  it('prompt 期间子进程退出 → 明确失败，不挂死', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-exit-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 下子进程句柄释放可能滞后；临时目录可留给系统清理 */
      }
    });
    const script = join(dir, 'fake-acp.cjs');
    writeFileSync(
      script,
      String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_fake' } });
  else if (m.method === 'session/prompt') process.exit(7);
});
`,
    );
    await expect(
      runAcpPrompt({
        cwd: dir,
        prompt: 'hi',
        spec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
        timeoutMs: 15_000,
      }),
    ).rejects.toThrow(/进程退出/);
  });

  it('prompt 无响应 → timeoutMs 失败，不挂死', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-timeout-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 下子进程句柄释放可能滞后；临时目录可留给系统清理 */
      }
    });
    const script = join(dir, 'fake-acp.cjs');
    writeFileSync(
      script,
      String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_fake' } });
});
`,
    );
    await expect(
      runAcpPrompt({
        cwd: dir,
        prompt: 'hi',
        spec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
        timeoutMs: 400,
      }),
    ).rejects.toThrow(/超时/);
  });

  it('拒绝 permission 时子进程收到 cancelled，不伪造允许', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-deny-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 下子进程句柄释放可能滞后；临时目录可留给系统清理 */
      }
    });
    const script = join(dir, 'fake-acp.cjs');
    writeFileSync(script, FAKE_ACP);
    const result = await runAcpPrompt({
      cwd: dir,
      prompt: 'run tests',
      spec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
      timeoutMs: 15_000,
      onPermission: () => undefined,
    });
    expect(result.text).toBe('DENIED');
  });
});

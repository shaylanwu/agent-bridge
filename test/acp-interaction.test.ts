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
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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

  it('拒绝 permission 时子进程收到 cancelled，不伪造允许', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-deny-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
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

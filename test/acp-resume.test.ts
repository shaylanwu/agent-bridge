/**
 * ACP 续会话的三条路径（实测事实，不是猜测）：
 *  1. 标准 `session/load` 成功 → 只发本轮新文本；
 *  2. 标准 load 回 -32601、`session/resume` 成功（dsh 就是这样）→ 只发本轮新文本；
 *  3. 两条都不认 → 新会话，但**首轮 prompt 必须是完整 transcript**，不能只剩这一句话。
 *
 * 第 3 条是回归重点：只开新会话、只发新文本，表面上回合成功，实际历史静默丢失。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runAcpPrompt } from '../src/adapters/acp-codebuddy.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const TRANSCRIPT = 'user: 上一轮问题\nagent: 上一轮回答\nuser: 这一轮新问题';

/**
 * 假 ACP agent：按 argv[2] 决定 load / resume / 都不认，
 * 并把收到的 prompt 文本原样回吐，便于断言「到底发了什么」。
 */
const FAKE = String.raw`
const mode = process.argv[2];
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const unsupported = (id) => send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, sessionCapabilities: { resume: true } } });
    return;
  }
  if (m.method === 'session/load') {
    if (mode === 'load') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: m.params.sessionId } });
    else unsupported(m.id);
    return;
  }
  if (m.method === 'session/resume') {
    if (mode === 'resume') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: m.params.sessionId } });
    else unsupported(m.id);
    return;
  }
  if (m.method === 'session/new') {
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_new' } });
    return;
  }
  if (m.method === 'session/prompt') {
    const text = (m.params.prompt || []).map((p) => p.text || '').join('');
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: m.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    }});
    send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
    return;
  }
  if (m.method === 'session/cancel') process.exit(0);
});
`;

function fakeAgent(mode: 'load' | 'resume' | 'none'): string {
  const dir = mkdtempSync(join(tmpdir(), `agent-bridge-acp-resume-${mode}-`));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 下子进程句柄释放可能滞后；临时目录可留给系统清理 */
    }
  });
  const script = join(dir, 'fake-acp.cjs');
  writeFileSync(script, FAKE);
  return script;
}

async function run(mode: 'load' | 'resume' | 'none', withReplay = true) {
  const script = fakeAgent(mode);
  return runAcpPrompt({
    cwd: join(script, '..'),
    prompt: '这一轮新问题',
    spec: { command: process.execPath, args: [script, mode], sanitizeHostEnv: false },
    timeoutMs: 15_000,
    nativeSessionId: 'sess_prev',
    ...(withReplay ? { replayPrompt: TRANSCRIPT } : {}),
  });
}

describe('ACP 续会话', () => {
  it('session/load 成功：续上原会话，只发本轮新文本', async () => {
    const result = await run('load');
    expect(result.sessionId).toBe('sess_prev');
    expect(result.text).toBe('这一轮新问题');
  });

  it('load 回 -32601、session/resume 成功（dsh 实测行为）：续上原会话，只发新文本', async () => {
    const result = await run('resume');
    expect(result.sessionId).toBe('sess_prev');
    expect(result.text).toBe('这一轮新问题');
  });

  it('两条都不认：退回新会话，首轮 prompt 用完整 transcript（不静默丢历史）', async () => {
    const result = await run('none');
    expect(result.sessionId).toBe('sess_new');
    expect(result.text).toBe(TRANSCRIPT);
  });

  it('没有 replayPrompt 时退回旧行为（只发新文本），说明调用方没准备兜底', async () => {
    const result = await run('none', false);
    expect(result.sessionId).toBe('sess_new');
    expect(result.text).toBe('这一轮新问题');
  });

  it('首轮没有 nativeSessionId：不触发重放（本来就没有历史可丢）', async () => {
    const script = fakeAgent('none');
    const result = await runAcpPrompt({
      cwd: join(script, '..'),
      prompt: '第一句话',
      spec: { command: process.execPath, args: [script, 'none'], sanitizeHostEnv: false },
      timeoutMs: 15_000,
      replayPrompt: TRANSCRIPT,
    });
    expect(result.text).toBe('第一句话');
  });
});

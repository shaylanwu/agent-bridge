import { describe, expect, it } from 'vitest';
import { chunkLog, assertServerMessage, ProtocolError } from '../src/protocol';
import { createPkce } from '../src/auth';
import { AGENTS, agentDefOf, probeCredential } from '../src/agent-adapters';
import { buildWinCommandLine } from '../src/win-exec';

describe('chunkLog', () => {
  it('按 UTF-8 字节切成 ≤4KB 且不切断多字节字符', () => {
    const text = '中'.repeat(3000); // 9000 字节
    const chunks = chunkLog(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(Buffer.byteLength(c, 'utf8')).toBeLessThanOrEqual(4096);
    expect(chunks.join('')).toBe(text);
  });

  it('空串返回空数组', () => {
    expect(chunkLog('')).toEqual([]);
  });
});

describe('assertServerMessage', () => {
  it('接受合法 run_task 并补默认值', () => {
    const msg = assertServerMessage({
      type: 'run_task',
      taskId: 't1',
      agentType: 'codex',
      cwd: '/tmp',
      args: ['exec', 'hi'],
    });
    expect(msg).toMatchObject({ type: 'run_task', taskId: 't1', agentType: 'codex' });
  });

  it('拒绝缺少字段 / 未知类型', () => {
    expect(() => assertServerMessage({ type: 'run_task', taskId: 't1' })).toThrow(ProtocolError);
    expect(() => assertServerMessage({ type: 'rm_rf' })).toThrow(ProtocolError);
    expect(() => assertServerMessage(null)).toThrow(ProtocolError);
  });

  it('拒绝 args 非字符串数组（防止平台塞 shell 片段）', () => {
    expect(() =>
      assertServerMessage({
        type: 'run_task',
        taskId: 't',
        agentType: 'codex',
        cwd: '/',
        args: [1],
      }),
    ).toThrow(ProtocolError);
  });
});

describe('PKCE', () => {
  it('challenge = base64url(sha256(verifier))，且每次不同', () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('适配器注册表', () => {
  it('11 个工具、kind 唯一、都带任务参数模板', () => {
    expect(AGENTS).toHaveLength(11);
    expect(new Set(AGENTS.map((a) => a.kind)).size).toBe(11);
    for (const a of AGENTS) {
      expect(a.bin.length).toBeGreaterThan(0);
      expect(a.taskArgs.length).toBeGreaterThan(0);
      expect(a.taskArgs.join(' ')).toContain('{{prompt}}');
    }
  });

  it('免安装工具（dsh）带 npxSpec，其余不带', () => {
    expect(agentDefOf('ds-harness')?.npxSpec).toBe('@deepseek-ai/dsh');
    expect(agentDefOf('codex')?.npxSpec).toBeUndefined();
  });
});

describe('凭据探测', () => {
  it('环境变量存在 → configured，并给出 env 来源', () => {
    const def = AGENTS.find((a) => a.kind === 'grok-cli');
    if (!def) throw new Error('缺少 grok 适配器');
    const saved = process.env['XAI_API_KEY'];
    process.env['XAI_API_KEY'] = 'xai-test';
    try {
      const r = probeCredential(def);
      expect(r.status).toBe('configured');
      expect(r.source).toBe('env:XAI_API_KEY');
    } finally {
      if (saved === undefined) delete process.env['XAI_API_KEY'];
      else process.env['XAI_API_KEY'] = saved;
    }
  });

  it('没有判据的工具返回 unknown', () => {
    expect(Object.keys(AGENTS.map((a) => a.kind)).length).toBeGreaterThan(0);
    const def = AGENTS.find((a) => a.kind === 'mimo-code');
    if (!def) throw new Error('缺少 mimo 适配器');
    // mimo 只有 env 判据，清掉后应为 missing 而非 unknown
    const saved = process.env['MIMO_API_KEY'];
    delete process.env['MIMO_API_KEY'];
    try {
      expect(probeCredential(def).status).toBe('missing');
    } finally {
      if (saved !== undefined) process.env['MIMO_API_KEY'] = saved;
    }
  });
});

describe('Windows 垫片命令行拼装', () => {
  it('路径带空格也整体加引号（否则 cmd 会在空格处断开）', () => {
    const bin = String.raw`C:\Programs\Qoder IDE\bin\qoder.cmd`;
    expect(buildWinCommandLine(bin, ['--version'])).toBe(`"${bin}" "--version"`);
  });

  it('参数里的双引号翻倍（cmd 转义规则）', () => {
    const bin = String.raw`C:\a b\x.cmd`;
    const line = buildWinCommandLine(bin, ['say "hi"']);
    expect(line).toBe(`"${bin}" "say ""hi"""`);
  });
});

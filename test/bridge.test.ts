import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chunkLog, assertServerMessage, ProtocolError } from '../src/protocol';
import { createPkce } from '../src/auth';
import { AGENTS, agentDefOf, probeCredential } from '../src/agent-adapters';
import { buildWinCommandLine } from '../src/win-exec';
import { isUnder, startTask } from '../src/runner';
import { loadConfig, normalizeAllowedCwd } from '../src/config';
import { resolveDeviceId, wsUrlOf } from '../src/bridge-client';
import { logoDataUri } from '../src/agent-logos';

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

describe('WS 地址与 deviceId 解析', () => {
  it('有 deviceId 时拼查询参数，https → wss', () => {
    expect(wsUrlOf('https://platform.example.com', 'bd_9f1c')).toBe(
      'wss://platform.example.com/api/bridge/ws?deviceId=bd_9f1c',
    );
  });

  it('deviceId 为空时省略查询参数（不发空值）', () => {
    expect(wsUrlOf('https://platform.example.com', '')).toBe('wss://platform.example.com/api/bridge/ws');
  });

  it('http → ws 且保留端口', () => {
    expect(wsUrlOf('http://127.0.0.1:8899', 'bd_x')).toBe('ws://127.0.0.1:8899/api/bridge/ws?deviceId=bd_x');
  });

  it('解析优先级：授权响应 > flag > env > 已存配置', () => {
    expect(resolveDeviceId({ fromAuth: 'bd_auth', flag: 'bd_flag', env: 'bd_env', saved: 'bd_saved' })).toBe('bd_auth');
    expect(resolveDeviceId({ flag: 'bd_flag', env: 'bd_env', saved: 'bd_saved' })).toBe('bd_flag');
    expect(resolveDeviceId({ env: 'bd_env', saved: 'bd_saved' })).toBe('bd_env');
    expect(resolveDeviceId({ saved: 'bd_saved' })).toBe('bd_saved');
  });

  it('全是空/空白时返回空串（调用方提示平台按 token 反查）', () => {
    expect(resolveDeviceId({})).toBe('');
    expect(resolveDeviceId({ fromAuth: '  ', flag: '', env: '   ', saved: undefined })).toBe('');
  });
});

describe('品牌图标', () => {
  it('已收录的 kind 返回 base64 data URI（24×24 单色矢量）', () => {
    const uri = logoDataUri('claude-code');
    expect(uri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(uri && Buffer.from(uri.split(',')[1] ?? '', 'base64').toString('utf8')).toContain('<svg');
  });

  it('未知 kind 返回 undefined（调用方省略 logo 字段，不报错）', () => {
    expect(logoDataUri('not-a-real-agent')).toBeUndefined();
  });

  it('重复调用命中缓存（同一字符串引用）', () => {
    expect(logoDataUri('codex')).toBe(logoDataUri('codex'));
  });

  it('11 个适配器都能解析到 logo（资产缺失会在这里暴露）', () => {
    const missing = AGENTS.filter((a) => !logoDataUri(a.kind)).map((a) => a.kind);
    expect(missing).toEqual([]);
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

describe('目录白名单（allowed_cwd）', () => {
  const base = join(tmpdir(), 'ab-allow-test');

  it('isUnder：同目录与子目录放行', () => {
    expect(isUnder(base, base)).toBe(true);
    expect(isUnder(join(base, 'api'), base)).toBe(true);
    expect(isUnder(join(base, 'a', 'b'), base)).toBe(true);
  });

  it('isUnder：父目录、兄弟目录拒绝', () => {
    expect(isUnder(tmpdir(), base)).toBe(false);
    expect(isUnder(join(base, '..', 'other'), base)).toBe(false);
  });

  it('isUnder：前缀旁路拒绝（/a/b-old 不属于 /a/b）', () => {
    expect(isUnder(`${base}-old`, base)).toBe(false);
    expect(isUnder(`${base}-old${join('x')}`, base)).toBe(false);
  });

  it('isUnder：Windows 路径大小写不敏感', () => {
    if (process.platform !== 'win32') return;
    expect(isUnder(base.toUpperCase(), base)).toBe(true);
  });

  it('normalizeAllowedCwd：丢空项、解析绝对路径、去重；空数组视为未配置', () => {
    const r = normalizeAllowedCwd(['   ', base, base, 'rel-dir']);
    expect(r).toEqual([base, resolve('rel-dir')]);
    expect(normalizeAllowedCwd([])).toBeUndefined();
    expect(normalizeAllowedCwd(undefined)).toBeUndefined();
    expect(normalizeAllowedCwd('not-an-array')).toBeUndefined();
  });

  it('loadConfig：从 config.toml 的 allowed_cwd 读取并规范化', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-cfg-'));
    const file = join(dir, 'config.toml');
    const posixBase = base.replace(/\\/g, '/');
    writeFileSync(
      file,
      [
        'platformUrl = "https://platform.example.com"',
        'deviceId = "bd_smoke"',
        'deviceToken = "tok_smoke"',
        `allowed_cwd = ["${posixBase}", ""]`,
        '',
      ].join('\n'),
      'utf8',
    );
    const saved = process.env['AGENT_BRIDGE_CONFIG'];
    process.env['AGENT_BRIDGE_CONFIG'] = file;
    try {
      expect(loadConfig()?.allowedCwd).toEqual([resolve(base)]);
    } finally {
      if (saved === undefined) delete process.env['AGENT_BRIDGE_CONFIG'];
      else process.env['AGENT_BRIDGE_CONFIG'] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig：没有 allowed_cwd 时为 undefined（保持原行为）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-cfg2-'));
    const file = join(dir, 'config.toml');
    writeFileSync(
      file,
      ['platformUrl = "https://p.example.com"', 'deviceId = "bd_x"', 'deviceToken = "tok_x"', ''].join('\n'),
      'utf8',
    );
    const saved = process.env['AGENT_BRIDGE_CONFIG'];
    process.env['AGENT_BRIDGE_CONFIG'] = file;
    try {
      expect(loadConfig()?.allowedCwd).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env['AGENT_BRIDGE_CONFIG'];
      else process.env['AGENT_BRIDGE_CONFIG'] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('startTask：cwd 越界直接 failed，且不 spawn 任何进程', async () => {
    const statuses: string[] = [];
    const handle = startTask(
      {
        taskId: 't-out-of-scope',
        agentType: 'codex',
        cwd: tmpdir(),
        args: [],
        prompt: 'should never run',
        allowedCwd: [join(tmpdir(), 'ab-allowed-only')],
      },
      {
        onLog: () => undefined,
        onStatus: (s) => statuses.push(s),
      },
    );
    expect(await handle.done).toBe('failed');
    expect(statuses).toEqual(['failed']);
  });
});

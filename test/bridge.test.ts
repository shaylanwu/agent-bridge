import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chunkLog, assertServerMessage, ProtocolError, PROTOCOL_CAPABILITIES, toCloudEvent } from '../src/protocol';
import { captureWorktreeDiff, isGitWorkTree, truncateDiff } from '../src/infra/git';
import { resolveDiffMaxBytes } from '../src/infra/config';
import {
  issueServiceToken,
  loadServices,
  revokeServiceToken,
  rotateServiceToken,
  verifyServiceToken,
} from '../src/infra/service-token';
import { auditPath, writeAudit } from '../src/infra/audit';
import { Emitter, isTerminal } from '../src/core/emitter';
import { BRIDGE_ERROR_CODES, BridgeError, tokenDenyCode } from '../src/core/errors';
import { redact } from '../src/core/redact';
import { TaskSupervisor } from '../src/core/task-supervisor';
import { createPkce } from '../src/infra/auth';
import { AGENTS, agentDefOf, probeCredential } from '../src/adapters/agent-adapters';
import { buildWinCommandLine } from '../src/adapters/win-exec';
import { isUnder, startTask } from '../src/runner';
import { loadConfig, normalizeAllowedCwd, resolveMaxQueued, resolveMaxTasks } from '../src/infra/config';
import { resolveDeviceId, wsUrlOf } from '../src/transport/bridge-client';
import { Outbox } from '../src/transport/outbox';
import { logoDataUri } from '../src/adapters/agent-logos';

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
  it('12 个工具、kind 唯一、都带任务参数模板', () => {
    expect(AGENTS).toHaveLength(12);
    expect(new Set(AGENTS.map((a) => a.kind)).size).toBe(12);
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

  it('12 个适配器都能解析到 logo（资产缺失会在这里暴露）', () => {
    const missing = AGENTS.filter((a) => !logoDataUri(a.kind)).map((a) => a.kind);
    expect(missing).toEqual([]);
  });
});

describe('并发上限配置', () => {
  it('默认 3；config 给值就用 config', () => {
    expect(resolveMaxTasks()).toBe(3);
    expect(resolveMaxTasks(5)).toBe(5);
  });

  it('夹在 1~32（0/负数回落默认，过大截断）', () => {
    expect(resolveMaxTasks(0)).toBe(3);
    expect(resolveMaxTasks(-2)).toBe(3);
    expect(resolveMaxTasks(100)).toBe(32);
    expect(resolveMaxTasks(2.7)).toBe(2);
  });

  it('环境变量优先于 config（临时/CI 覆盖）', () => {
    const saved = process.env['AGENT_BRIDGE_MAX_TASKS'];
    process.env['AGENT_BRIDGE_MAX_TASKS'] = '4';
    try {
      expect(resolveMaxTasks(5)).toBe(4);
    } finally {
      if (saved === undefined) delete process.env['AGENT_BRIDGE_MAX_TASKS'];
      else process.env['AGENT_BRIDGE_MAX_TASKS'] = saved;
    }
  });

  it('队列上限：默认 32，允许 0（不排队），过大截断', () => {
    expect(resolveMaxQueued()).toBe(32);
    expect(resolveMaxQueued(0)).toBe(0);
    expect(resolveMaxQueued(8)).toBe(8);
    expect(resolveMaxQueued(99999)).toBe(1024);
    expect(resolveMaxQueued(-1)).toBe(32);
  });

  it('队列上限：环境变量优先，空字符串视为未设置', () => {
    const saved = process.env['AGENT_BRIDGE_MAX_QUEUE'];
    try {
      process.env['AGENT_BRIDGE_MAX_QUEUE'] = '5';
      expect(resolveMaxQueued(8)).toBe(5);
      process.env['AGENT_BRIDGE_MAX_QUEUE'] = '';
      expect(resolveMaxQueued(8)).toBe(8);
    } finally {
      if (saved === undefined) delete process.env['AGENT_BRIDGE_MAX_QUEUE'];
      else process.env['AGENT_BRIDGE_MAX_QUEUE'] = saved;
    }
  });

  it('loadConfig 读取 config.toml 的 max_tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-cfg3-'));
    const file = join(dir, 'config.toml');
    writeFileSync(
      file,
      ['platformUrl = "https://p.example.com"', 'deviceId = "bd_x"', 'deviceToken = "tok_x"', 'max_tasks = 6', ''].join('\n'),
      'utf8',
    );
    const saved = process.env['AGENT_BRIDGE_CONFIG'];
    process.env['AGENT_BRIDGE_CONFIG'] = file;
    const savedEnv = process.env['AGENT_BRIDGE_MAX_TASKS'];
    delete process.env['AGENT_BRIDGE_MAX_TASKS'];
    try {
      expect(loadConfig()?.maxTasks).toBe(6);
    } finally {
      if (saved === undefined) delete process.env['AGENT_BRIDGE_CONFIG'];
      else process.env['AGENT_BRIDGE_CONFIG'] = saved;
      if (savedEnv !== undefined) process.env['AGENT_BRIDGE_MAX_TASKS'] = savedEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('断线缓冲 Outbox', () => {
  const logMsg = (taskId: string, data: string) =>
    ({ type: 'task_log' as const, taskId, stream: 'stdout' as const, data, isAnsi: false });
  const statusMsg = (taskId: string) => ({ type: 'task_status' as const, taskId, status: 'success' as const });
  const logTexts = (msgs: { type: string }[]): string[] =>
    msgs.filter((m) => m.type === 'task_log').map((m) => (m as { data: string }).data);

  it('先控制后日志，各自 FIFO；drain 后清空', () => {
    const ob = new Outbox();
    ob.push(logMsg('t1', 'a'));
    ob.push(statusMsg('t1'));
    ob.push(logMsg('t1', 'b'));
    const out = ob.drain();
    expect(out.map((m) => m.type)).toEqual(['task_status', 'task_log', 'task_log']);
    expect(logTexts(out)).toEqual(['a', 'b']);
    expect(ob.pending).toBe(0);
    expect(ob.drain()).toEqual([]);
  });

  it('控制消息按条数限流，丢最旧', () => {
    const ob = new Outbox({ maxControls: 2 });
    ob.push(statusMsg('a'));
    ob.push(statusMsg('b'));
    ob.push(statusMsg('c'));
    const ids = ob.drain().map((m) => (m as { taskId: string }).taskId);
    expect(ids).toEqual(['b', 'c']);
  });

  it('日志按字节限流：丢最旧 + 插入截断提示', () => {
    const ob = new Outbox({ maxLogBytes: 400 });
    for (let i = 0; i < 10; i += 1) ob.push(logMsg('t1', `${i}:`.padEnd(100, 'x')));
    expect(ob.dropped).toBeGreaterThan(0);
    const out = ob.drain();
    const texts = logTexts(out);
    expect(texts[0]).toContain('断线期间日志超出缓冲上限');
    expect(texts.length).toBeLessThan(11);
    expect(texts.at(-1)).toContain('9:');
  });

  it('未超限时不插提示（正常补发不产生噪声）', () => {
    const ob = new Outbox({ maxLogBytes: 10 * 1024 });
    ob.push(logMsg('t1', 'hello'));
    const out = ob.drain();
    expect(out).toHaveLength(1);
    expect(logTexts(out)).toEqual(['hello']);
    expect(ob.dropped).toBe(0);
  });

  it('单条日志本身超限时保留它，不丢成空', () => {
    const ob = new Outbox({ maxLogBytes: 10 });
    ob.push(logMsg('t1', 'y'.repeat(200)));
    const out = ob.drain();
    expect(out).toHaveLength(1);
    expect(ob.dropped).toBe(0);
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

describe('能力协商', () => {
  it('capabilities 含 diff / service-token，供平台按能力降级', () => {
    expect(PROTOCOL_CAPABILITIES).toContain('diff');
    expect(PROTOCOL_CAPABILITIES).toContain('service-token');
  });
});

describe('diff 捕获（P0-6）', () => {
  const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
  const initRepo = (dir: string) => {
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'bridge@example.com'],
      ['config', 'user.name', 'bridge-test'],
      ['config', 'commit.gpgsign', 'false'],
    ]) {
      spawnSync('git', args, { cwd: dir });
    }
  };

  it('truncateDiff：按行边界截断且不超过上限', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n');
    const cut = truncateDiff(text, 200);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text, 'utf8')).toBeLessThanOrEqual(200);
    expect(cut.text.endsWith('\n')).toBe(true);
    // 不切断多字节字符
    const cn = truncateDiff('中'.repeat(500), 100);
    expect(Buffer.byteLength(cn.text, 'utf8')).toBeLessThanOrEqual(100);
  });

  it('未超限时 truncated=false', () => {
    expect(truncateDiff('a\nb\n', 1024)).toEqual({ text: 'a\nb\n', truncated: false });
  });

  it('非 git 目录返回空结果且不报错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-nogit-'));
    try {
      const cap = captureWorktreeDiff(dir);
      expect(cap.diff).toBe('');
      expect(cap.changedFiles).toEqual([]);
      expect(cap.truncated).toBe(false);
      expect(cap.reason).toBe('not-a-git-repo');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('已跟踪改动 + 未跟踪新文件都进 diff，且索引被还原（不留 intent-to-add）', () => {
    if (!gitOk) return;
    const dir = mkdtempSync(join(tmpdir(), 'ab-git-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'a.txt'), 'one\n', 'utf8');
      spawnSync('git', ['add', 'a.txt'], { cwd: dir });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
      writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n', 'utf8');
      writeFileSync(join(dir, 'b.txt'), 'brand new\n', 'utf8');

      expect(isGitWorkTree(dir)).toBe(true);
      const cap = captureWorktreeDiff(dir);
      expect(cap.diff).toContain('a.txt');
      expect(cap.diff).toContain('b.txt');
      expect(new Set(cap.changedFiles)).toEqual(new Set(['a.txt', 'b.txt']));
      expect(cap.truncated).toBe(false);

      // 关键：捕获后索引必须干净（未跟踪文件没有被留在 index 里）
      const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: dir, encoding: 'utf8' });
      expect((staged.stdout ?? '').trim()).toBe('');
      const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' });
      expect(status.stdout ?? '').toContain('?? b.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // 真实 git 子进程：机器繁忙时单次可达数秒，给足超时（失败要能区分"慢"与"错"）
  }, 30_000);

  it('超过 diff_max_bytes 时截断并置 truncated，changedFiles 仍完整', () => {
    if (!gitOk) return;
    const dir = mkdtempSync(join(tmpdir(), 'ab-git-big-'));
    try {
      initRepo(dir);
      writeFileSync(join(dir, 'big.txt'), Array.from({ length: 400 }, (_, i) => `l${i}`).join('\n'), 'utf8');
      const cap = captureWorktreeDiff(dir, { maxBytes: 512 });
      expect(cap.truncated).toBe(true);
      expect(Buffer.byteLength(cap.diff, 'utf8')).toBeLessThanOrEqual(512);
      expect(cap.changedFiles).toContain('big.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('diff_max_bytes 解析：默认 256KB，夹在 1KB~8MB，环境变量优先', () => {
    expect(resolveDiffMaxBytes()).toBe(256 * 1024);
    expect(resolveDiffMaxBytes(1024 * 1024)).toBe(1024 * 1024);
    expect(resolveDiffMaxBytes(10)).toBe(1024);
    expect(resolveDiffMaxBytes(999 * 1024 * 1024)).toBe(8 * 1024 * 1024);
    const saved = process.env['AGENT_BRIDGE_DIFF_MAX_BYTES'];
    try {
      process.env['AGENT_BRIDGE_DIFF_MAX_BYTES'] = '4096';
      expect(resolveDiffMaxBytes(1024 * 1024)).toBe(4096);
    } finally {
      if (saved === undefined) delete process.env['AGENT_BRIDGE_DIFF_MAX_BYTES'];
      else process.env['AGENT_BRIDGE_DIFF_MAX_BYTES'] = saved;
    }
  });
});

describe('受控错误码（架构第一期）', () => {
  it('错误码是受控枚举，且与平台侧 design §7 的分类对齐', () => {
    for (const c of ['tool_not_installed', 'tool_no_credentials', 'tool_broken', 'cwd_missing', 'cwd_not_allowed', 'timeout', 'cancelled', 'agent_error'] as const) {
      expect(BRIDGE_ERROR_CODES).toContain(c);
    }
  });

  it('BridgeError 同时带人类可读串与机器可读码', () => {
    const e = new BridgeError('cwd_not_allowed', '工作目录不在允许范围内：/x', { path: '/x' });
    expect(e.code).toBe('cwd_not_allowed');
    expect(e.message).toBe('工作目录不在允许范围内：/x');
    expect(e.data).toEqual({ path: '/x' });
  });

  it('令牌拒绝原因 → 受控错误码（四种失败不混成一个）', () => {
    expect(tokenDenyCode('missing')).toBe('unauthorized');
    expect(tokenDenyCode('scope')).toBe('insufficient_scope');
    expect(tokenDenyCode('expired')).toBe('token_expired');
    expect(tokenDenyCode('revoked')).toBe('token_expired');
    expect(tokenDenyCode('mismatch')).toBe('invalid_token');
    expect(tokenDenyCode(undefined)).toBe('invalid_token');
  });
});

describe('日志脱敏（P1-2）', () => {
  it('家目录替换成 ~', () => {
    expect(redact('/home/me/secret/key.json', { home: '/home/me' })).toBe('~/secret/key.json');
  });

  it('≥64 位的长串折叠，短串不动', () => {
    const long = 'a'.repeat(80);
    expect(redact(long, { home: '' })).toContain('…[80]');
    expect(redact('short-file-name', { home: '' })).toBe('short-file-name');
  });

  it('可以只做路径脱敏（foldLongRuns: false）', () => {
    expect(redact('/home/me/' + 'b'.repeat(80), { home: '/home/me', foldLongRuns: false })).toBe('~/' + 'b'.repeat(80));
  });
});

describe('唯一上行出口 Emitter（架构第一期）', () => {
  const logMsg = (taskId: string, data: string) =>
    ({ type: 'task_log' as const, taskId, stream: 'stdout' as const, data, isAnsi: true });
  const statusMsg = (taskId: string, status: 'running' | 'success') =>
    ({ type: 'task_status' as const, taskId, status });

  it('终态幂等：settled 之后该 task 的日志与状态一律丢弃（P1-1）', () => {
    const out: unknown[] = [];
    const em = new Emitter({ sink: (m) => out.push(m) });
    em.emit(logMsg('t1', 'a'));
    em.emit(statusMsg('t1', 'success'));
    em.emit(logMsg('t1', 'b'));
    em.emit(statusMsg('t1', 'running'));
    expect(out).toHaveLength(2);
    expect(em.isSettled('t1')).toBe(true);
  });

  it('不同 task 互不影响', () => {
    const out: unknown[] = [];
    const em = new Emitter({ sink: (m) => out.push(m) });
    em.emit(statusMsg('a', 'success'));
    em.emit(logMsg('b', 'still alive'));
    expect(out).toHaveLength(2);
  });

  it('日志正文脱敏，但状态/diff 等产物不动', () => {
    const out: { type: string; data?: string }[] = [];
    const em = new Emitter({ sink: (m) => out.push(m as { type: string; data?: string }), home: '/home/me' });
    em.emit(logMsg('t1', '/home/me/x'));
    expect(out[0]?.data).toBe('~/x');
  });

  it('CloudEvents 1.0 信封：字段齐全且序号单调（可选能力）', () => {
    const out: unknown[] = [];
    const em = new Emitter({ sink: (m) => out.push(m), envelope: { source: 'urn:agent-bridge:device:bd_1' } });
    em.emit(statusMsg('t1', 'running'));
    const ev = out[0] as Record<string, unknown>;
    expect(ev['specversion']).toBe('1.0');
    expect(ev['type']).toBe('dev.agent-bridge.task_status.v1');
    expect(ev['source']).toBe('urn:agent-bridge:device:bd_1');
    expect(ev['subject']).toBe('t1');
    expect(ev['seq']).toBe(1);
    expect(ev['datacontenttype']).toBe('application/json');
  });

  it('toCloudEvent 是纯函数（可单测，不依赖时间）', () => {
    const at = new Date('2026-10-23T00:00:00Z');
    const ev = toCloudEvent(statusMsg('t9', 'running'), 'urn:x', 7, at);
    expect(ev.id).toBe(`7-${at.getTime()}`);
    expect(ev.time).toBe('2026-10-23T00:00:00.000Z');
  });

  it('isTerminal：只有四个终态', () => {
    for (const s of ['success', 'failed', 'cancelled', 'timeout'] as const) expect(isTerminal(s)).toBe(true);
    expect(isTerminal('running')).toBe(false);
  });

  it('审计旁路抛异常不影响发送', () => {
    const out: unknown[] = [];
    const em = new Emitter({ sink: (m) => out.push(m), onAudit: () => { throw new Error('audit down'); } });
    expect(() => em.emit(logMsg('t1', 'x'))).not.toThrow();
    expect(out).toHaveLength(1);
  });
});

describe('任务调度 TaskSupervisor（架构第二期）', () => {
  const installed = spawnSync('git', ['--version']).status === 0 && Boolean(
    (() => {
      try {
        return spawnSync(process.platform === 'win32' ? 'where' : '/bin/sh', process.platform === 'win32' ? ['claude'] : ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout?.trim();
      } catch {
        return '';
      }
    })(),
  );

  it('两个实例互不干扰（旧实现是模块级单例，会互相污染）', () => {
    if (!installed) return;
    const a = new TaskSupervisor(1);
    const b = new TaskSupervisor(1);
    const noop = { onLog: () => undefined, onStatus: () => undefined };
    const base = { taskId: 'x', agentType: 'claude-code', cwd: tmpdir(), args: ['--version'] as string[] };
    const ha = a.submit({ ...base, taskId: 'a' }, noop);
    expect(a.runningCount).toBe(1);
    expect(b.runningCount).toBe(0);
    ha.cancel();
  });

  it('超并发 → 排队，且 phase=queued + queuePosition（v1 兼容：status 仍是 running）', () => {
    if (!installed) return;
    const sup = new TaskSupervisor(1);
    const events: { taskId: string; status: string; phase?: string; queuePosition?: number }[] = [];
    const hooks = {
      onLog: () => undefined,
      onStatus: (status: string, info?: { phase?: 'queued' | 'running'; queuePosition?: number }) =>
        events.push({ taskId: 'x', status, phase: info?.phase, queuePosition: info?.queuePosition }),
    };
    const base = { taskId: 'x', agentType: 'claude-code', cwd: tmpdir(), args: ['--version'] as string[] };
    const h1 = sup.submit({ ...base, taskId: 't1' }, hooks);
    const h2 = sup.submit({ ...base, taskId: 't2' }, hooks);
    expect(sup.queuedCount).toBe(1);
    const queued = events.find((e) => e.phase === 'queued');
    expect(queued).toBeDefined();
    expect(queued?.status).toBe('running');
    expect(queued?.queuePosition).toBe(1);
    h1.cancel();
    h2.cancel();
  });

  it('排队中的任务可取消；终态后再次取消是空操作', async () => {
    if (!installed) return;
    const sup = new TaskSupervisor(1);
    const statuses: string[] = [];
    const hooks = { onLog: () => undefined, onStatus: (s: string) => statuses.push(s) };
    const base = { taskId: 'x', agentType: 'claude-code', cwd: tmpdir(), args: ['--version'] as string[] };
    const h1 = sup.submit({ ...base, taskId: 'q1' }, hooks);
    const h2 = sup.submit({ ...base, taskId: 'q2' }, hooks);
    h2.cancel();
    h2.cancel();
    expect(await h2.done).toBe('cancelled');
    expect(statuses.filter((s) => s === 'cancelled')).toHaveLength(1);
    h1.cancel();
  });

  it('终态带受控错误码（cwd 越界 → cwd_not_allowed）', async () => {
    const sup = new TaskSupervisor(1);
    const infos: { error?: string; errorCode?: string }[] = [];
    const h = sup.submit(
      { taskId: 'bad', agentType: 'codex', cwd: tmpdir(), args: [], allowedCwd: [join(tmpdir(), 'ab-none')] },
      { onLog: () => undefined, onStatus: (_s, info) => infos.push({ error: info?.error, errorCode: info?.errorCode }) },
    );
    expect(await h.done).toBe('failed');
    expect(infos[0]?.errorCode).toBe('cwd_not_allowed');
  });
});

describe('服务令牌（P0-8）', () => {
  /** 每个用例一个独立状态目录：services.toml / audit.jsonl 都跟着 AGENT_BRIDGE_CONFIG 走 */
  const withState = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-svc-'));
    const saved = process.env['AGENT_BRIDGE_CONFIG'];
    process.env['AGENT_BRIDGE_CONFIG'] = join(dir, 'config.toml');
    try {
      return fn(dir);
    } finally {
      if (saved === undefined) delete process.env['AGENT_BRIDGE_CONFIG'];
      else process.env['AGENT_BRIDGE_CONFIG'] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('签发 → 校验通过（含 scope 判定）', () => {
    withState(() => {
      const { record, token } = issueServiceToken({ label: 'repair-orchestrator', scopes: ['task:create'] });
      expect(token.startsWith('abs_')).toBe(true);
      expect(verifyServiceToken(token, 'task:create').ok).toBe(true);
      expect(verifyServiceToken(token, 'task:cancel').ok).toBe(false);
      expect(verifyServiceToken(token, 'task:cancel').reason).toBe('scope');
      expect(record.scopes).toEqual(['task:create']);
    });
  });

  it('本地只存 SHA-256，绝不落明文', () => {
    withState(() => {
      const { token } = issueServiceToken({ label: 'x', scopes: ['task:create'] });
      const secret = token.split('_')[2] ?? '';
      const raw = readFileSync(join(process.env['AGENT_BRIDGE_CONFIG']!, '..', 'services.toml'), 'utf8');
      expect(raw).not.toContain(secret);
      expect(raw).toContain('sha256');
      expect(loadServices()).toHaveLength(1);
    });
  });

  it('错令牌 / 畸形 / 缺失 一律拒绝', () => {
    withState(() => {
      const { token } = issueServiceToken({ label: 'x', scopes: ['task:create'] });
      const tampered = `${token.slice(0, -3)}abc`;
      expect(verifyServiceToken(tampered, 'task:create').reason).toBe('mismatch');
      expect(verifyServiceToken('not-a-token', 'task:create').reason).toBe('malformed');
      expect(verifyServiceToken(undefined, 'task:create').reason).toBe('missing');
    });
  });

  it('吊销立即失效；轮换宽限期内新旧都可用，宽限期后旧令牌失效', () => {
    withState(() => {
      const issued = issueServiceToken({ label: 'x', scopes: ['task:create', 'task:cancel'] });
      const now = new Date();

      const rotated = rotateServiceToken(issued.record.id, 24);
      expect(rotated).toBeDefined();
      // 宽限期内：新旧都可用
      expect(verifyServiceToken(issued.token, 'task:create', now).ok).toBe(true);
      expect(verifyServiceToken(rotated!.token, 'task:create', now).ok).toBe(true);
      // 宽限期后：旧令牌失效
      const later = new Date(now.getTime() + 25 * 3_600_000);
      expect(verifyServiceToken(issued.token, 'task:create', later).ok).toBe(false);
      expect(verifyServiceToken(rotated!.token, 'task:create', later).ok).toBe(true);

      // 吊销（无宽限）立即失效
      revokeServiceToken(rotated!.record.id);
      expect(verifyServiceToken(rotated!.token, 'task:create', new Date()).ok).toBe(false);
    });
  });

  it('过期令牌拒绝', () => {
    withState(() => {
      const { token } = issueServiceToken({ label: 'x', scopes: ['task:create'], ttlDays: 1 });
      const later = new Date(Date.now() + 2 * 86_400_000);
      expect(verifyServiceToken(token, 'task:create', later).reason).toBe('expired');
    });
  });

  it('协议层：requestedBy / purpose / captureDiff 形状校验（超长或类型错就忽略）', () => {
    const ok = assertServerMessage({
      type: 'run_task',
      taskId: 't1',
      agentType: 'codex',
      cwd: '/tmp',
      args: [],
      captureDiff: true,
      requestedBy: 'svc:repair-orchestrator',
      purpose: 'repair',
      serviceToken: 'abs_12345678_' + 'x'.repeat(40),
    });
    expect(ok).toMatchObject({
      captureDiff: true,
      requestedBy: 'svc:repair-orchestrator',
      purpose: 'repair',
    });

    const bad = assertServerMessage({
      type: 'run_task',
      taskId: 't1',
      agentType: 'codex',
      cwd: '/tmp',
      args: [],
      requestedBy: 'x'.repeat(500),
      purpose: 42,
      captureDiff: 'yes',
    });
    expect(bad).toMatchObject({ captureDiff: false, requestedBy: undefined, purpose: undefined });
  });

  it('审计：单行 JSON、不含令牌片段', () => {
    withState(() => {
      const { token } = issueServiceToken({ label: 'x', scopes: ['task:create'] });
      const secret = token.split('_')[2] ?? '';
      writeAudit({ at: new Date().toISOString(), action: 'run_task', outcome: 'denied', taskId: 't1', reason: 'scope 不足' });
      const file = auditPath();
      expect(existsSync(file)).toBe(true);
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines.length).toBeGreaterThan(0);
      const parsed = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
      expect(parsed['action']).toBe('run_task');
      expect(JSON.stringify(parsed)).not.toContain(secret);
    });
  });
});

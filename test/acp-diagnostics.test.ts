/**
 * ACP runner 的**可诊断性**用例。
 *
 * 这些断言对应一次真实排障：8 个工具失败时，bridge 把 stderr 丢掉、又把产品名写死成
 * CodeBuddy，于是用户只看到「CodeBuddy ACP 进程退出（code 1）」——
 * 既不知道是哪个工具，也不知道为什么。文案与 stderr 采集必须被锁住。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ACP_STDERR_TAIL_LIMIT, createStderrTail, runAcpPrompt, tailOf } from '../src/adapters/acp-codebuddy.js';
import { acpSpecFor, agentDefOf, meetsMinVersion, pickPreferredBin } from '../src/adapters/agent-adapters.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function scriptDir(source: string): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-diag-'));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 下句柄释放可能滞后；临时目录留给系统清理 */
    }
  });
  const script = join(dir, 'fake-acp.cjs');
  writeFileSync(script, source);
  return { dir, script };
}

describe('stderr 尾部缓冲', () => {
  it('tailOf 保留末尾，短文本原样返回', () => {
    expect(tailOf('abc', 10)).toBe('abc');
    expect(tailOf('abcdef', 3)).toBe('def');
  });

  it('超过上限后只留尾部，不会无限增长', () => {
    const tail = createStderrTail(10);
    tail.push('12345');
    tail.push('67890');
    tail.push('ABCDE');
    expect(tail.text()).toBe('67890ABCDE');
    expect(tail.text().length).toBe(10);
  });

  it('默认上限是 4 KiB', () => {
    expect(ACP_STDERR_TAIL_LIMIT).toBe(4 * 1024);
  });
});

describe('ACP 失败文案', () => {
  it('用 spec.label 而不是写死的 CodeBuddy', async () => {
    const { dir, script } = scriptDir('process.stderr.write("boot failed\\n"); process.exit(3);\n');
    await expect(
      runAcpPrompt({
        cwd: dir,
        prompt: 'hi',
        spec: { command: process.execPath, args: [script], sanitizeHostEnv: false, label: 'Trae CLI' },
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/^Trae CLI 进程退出（code 3）/);
  });

  it('label 缺省回落到 ACP，不猜产品名', async () => {
    const { dir, script } = scriptDir('process.exit(1);\n');
    await expect(
      runAcpPrompt({
        cwd: dir,
        prompt: 'hi',
        spec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/^ACP 进程退出（code 1）/);
  });

  it('把子进程 stderr 尾部带进错误消息（opencode 的配置错就是这样被看见的）', async () => {
    const { dir, script } = scriptDir(
      'process.stderr.write("Configuration is invalid at opencode.json\\n"); process.exit(1);\n',
    );
    const failure = runAcpPrompt({
      cwd: dir,
      prompt: 'hi',
      spec: { command: process.execPath, args: [script], sanitizeHostEnv: false, label: 'OpenCode' },
      timeoutMs: 10_000,
    });
    await expect(failure).rejects.toThrow(/OpenCode 进程退出（code 1）：[\s\S]*Configuration is invalid/);
  });

  it('stderr 诊断保留 URL 路径但剥离 query/fragment，短认证 code 也不上行', async () => {
    const { dir, script } = scriptDir(
      'process.stderr.write("https://accounts.example.test/oauth?code=short-secret&state=abc#fragment\\n"); process.exit(1);\n',
    );
    let message = '';
    try {
      await runAcpPrompt({
        cwd: dir,
        prompt: 'hi',
        spec: { command: process.execPath, args: [script], sanitizeHostEnv: false, label: 'OpenCode' },
        timeoutMs: 10_000,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('https://accounts.example.test/oauth');
    expect(message).not.toContain('short-secret');
    expect(message).not.toContain('state=abc');
    expect(message).not.toContain('fragment');
  });

  it('声明了认证方式却没登录 → 失败时追加登录提示（不硬失败，mimo 这类仍能跑）', async () => {
    const { dir, script } = scriptDir(String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: 1, authMethods: [{ id: 'opencode-login', name: 'Login' }] } }) + '\n');
    return;
  }
  if (m.method === 'session/new') {
    process.stderr.write('not logged in\n');
    process.exit(2);
  }
});
`);
    const failure = runAcpPrompt({
      cwd: dir,
      prompt: 'hi',
      spec: {
        command: process.execPath,
        args: [script],
        sanitizeHostEnv: false,
        label: 'Mimo Code',
        loginCommand: 'mimo',
      },
      timeoutMs: 10_000,
    });
    await expect(failure).rejects.toThrow(/Mimo Code 进程退出（code 2）/);
    // 既给「跑哪条命令」，也给「agent 声明的认证方式」作为证据
    await expect(failure).rejects.toThrow(/请先运行 `mimo` 完成登录/);
    await expect(failure).rejects.toThrow(/opencode-login/);
  });
});

describe('可执行文件选择', () => {
  it('.exe 优先于 .cmd（.cmd 是垫片，ACP 直接 spawn 会 EINVAL）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-bin-pick-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* 留给系统清理 */
      }
    });
    const cmd = join(dir, 'tool.cmd');
    const exe = join(dir, 'tool.exe');
    writeFileSync(cmd, '@echo off\n');
    writeFileSync(exe, '');
    // where 的输出顺序不保证：即便 .cmd 排在前面也要挑到 .exe
    expect(pickPreferredBin([cmd, exe])).toBe(exe);
    expect(pickPreferredBin([exe, cmd])).toBe(exe);
  });

  it('只有 .cmd 时退回 .cmd（交给调用方用 shell 转发）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-bin-shim-'));
    cleanups.push(() => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* 留给系统清理 */
      }
    });
    const cmd = join(dir, 'only.cmd');
    writeFileSync(cmd, '@echo off\n');
    expect(pickPreferredBin([cmd])).toBe(cmd);
  });

  it('全都不是文件时返回 undefined（不猜）', () => {
    expect(pickPreferredBin(['', '  ', join(tmpdir(), 'definitely-missing-xyz-123')])).toBeUndefined();
  });
});

describe('版本门禁', () => {
  it('低于最低版本判 false（本机 dsh 0.1.5-rc.3 就是这种）', () => {
    expect(meetsMinVersion('0.1.5-rc.3', '0.2.0')).toBe(false);
  });

  it('达到或超过判 true', () => {
    expect(meetsMinVersion('0.2.0', '0.2.0')).toBe(true);
    expect(meetsMinVersion('0.2.1', '0.2.0')).toBe(true);
    expect(meetsMinVersion('1.0.0', '0.2.0')).toBe(true);
  });

  it('prerelease 低于同号正式版', () => {
    expect(meetsMinVersion('0.2.0-rc.1', '0.2.0')).toBe(false);
  });

  it('解析不出来时不判死（宁可放行让人真跑一次）', () => {
    expect(meetsMinVersion(undefined, '0.2.0')).toBe(true);
    expect(meetsMinVersion('weird-build', '0.2.0')).toBe(true);
  });

  it('dsh 声明了 minVersion 0.2.0', () => {
    expect(agentDefOf('ds-harness')?.minVersion).toBe('0.2.0');
  });
});

describe('acpSpecFor', () => {
  it('给 spec 补上 display 作为 label', () => {
    const spec = acpSpecFor(agentDefOf('trae-cli'));
    expect(spec?.label).toBe('Trae CLI');
  });

  it('没有 acp 声明的工具返回 undefined', () => {
    expect(acpSpecFor(agentDefOf('qoder-cli'))).toBeUndefined();
  });

  it('已知工具返回 undefined 时不抛', () => {
    expect(acpSpecFor(undefined)).toBeUndefined();
  });
});

describe('实跑复核过的 ACP 启动参数', () => {
  it('trae-cli 必须带 serve 子命令（裸 acp 只打帮助并 exit 0）', () => {
    expect(agentDefOf('trae-cli')?.acp?.args).toEqual(['acp', 'serve']);
  });

  it('grok 不写死 authMethod（实测 session/new 无需 authenticate，写死 grok.com 会触发浏览器登录）', () => {
    const spec = agentDefOf('grok-cli')?.acp;
    expect(spec?.authMethod).toBeUndefined();
    // 只在真的有 XAI_API_KEY 时才走 API key 通道
    expect(spec?.authEnvMethods).toEqual({ XAI_API_KEY: 'xai.api_key' });
  });

  it('ds-harness 声明为 automation-only（不发 permission 请求）', () => {
    expect(agentDefOf('ds-harness')?.acpInteractionKinds).toEqual([]);
  });
});

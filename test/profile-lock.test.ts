import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withProfileLock } from '../src/infra/profile-lock.js';

let stateDir: string;
let lockPath: string;
const children = new Set<ChildProcessWithoutNullStreams>();

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'agent-bridge-profile-lock-'));
  lockPath = join(stateDir, 'profile.lock');
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await rm(stateDir, { recursive: true, force: true });
  children.clear();
});

function lockRecord(overrides: Record<string, unknown> = {}) {
  return {
    ownerToken: '11111111-1111-4111-8111-111111111111',
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

async function putLock(record: Record<string, unknown> | string = lockRecord()) {
  await writeFile(lockPath, typeof record === 'string' ? record : JSON.stringify(record), 'utf8');
}

function deadPid(): number {
  for (let pid = 1_000_000; pid < 1_001_000; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH') return pid;
    }
  }
  throw new Error('测试无法找到已确认不存在的 PID');
}

function nodeScript(body: string): string {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/infra/profile-lock.ts')).href;
  return `import { withProfileLock } from ${JSON.stringify(moduleUrl)};\n${body}`;
}

function spawnNode(script: string): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

async function runNode(script: string): Promise<void> {
  const child = spawnNode(script);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const [code] = (await once(child, 'exit')) as [number | null];
  expect(code, stderr).toBe(0);
}

describe('withProfileLock 同进程与跨进程语义', { timeout: 15_000 }, () => {
  it('同进程同 profile 后续调用等待并串行', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withProfileLock(stateDir, async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 1;
    });
    await vi.waitFor(() => expect(events).toEqual(['first:start']));

    const second = withProfileLock(stateDir, async () => {
      events.push('second:start');
      return 2;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('跨进程锁存在时明确报告已有绑定进行中', async () => {
    const started = join(stateDir, 'started');
    const child = spawnNode(nodeScript(`
      import { writeFile } from 'node:fs/promises';
      let release;
      const released = new Promise((resolve) => { release = resolve; });
      process.stdin.once('data', () => release());
      await withProfileLock(${JSON.stringify(stateDir)}, async () => {
        await writeFile(${JSON.stringify(started)}, 'ready', 'utf8');
        await released;
      });
    `));
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });

    try {
      await vi.waitFor(async () => expect(await readFile(started, 'utf8')).toBe('ready'), { timeout: 10_000 });
      await expect(withProfileLock(stateDir, async () => undefined)).rejects.toThrow(/已有绑定进行中/);
    } finally {
      child.stdin.write('release\n');
      child.stdin.end();
      await waitForExit(child);
    }
    expect(child.exitCode, stderr).toBe(0);
  });

  it('锁内调用方能读到前一进程写入的状态', async () => {
    const stateFile = join(stateDir, 'state.json');
    await runNode(nodeScript(`
      import { writeFile } from 'node:fs/promises';
      await withProfileLock(${JSON.stringify(stateDir)}, async () => {
        await writeFile(${JSON.stringify(stateFile)}, '{"bound":true}', 'utf8');
      });
    `));

    await expect(withProfileLock(stateDir, () => readFile(stateFile, 'utf8'))).resolves.toBe('{"bound":true}');
  });
});

describe('锁所有权与异常释放', () => {
  it('锁文件记录 ownerToken、pid、hostname 和 createdAt', async () => {
    await withProfileLock(stateDir, async () => {
      const record = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      expect(record['ownerToken']).toEqual(expect.any(String));
      expect(record['pid']).toBe(process.pid);
      expect(record['hostname']).toBe(hostname());
      expect(Number.isNaN(Date.parse(String(record['createdAt'])))).toBe(false);
    });
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finally 不释放 ownerToken 不同的锁', async () => {
    const foreign = lockRecord({ ownerToken: '22222222-2222-4222-8222-222222222222' });
    await withProfileLock(stateDir, async () => {
      await putLock(foreign);
    });

    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(foreign);
  });

  it('回调抛错时仍释放自己的锁并原样传播异常', async () => {
    await expect(withProfileLock(stateDir, async () => {
      throw new Error('callback failed');
    })).rejects.toThrow('callback failed');
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('stale lock 安全回收', () => {
  it('同 hostname 且活 PID 时不能仅凭时间强拆', async () => {
    const active = lockRecord();
    await putLock(active);

    await expect(withProfileLock(stateDir, async () => undefined)).rejects.toThrow(/已有绑定进行中/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(active);
  });

  it('同 hostname 且 PID 确认不存在时回收 stale lock', async () => {
    await putLock(lockRecord({ pid: deadPid() }));

    await expect(withProfileLock(stateDir, async () => 'recovered')).resolves.toBe('recovered');
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('跨 hostname 或锁记录无法判断时安全失败并保留现场', async () => {
    const remote = lockRecord({ pid: deadPid(), hostname: `${hostname()}-other` });
    await putLock(remote);
    await expect(withProfileLock(stateDir, async () => undefined)).rejects.toThrow(/无法安全回收|已有绑定进行中/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(remote);

    await putLock('not json');
    await expect(withProfileLock(stateDir, async () => undefined)).rejects.toThrow(/无法安全回收|锁记录.*无效/);
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('not json');
  });

  it('stale 判断期间锁发生变化则不 unlink 新锁', async () => {
    await putLock(lockRecord({ pid: deadPid() }));
    const replacement = lockRecord({ ownerToken: '33333333-3333-4333-8333-333333333333' });
    vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      writeFileSync(lockPath, JSON.stringify(replacement), 'utf8');
      throw Object.assign(new Error('injected stale pid'), { code: 'ESRCH' });
    });

    await expect(withProfileLock(stateDir, async () => undefined)).rejects.toThrow(/变化|已有绑定进行中/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(replacement);
  });

  it('recovery guard 持有期间，其他回收者不能删除后来出现的新锁', async () => {
    const stale = lockRecord({ pid: deadPid() });
    await putLock(stale);
    await writeFile(`${lockPath}.recovery`, 'another-recovery-owner', 'utf8');

    await expect(withProfileLock(stateDir, async () => undefined)).rejects.toThrow(/已有绑定进行中/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(stale);

    const replacement = lockRecord({ ownerToken: '44444444-4444-4444-8444-444444444444' });
    await putLock(replacement);
    await expect(withProfileLock(stateDir, async () => undefined)).rejects.toThrow(/已有绑定进行中/);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(replacement);
  });
});

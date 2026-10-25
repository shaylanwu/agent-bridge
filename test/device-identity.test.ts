import { execFile } from 'node:child_process';
import { link, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_PATTERN, assertDeviceId } from '../src/core/device-identity.js';
import { writeAtomicFile } from '../src/infra/atomic-file.js';
import { ensureDeviceIdentity } from '../src/infra/device-identity-store.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link), readFile: vi.fn(actual.readFile), rename: vi.fn(actual.rename) };
});

const execFileAsync = promisify(execFile);

const ID_12 = 'bd_0123456789ab';
const ID_32 = 'bd_0123456789abcdef0123456789abcdef';

let stateDir: string;
let identityPath: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'agent-bridge-identity-'));
  identityPath = join(stateDir, 'identity.toml');
});

afterEach(async () => {
  vi.mocked(link).mockClear();
  vi.mocked(readFile).mockClear();
  vi.mocked(rename).mockClear();
  await rm(stateDir, { recursive: true, force: true });
});

function options(overrides: Partial<Parameters<typeof ensureDeviceIdentity>[0]> = {}) {
  return {
    identityPath,
    allowCreate: true,
    hasReusableCredential: false,
    ...overrides,
  };
}

describe('device ID 格式', () => {
  it('只接受 bd_ 加 32 或 12 位小写 hex', () => {
    expect(DEVICE_ID_PATTERN.test(ID_32)).toBe(true);
    expect(DEVICE_ID_PATTERN.test(ID_12)).toBe(true);
    expect(assertDeviceId(ID_32)).toBe(ID_32);

    for (const value of [
      '',
      'bd_',
      'bd_0123456789ABC',
      'BD_0123456789ab',
      'bd_0123456789a',
      'bd_0123456789abc',
      'bd_0123456789abcdef0123456789abcde',
      'bd_0123456789abcdef0123456789abcdef0',
      'bd_0123456789ag',
      '0123456789ab',
      null,
      42,
    ]) {
      expect(() => assertDeviceId(value)).toThrow(/格式/);
    }
  });
});

describe('身份创建、迁移与严格读取', () => {
  it('授权前用 16 字节随机源创建并持久化新身份', async () => {
    const identity = await ensureDeviceIdentity(options());

    expect(identity.source).toBe('created');
    expect(identity.deviceId).toMatch(/^bd_[0-9a-f]{32}$/);
    await expect(readFile(identityPath, 'utf8')).resolves.toContain(`device_id = "${identity.deviceId}"`);
  });

  it('旧 12 位 ID 原样迁移', async () => {
    const identity = await ensureDeviceIdentity(options({ legacyDeviceId: ID_12 }));

    expect(identity).toEqual({ deviceId: ID_12, source: 'migrated' });
    await expect(readFile(identityPath, 'utf8')).resolves.toContain(`device_id = "${ID_12}"`);
  });

  it.each([
    ['空文件', ''],
    ['TOML 损坏', 'schema_version = ['],
    ['不支持的 schema', `schema_version = 2\ndevice_id = "${ID_32}"\n`],
    ['非法 ID', `schema_version = 1\ndevice_id = "bd_UPPER"\n`],
  ])('%s 时抛错且不生成替代身份', async (_name, content) => {
    await writeFile(identityPath, content, 'utf8');

    await expect(ensureDeviceIdentity(options())).rejects.toThrow();
    await expect(readFile(identityPath, 'utf8')).resolves.toBe(content);
  });

  it('显式或镜像 ID 非法时不创建身份', async () => {
    for (const candidate of [{ explicitDeviceId: '' }, { envDeviceId: 'bd_bad' }, { legacyDeviceId: 'invalid' }]) {
      await expect(ensureDeviceIdentity(options(candidate))).rejects.toThrow(/格式/);
      await expect(readFile(identityPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});

describe('身份持久化与冲突', () => {
  it('连续三次读取只创建一次，之后复用相同身份', async () => {
    const first = await ensureDeviceIdentity(options());
    const second = await ensureDeviceIdentity(options({ allowCreate: false }));
    const third = await ensureDeviceIdentity(options({ allowCreate: false }));

    expect(first.source).toBe('created');
    expect(second).toEqual({ deviceId: first.deviceId, source: 'reused' });
    expect(third).toEqual(second);
  });

  it('EEXIST 时丢弃候选并读回已发布身份', async () => {
    vi.mocked(link).mockImplementationOnce(async () => {
      await writeFile(identityPath, `schema_version = 1\ndevice_id = "${ID_12}"\n`, 'utf8');
      throw Object.assign(new Error('injected EEXIST'), { code: 'EEXIST' });
    });

    const identity = await ensureDeviceIdentity(options());

    expect(identity).toEqual({ deviceId: ID_12, source: 'reused' });
    await expect(readFile(identityPath, 'utf8')).resolves.toContain(ID_12);
  });

  it('已有身份与任一显式值或兼容镜像冲突时拒绝', async () => {
    await writeFile(identityPath, `schema_version = 1\ndevice_id = "${ID_32}"\n`, 'utf8');

    for (const candidate of [
      { legacyDeviceId: ID_12 },
      { explicitDeviceId: ID_12 },
      { envDeviceId: ID_12 },
    ]) {
      await expect(ensureDeviceIdentity(options(candidate))).rejects.toThrow(/冲突/);
      await expect(readFile(identityPath, 'utf8')).resolves.toContain(ID_32);
    }
  });

  it('缺失身份时多个迁移来源值不同则拒绝，值相同则迁移', async () => {
    await expect(ensureDeviceIdentity(options({ legacyDeviceId: ID_12, explicitDeviceId: ID_32 }))).rejects.toThrow(/冲突/);
    await expect(readFile(identityPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(ensureDeviceIdentity(options({
      legacyDeviceId: ID_12,
      explicitDeviceId: ID_12,
      envDeviceId: ID_12,
    }))).resolves.toEqual({ deviceId: ID_12, source: 'migrated' });
  });

  it('有可复用凭证或禁止创建时，没有可迁移 ID 不会随机生成', async () => {
    await expect(ensureDeviceIdentity(options({ hasReusableCredential: true }))).rejects.toThrow(/凭证/);
    await expect(ensureDeviceIdentity(options({ allowCreate: false }))).rejects.toThrow(/显式/);
    await expect(readFile(identityPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('身份不可读时不进入生成路径', async () => {
    await writeFile(identityPath, `schema_version = 1\ndevice_id = "${ID_32}"\n`, 'utf8');
    const unreadable = join(stateDir, 'unreadable.toml');
    await writeFile(unreadable, 'not read', 'utf8');
    const readFailure = Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
    vi.mocked(readFile).mockRejectedValueOnce(readFailure);

    await expect(ensureDeviceIdentity(options({ identityPath: unreadable }))).rejects.toThrow(/读取/);
    expect(vi.mocked(readFile)).toHaveBeenCalledOnce();
    await expect(readFile(unreadable, 'utf8')).resolves.toBe('not read');
  });
});

describe('原子文件发布', () => {
  it('发布前 rename 失败保留旧文件且清理临时文件', async () => {
    const target = join(stateDir, 'config.toml');
    await writeFile(target, 'old = true\n', 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('injected EIO'), { code: 'EIO' }));

    await expect(writeAtomicFile(target, 'new = true\n')).rejects.toThrow(new RegExp('config.toml'));
    await expect(readFile(target, 'utf8')).resolves.toBe('old = true\n');
  });

  it('原子替换后文件完整可读', async () => {
    const target = join(stateDir, 'config.toml');
    await writeFile(target, 'old = true\n', 'utf8');

    await expect(writeAtomicFile(target, 'new = true\n')).resolves.toBe('written');
    await expect(readFile(target, 'utf8')).resolves.toBe('new = true\n');
  });

  it.runIf(process.platform !== 'win32')('POSIX 发布文件权限严格为 0600', async () => {
    await writeAtomicFile(identityPath, `schema_version = 1\ndevice_id = "${ID_32}"\n`, { overwrite: false });

    expect((await stat(identityPath)).mode & 0o777).toBe(0o600);
  });

  it.runIf(process.platform === 'win32')('Windows 发布前设置当前用户 ACL，发布后仍可读', async () => {
    await writeAtomicFile(identityPath, `schema_version = 1\ndevice_id = "${ID_32}"\n`, { overwrite: false });

    const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
    const { stdout: userOutput } = await execFileAsync(join(system32, 'whoami.exe'), [], { windowsHide: true });
    const { stdout: acl } = await execFileAsync(join(system32, 'icacls.exe'), [identityPath], { windowsHide: true });
    expect(acl.toLowerCase()).toContain(userOutput.trim().toLowerCase());
    expect(acl).not.toMatch(/\(I\)/);
    expect(acl).not.toMatch(/Everyone|BUILTIN\\Users|Authenticated Users/i);
    await expect(readFile(identityPath, 'utf8')).resolves.toContain(ID_32);
  });
});

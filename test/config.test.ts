import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EVENT_RETENTION_MAX_EVENTS,
  clearConfig,
  loadConfig,
  resolveEventRetentionMaxEvents,
  resolveSessionIdleMs,
  saveConfig,
  stateDbPath,
  type BoundBridgeConfig,
} from '../src/infra/config.js';

const DEVICE_ID = 'bd_0123456789abcdef0123456789abcdef';

let stateDir: string;
let file: string;
let previousConfig: string | undefined;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'agent-bridge-config-'));
  file = join(stateDir, 'config.toml');
  previousConfig = process.env['AGENT_BRIDGE_CONFIG'];
  process.env['AGENT_BRIDGE_CONFIG'] = file;
});

afterEach(async () => {
  if (previousConfig === undefined) delete process.env['AGENT_BRIDGE_CONFIG'];
  else process.env['AGENT_BRIDGE_CONFIG'] = previousConfig;
  await rm(stateDir, { recursive: true, force: true });
});

function boundConfig(overrides: Partial<BoundBridgeConfig> = {}): BoundBridgeConfig {
  return {
    platformUrl: 'https://platform.example.test',
    deviceId: DEVICE_ID,
    deviceToken: 'device-secret',
    ...overrides,
  };
}

describe('状态库路径', () => {
  it('默认与配置同目录，可由环境变量覆盖', () => {
    expect(stateDbPath()).toBe(join(stateDir, 'state.db'));
    const previous = process.env['AGENT_BRIDGE_STATE_DB'];
    process.env['AGENT_BRIDGE_STATE_DB'] = join(stateDir, 'custom.db');
    try {
      expect(stateDbPath()).toBe(join(stateDir, 'custom.db'));
    } finally {
      if (previous === undefined) delete process.env['AGENT_BRIDGE_STATE_DB'];
      else process.env['AGENT_BRIDGE_STATE_DB'] = previous;
    }
  });
});

describe('严格配置读取', () => {
  it('仅文件不存在时返回 null', async () => {
    expect(loadConfig()).toBeNull();
  });

  it.each([
    ['空文件', ''],
    ['TOML 损坏', 'platformUrl = ['],
  ])('%s 时抛出可操作错误', async (_name, content) => {
    await writeFile(file, content, 'utf8');

    expect(() => loadConfig()).toThrow(new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('读取发生非 ENOENT I/O 错误时抛出可操作错误', async () => {
    await mkdir(file);

    expect(() => loadConfig()).toThrow(/读取配置.*config\.toml/);
  });

  it('接受 logout 后的有效未绑定配置', async () => {
    await writeFile(file, `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\nmax_tasks = 6\n`, 'utf8');

    expect(loadConfig()).toMatchObject({
      platformUrl: 'https://platform.example.test',
      deviceId: DEVICE_ID,
      maxTasks: 6,
    });
    expect(loadConfig()).not.toHaveProperty('deviceToken');
  });

  it('兼容读取 legacy device_id，并镜像为 deviceId', async () => {
    await writeFile(file, `platformUrl = "https://platform.example.test"\ndevice_id = "${DEVICE_ID}"\ndeviceToken = "device-secret"\n`, 'utf8');

    expect(loadConfig()).toMatchObject({ deviceId: DEVICE_ID, deviceToken: 'device-secret' });
  });

  it.each([
    ['缺 platformUrl', `deviceId = "${DEVICE_ID}"\n`],
    ['缺 deviceId', 'platformUrl = "https://platform.example.test"\n'],
    ['非法 deviceId', 'platformUrl = "https://platform.example.test"\ndeviceId = "other-id"\n'],
    ['deviceToken 类型非法', `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\ndeviceToken = 42\n`],
    ['只有 refreshToken', `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\nrefreshToken = "refresh-secret"\n`],
    ['只有 boundAt', `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\nboundAt = "2026-10-25T00:00:00.000Z"\n`],
    ['refreshToken 为空', `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\ndeviceToken = "device-secret"\nrefreshToken = ""\n`],
    ['deviceId 镜像冲突', `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\ndevice_id = "bd_0123456789ab"\n`],
    ['业务设置结构非法', `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\ncontrol_plane = true\n`],
  ])('%s 时拒绝读取', async (_name, content) => {
    await writeFile(file, content, 'utf8');

    expect(() => loadConfig()).toThrow(/配置.*无效|配置.*冲突/);
  });
});

describe('配置原子保存与凭证清除', () => {
  it('[mcp.servers] 可解析并持久化', async () => {
    await writeFile(
      file,
      `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\n[mcp.servers.echo]\ncommand = "node"\nargs = ["server.js"]\ncwd = "."\n[mcp.servers.echo.env]\nNODE_ENV = "test"\n`,
      'utf8',
    );
    expect((await loadConfig())?.mcp?.servers.echo).toMatchObject({
      command: 'node',
      args: ['server.js'],
      cwd: '.',
      env: { NODE_ENV: 'test' },
    });
    await saveConfig(
      boundConfig({
        mcp: { servers: { echo: { command: 'node', args: ['server.js'] } } },
      }),
    );
    expect((await loadConfig())?.mcp?.servers.echo).toMatchObject({
      command: 'node',
      args: ['server.js'],
    });
  });

  it('[jwt] 可解析并持久化', async () => {
    await writeFile(
      file,
      `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\n[jwt]\njwks_url = "https://issuer.test/jwks"\naudience = "agent-bridge"\n`,
      'utf8',
    );
    expect((await loadConfig())?.jwt).toMatchObject({
      jwksUrl: 'https://issuer.test/jwks',
      audience: 'agent-bridge',
    });
    await saveConfig(
      boundConfig({
        jwt: { jwksUrl: 'https://issuer.test/jwks', issuer: 'iss', tenantClaim: 'tid' },
      }),
    );
    expect((await loadConfig())?.jwt).toMatchObject({
      jwksUrl: 'https://issuer.test/jwks',
      issuer: 'iss',
      tenantClaim: 'tid',
    });
  });

  it('session_idle_ms 可解析并持久化', async () => {
    await writeFile(
      file,
      `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\nsession_idle_ms = 5000\n`,
      'utf8',
    );
    expect((await loadConfig())?.sessionIdleMs).toBe(5000);
    await saveConfig(boundConfig({ sessionIdleMs: 7000 }));
    expect((await loadConfig())?.sessionIdleMs).toBe(7000);
    expect(await readFile(file, 'utf8')).toContain('session_idle_ms = 7000');
  });

  it('session_idle_ms 解析：空环境变量不覆盖配置', () => {
    const previous = process.env['AGENT_BRIDGE_SESSION_IDLE_MS'];
    delete process.env['AGENT_BRIDGE_SESSION_IDLE_MS'];
    try {
      expect(resolveSessionIdleMs(5000)).toBe(5000);
      process.env['AGENT_BRIDGE_SESSION_IDLE_MS'] = '';
      expect(resolveSessionIdleMs(5000)).toBe(5000);
      process.env['AGENT_BRIDGE_SESSION_IDLE_MS'] = '1234';
      expect(resolveSessionIdleMs(5000)).toBe(1234);
    } finally {
      if (previous === undefined) delete process.env['AGENT_BRIDGE_SESSION_IDLE_MS'];
      else process.env['AGENT_BRIDGE_SESSION_IDLE_MS'] = previous;
    }
  });

  it('event_retention_max_events 可解析并持久化', async () => {
    await writeFile(
      file,
      `platformUrl = "https://platform.example.test"\ndeviceId = "${DEVICE_ID}"\nevent_retention_max_events = 1234\n`,
      'utf8',
    );
    expect((await loadConfig())?.eventRetentionMaxEvents).toBe(1234);
    await saveConfig(boundConfig({ eventRetentionMaxEvents: 4321 }));
    expect((await loadConfig())?.eventRetentionMaxEvents).toBe(4321);
    expect(await readFile(file, 'utf8')).toContain('event_retention_max_events = 4321');
  });

  it('event_retention_max_events 解析：override > 配置 > 默认，0 合法、有上限夹取', () => {
    expect(resolveEventRetentionMaxEvents()).toBe(DEFAULT_EVENT_RETENTION_MAX_EVENTS);
    expect(resolveEventRetentionMaxEvents(800)).toBe(800);
    expect(resolveEventRetentionMaxEvents(800, 120)).toBe(120);
    // 0 = 不裁剪，是合法值，不能当成「未配置」回落默认
    expect(resolveEventRetentionMaxEvents(0)).toBe(0);
    expect(resolveEventRetentionMaxEvents(800, 0)).toBe(0);
    // 手滑写超大值不能让状态库无限长
    expect(resolveEventRetentionMaxEvents(9_999_999)).toBe(1_000_000);
    // 负数/小数一律收敛到合法区间
    expect(resolveEventRetentionMaxEvents(-5)).toBe(0);
    expect(resolveEventRetentionMaxEvents(10.9)).toBe(10);
  });

  it('保存传入的业务设置并写入同值 deviceId 镜像', async () => {
    const cfg = boundConfig({
      refreshToken: 'refresh-secret',
      allowedCwd: [stateDir],
      maxTasks: 6,
      maxQueued: 0,
      diffMaxBytes: 4096,
      diffDefault: true,
      requireServiceToken: true,
      controlPlane: { enabled: true, host: '127.0.0.1', port: 0, requireToken: false },
      label: 'test-device',
      boundAt: '2026-10-25T00:00:00.000Z',
    });

    await expect(saveConfig(cfg)).resolves.toBe(file);

    const body = await readFile(file, 'utf8');
    expect(body).toContain(`deviceId = "${DEVICE_ID}"`);
    expect(body).toContain('allowed_cwd');
    expect(body).toContain('[control_plane]');
    expect(body).not.toContain('device_id =');
    expect(loadConfig()).toMatchObject(cfg);
  });

  it('保存不虚构未传入的旧配置业务设置', async () => {
    await writeFile(file, `platformUrl = "https://old.example.test"\ndeviceId = "${DEVICE_ID}"\nmax_tasks = 9\nlabel = "old-label"\n`, 'utf8');

    await saveConfig(boundConfig());

    expect(loadConfig()).toMatchObject({
      platformUrl: 'https://platform.example.test',
      deviceId: DEVICE_ID,
      deviceToken: 'device-secret',
    });
    expect(loadConfig()?.maxTasks).toBeUndefined();
    expect(loadConfig()?.label).toBeUndefined();
  });

  it('clearConfig 仅移除凭证和绑定时间，保留身份与业务设置', async () => {
    await saveConfig(boundConfig({
      refreshToken: 'refresh-secret',
      allowedCwd: [stateDir],
      maxTasks: 6,
      maxQueued: 0,
      diffMaxBytes: 4096,
      diffDefault: true,
      requireServiceToken: true,
      controlPlane: { enabled: true, host: 'localhost', port: 8787, requireToken: true },
      label: 'test-device',
      boundAt: '2026-10-25T00:00:00.000Z',
    }));

    await expect(clearConfig()).resolves.toBe(true);

    const body = await readFile(file, 'utf8');
    expect(body.trim()).not.toBe('');
    expect(body).not.toContain('deviceToken');
    expect(body).not.toContain('refreshToken');
    expect(body).not.toContain('boundAt');
    expect(loadConfig()).toMatchObject({
      platformUrl: 'https://platform.example.test',
      deviceId: DEVICE_ID,
      allowedCwd: [stateDir],
      maxTasks: 6,
      maxQueued: 0,
      diffMaxBytes: 4096,
      diffDefault: true,
      requireServiceToken: true,
      controlPlane: { enabled: true, host: 'localhost', port: 8787, requireToken: true },
      label: 'test-device',
    });
    expect(loadConfig()).not.toHaveProperty('deviceToken');
    expect(loadConfig()).not.toHaveProperty('refreshToken');
    expect(loadConfig()).not.toHaveProperty('boundAt');
  });

  it('clearConfig 重复执行幂等，不存在时返回 false', async () => {
    await expect(clearConfig()).resolves.toBe(false);
    await saveConfig(boundConfig());
    await clearConfig();

    await expect(clearConfig()).resolves.toBe(true);
    expect(loadConfig()).toMatchObject({ deviceId: DEVICE_ID });
    expect(loadConfig()).not.toHaveProperty('deviceToken');
  });
});

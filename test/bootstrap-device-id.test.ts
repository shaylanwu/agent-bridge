import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeSession, SessionOptions } from '../src/app/session';
import type { SessionLog } from '../src/app/session-log';
import { parseFlags } from '../src/cli/flags';
import { help } from '../src/cli/help';
import { cmdLogout } from '../src/commands/logout';
import type { AuthContext } from '../src/infra/auth';
import { loadConfig, saveConfig } from '../src/infra/config';
import { ensureDeviceIdentity } from '../src/infra/device-identity-store';
import { createBridgeClient, wsUrlOf } from '../src/transport/bridge-client';
import { PROTOCOL_VERSION } from '../src/protocol';

const sessionMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.doMock('../src/app/session.js', () => ({ createSession: sessionMocks.createSession }));

const authMocks = vi.hoisted(() => ({
  authorizeWithBrowser: vi.fn(),
  authorizeWithDeviceCode: vi.fn(),
}));
vi.doMock('../src/infra/auth.js', () => ({
  AuthError: class AuthError extends Error {},
  authorizeWithBrowser: authMocks.authorizeWithBrowser,
  authorizeWithDeviceCode: authMocks.authorizeWithDeviceCode,
}));

const { startBridge } = await import('../src/app/bootstrap');

const wsMock = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  const instances: FakeWebSocket[] = [];
  class FakeWebSocket {
    static readonly OPEN = 1;
    readonly sent: Record<string, unknown>[] = [];
    readonly handlers = new Map<string, Handler>();
    readyState = 0;

    constructor(readonly url: string) {
      instances.push(this);
    }

    on(event: string, handler: Handler): this {
      this.handlers.set(event, handler);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      this.handlers.get(event)?.(...args);
    }

    open(): void {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open');
    }

    send(body: string): void {
      this.sent.push(JSON.parse(body) as Record<string, unknown>);
    }

    ping(): void {}

    close(): void {
      this.readyState = 3;
    }
  }
  return { FakeWebSocket, instances };
});

vi.mock('ws', () => ({ WebSocket: wsMock.FakeWebSocket }));

const PLATFORM = 'https://platform.example.test';
const OTHER_PLATFORM = 'https://other.example.test';
const OTHER_ID = 'bd_fedcba9876543210fedcba9876543210';

const createSessionMock = sessionMocks.createSession;
const browserAuthMock = authMocks.authorizeWithBrowser;
const deviceCodeAuthMock = authMocks.authorizeWithDeviceCode;

let rootDir: string;
let stateDir: string;
let configFile: string;
let identityFile: string;
let previousConfig: string | undefined;
let previousDeviceId: string | undefined;
let logs: { level: string; line: string }[];

const log: SessionLog = (level, line) => logs.push({ level, line });

function start(...args: string[]): ReturnType<typeof startBridge> {
  return startBridge(parseFlags(['connect', ...args]), log);
}

function authResult(context: AuthContext): { platformUrl: string; deviceToken: string; refreshToken: string } {
  return {
    platformUrl: context.platformUrl,
    deviceToken: `token-${context.deviceId}`,
    refreshToken: 'refresh-token',
  };
}

function sessionOptions(call = 0): SessionOptions {
  const options = createSessionMock.mock.calls[call]?.[0];
  if (!options) throw new Error(`缺少 createSession 调用 ${call}`);
  return options;
}

function logCount(text: string): number {
  return logs.filter((entry) => entry.line.includes(text)).length;
}

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'agent-bridge-bootstrap-'));
  stateDir = join(rootDir, 'profile');
  configFile = join(stateDir, 'config.toml');
  identityFile = join(stateDir, 'identity.toml');
  previousConfig = process.env['AGENT_BRIDGE_CONFIG'];
  previousDeviceId = process.env['AGENT_BRIDGE_DEVICE_ID'];
  process.env['AGENT_BRIDGE_CONFIG'] = configFile;
  delete process.env['AGENT_BRIDGE_DEVICE_ID'];
  logs = [];
  wsMock.instances.length = 0;
  vi.clearAllMocks();

  createSessionMock.mockImplementation((options) => ({ options }) as unknown as BridgeSession);
  browserAuthMock.mockImplementation(async (context) => authResult(context));
  deviceCodeAuthMock.mockImplementation(async (context) => authResult(context));
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousConfig === undefined) delete process.env['AGENT_BRIDGE_CONFIG'];
  else process.env['AGENT_BRIDGE_CONFIG'] = previousConfig;
  if (previousDeviceId === undefined) delete process.env['AGENT_BRIDGE_DEVICE_ID'];
  else process.env['AGENT_BRIDGE_DEVICE_ID'] = previousDeviceId;
  await rm(rootDir, { recursive: true, force: true });
});

describe('startBridge 稳定设备身份', { timeout: 30_000 }, () => {
  it('首次平台离线时身份先于授权落盘，恢复后仍用同一 ID', async () => {
    let idAtAuth = '';
    browserAuthMock.mockImplementationOnce(async () => {
      idAtAuth = await readFile(identityFile, 'utf8');
      throw new Error('platform offline');
    });

    await expect(start(PLATFORM)).rejects.toThrow('platform offline');
    const identity = await readFile(identityFile, 'utf8');
    expect(idAtAuth).toBe(identity);
    expect(identity).toMatch(/device_id = "bd_[0-9a-f]{32}"/);
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(existsSync(configFile)).toBe(false);

    await start(PLATFORM);
    expect(browserAuthMock.mock.calls[1]?.[0]).toMatchObject({
      deviceId: identity.match(/device_id = "([^"]+)"/)?.[1],
    });
    expect(logCount('created')).toBe(1);
    expect(logCount('reused')).toBe(1);
  });

  it('连续三次启动复用同一身份，created 只出现一次', async () => {
    await start(PLATFORM);
    await start(PLATFORM);
    await start(PLATFORM);

    const ids = createSessionMock.mock.calls.map(([options]) => options.deviceId);
    expect(new Set(ids).size).toBe(1);
    expect(browserAuthMock).toHaveBeenCalledOnce();
    expect(logCount('created')).toBe(1);
    expect(logCount('reused')).toBe(2);
  });

  it('卸载重装仅删除配置时复用身份，只删 identity 时从配置镜像恢复', async () => {
    await start(PLATFORM);
    const original = await readFile(identityFile, 'utf8');

    await rm(configFile);
    await start(PLATFORM);
    expect(await readFile(identityFile, 'utf8')).toBe(original);

    await unlink(identityFile);
    await start(PLATFORM);
    expect(await readFile(identityFile, 'utf8')).toBe(original);
    expect(logCount('migrated')).toBe(1);
    expect(new Set(createSessionMock.mock.calls.map(([options]) => options.deviceId)).size).toBe(1);
  });

  it('不同 AGENT_BRIDGE_CONFIG profile 各自创建并保留身份', async () => {
    await start(PLATFORM);
    const firstId = sessionOptions().deviceId;
    const firstIdentity = await readFile(identityFile, 'utf8');

    process.env['AGENT_BRIDGE_CONFIG'] = join(rootDir, 'second', 'config.toml');
    await start(PLATFORM);
    const secondId = sessionOptions(1).deviceId;

    expect(secondId).not.toBe(firstId);
    expect(await readFile(identityFile, 'utf8')).toBe(firstIdentity);
    expect(await readFile(join(rootDir, 'second', 'identity.toml'), 'utf8')).toContain(secondId);
  });

  it('显式 ID 与已持久化身份冲突时拒绝授权和建会话', async () => {
    await start(PLATFORM);
    const identity = await readFile(identityFile, 'utf8');

    await expect(start(PLATFORM, `--device-id=${OTHER_ID}`)).rejects.toThrow(/身份冲突/);

    expect(await readFile(identityFile, 'utf8')).toBe(identity);
    expect(browserAuthMock).toHaveBeenCalledOnce();
    expect(createSessionMock).toHaveBeenCalledOnce();
  });

  it('旧 token 没有身份或镜像时，身份存储边界拒绝随机生成', async () => {
    await expect(ensureDeviceIdentity({
      identityPath: identityFile,
      allowCreate: false,
      hasReusableCredential: true,
    })).rejects.toThrow(/可复用凭证|身份/);

    expect(existsSync(identityFile)).toBe(false);
    expect(browserAuthMock).not.toHaveBeenCalled();
    expect(createSessionMock).not.toHaveBeenCalled();
  });

  it('预签发 token 缺 ID 必须失败，有显式 ID 时迁移但不持久化 token', async () => {
    await expect(start(PLATFORM, '--token=preissued')).rejects.toThrow(/身份|deviceId/);
    expect(existsSync(identityFile)).toBe(false);
    expect(createSessionMock).not.toHaveBeenCalled();

    const explicitId = 'bd_0123456789ab';
    const result = await start(`${PLATFORM}/`, `--token=preissued`, `--device-id=${explicitId}`);

    expect(sessionOptions()).toMatchObject({ platformUrl: PLATFORM, deviceId: explicitId, deviceToken: 'preissued' });
    expect(result.config).toMatchObject({ platformUrl: PLATFORM, deviceId: explicitId, deviceToken: 'preissued' });
    expect(existsSync(configFile)).toBe(false);
    expect(await readFile(identityFile, 'utf8')).toContain(explicitId);
  });

  it('显式新平台优先于旧绑定地址，返回保存后的配置并保留业务设置', async () => {
    const deviceId = 'bd_0123456789ab';
    await saveConfig({
      platformUrl: PLATFORM,
      deviceId,
      deviceToken: 'old-token',
      refreshToken: 'old-refresh',
      maxTasks: 7,
      maxQueued: 2,
      diffMaxBytes: 4096,
      requireServiceToken: true,
    });

    const result = await start(OTHER_PLATFORM, '--label=rebound');

    expect(browserAuthMock.mock.calls[0]?.[0]).toMatchObject({ platformUrl: OTHER_PLATFORM, deviceId });
    expect(sessionOptions()).toMatchObject({
      platformUrl: OTHER_PLATFORM,
      deviceId,
      deviceToken: `token-${deviceId}`,
      maxConcurrent: 7,
      maxQueued: 2,
      diffMaxBytes: 4096,
      requireServiceToken: true,
    });
    expect(result.config).toMatchObject({
      platformUrl: OTHER_PLATFORM,
      deviceId,
      deviceToken: `token-${deviceId}`,
      refreshToken: 'refresh-token',
      label: 'rebound',
      maxTasks: 7,
      maxQueued: 2,
    });
    expect(result.config?.boundAt).toEqual(expect.any(String));
  });
});

describe('startBridge 失败恢复与并发', { timeout: 30_000 }, () => {
  it('授权响应丢失后重试仍使用原身份', async () => {
    browserAuthMock.mockRejectedValueOnce(new Error('response lost'));
    await expect(start(PLATFORM)).rejects.toThrow('response lost');
    const identity = await readFile(identityFile, 'utf8');

    await start(PLATFORM);

    expect(browserAuthMock).toHaveBeenCalledTimes(2);
    expect(browserAuthMock.mock.calls[0]?.[0].deviceId).toBe(browserAuthMock.mock.calls[1]?.[0].deviceId);
    expect(await readFile(identityFile, 'utf8')).toBe(identity);
    expect(sessionOptions().deviceId).toBe(browserAuthMock.mock.calls[0]?.[0].deviceId);
  });

  it('token 保存失败不创建 session，重试保留身份并成功保存', async () => {
    browserAuthMock.mockImplementationOnce(async (context: AuthContext) => {
      await mkdir(configFile);
      return authResult(context);
    });
    await expect(start(PLATFORM)).rejects.toThrow(/配置|写入|发布|rename|EEXIST|EPERM/i);
    const identity = await readFile(identityFile, 'utf8');
    expect(createSessionMock).not.toHaveBeenCalled();
    await rm(configFile, { recursive: true });
    expect(existsSync(configFile)).toBe(false);

    await start(PLATFORM);

    expect(await readFile(identityFile, 'utf8')).toBe(identity);
    expect(browserAuthMock).toHaveBeenCalledTimes(2);
    expect(createSessionMock).toHaveBeenCalledOnce();
    expect(loadConfig()).toMatchObject({ deviceId: sessionOptions().deviceId, deviceToken: sessionOptions().deviceToken });
  });

  it('两个 connect 并发时只授权一次并复用同一凭证与身份', async () => {
    let finishAuth: ((result: ReturnType<typeof authResult>) => void) | undefined;
    browserAuthMock.mockImplementationOnce(
      (context) => new Promise((resolve) => {
        finishAuth = (result) => resolve(result);
        expect(context.deviceId).toMatch(/^bd_[0-9a-f]{32}$/);
      }),
    );

    const first = start(PLATFORM);
    const second = start(PLATFORM);
    await vi.waitFor(() => expect(browserAuthMock).toHaveBeenCalledOnce());
    if (!finishAuth) throw new Error('授权未进入待完成状态');
    const context = browserAuthMock.mock.calls[0]?.[0];
    if (!context) throw new Error('缺少授权上下文');
    finishAuth(authResult(context));
    await Promise.all([first, second]);

    expect(browserAuthMock).toHaveBeenCalledOnce();
    expect(createSessionMock).toHaveBeenCalledTimes(2);
    expect(sessionOptions(0).deviceId).toBe(sessionOptions(1).deviceId);
    expect(sessionOptions(0).deviceToken).toBe(sessionOptions(1).deviceToken);
    expect(existsSync(join(stateDir, 'profile.lock'))).toBe(false);
  });

  it('logout 清凭证保身份和业务设置，重绑仍使用原 ID', async () => {
    await start(PLATFORM);
    const identity = await readFile(identityFile, 'utf8');
    const originalId = sessionOptions().deviceId;
    const originalConfig = loadConfig();
    expect(originalConfig).not.toBeNull();

    await cmdLogout();

    expect(loadConfig()).toMatchObject({ deviceId: originalId, platformUrl: PLATFORM });
    expect(loadConfig()).not.toHaveProperty('deviceToken');
    expect(loadConfig()).not.toHaveProperty('refreshToken');
    expect(await readFile(identityFile, 'utf8')).toBe(identity);

    await start(PLATFORM);
    expect(browserAuthMock).toHaveBeenCalledTimes(2);
    expect(sessionOptions(1).deviceId).toBe(originalId);
    expect(await readFile(identityFile, 'utf8')).toBe(identity);
  });
});

describe('协议 v2、WS 与帮助文本', () => {
  it('每次 WS 连接的 query 与 hello 都使用同一身份和协议常量', async () => {
    vi.useFakeTimers();
    const deviceId = 'bd_0123456789ab';
    const client = createBridgeClient({
      platformUrl: PLATFORM,
      deviceToken: 'token',
      deviceId,
      cliVersion: 'test',
      hostname: 'host',
      onMessage: () => undefined,
      log: () => undefined,
    });

    expect(wsMock.instances).toHaveLength(1);
    wsMock.instances[0]?.open();
    expect(wsMock.instances[0]?.url).toBe(wsUrlOf(PLATFORM, deviceId));
    expect(wsMock.instances[0]?.sent[0]).toMatchObject({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      deviceId,
    });
    expect(PROTOCOL_VERSION).toBe(1);

    wsMock.instances[0]?.emit('close', 1006, Buffer.from('lost'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(wsMock.instances).toHaveLength(2);
    wsMock.instances[1]?.open();
    expect(wsMock.instances[1]?.url).toBe(wsUrlOf(PLATFORM, deviceId));
    expect(wsMock.instances[1]?.sent[0]).toMatchObject({ protocolVersion: 1, deviceId });
    client.close();
  });

  it('帮助要求预签发 token 提供身份，并保留重绑和并发参数说明', () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    help();
    const text = String(output.mock.calls[0]?.[0] ?? '');

    expect(text).toContain('--token');
    expect(text).toMatch(/必须.*(?:--device-id|可迁移)/);
    expect(text).toContain('AGENT_BRIDGE_DEVICE_ID');
    expect(text).toMatch(/logout.*connect/);
    expect(text).toContain('--max-tasks/--max-queue');
  });
});

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const BROWSER_PRELOAD = fileURLToPath(new URL('./fixtures/device-identity-browser-preload.cjs', import.meta.url));
const TEST_TIMEOUT = 45_000;
const WAIT_TIMEOUT = 15_000;

type JsonObject = Record<string, unknown>;
type ExitResult = { code: number | null; signal: NodeJS.Signals | null };

interface ObservedRequest {
  path: string;
  body: JsonObject;
}

interface ObservedConnection {
  url: string;
  authorization: string | undefined;
  messages: JsonObject[];
  socket: WebSocket;
  closed: Promise<void>;
}

class CliProcess {
  stdout = '';
  stderr = '';
  result: ExitResult | null = null;
  readonly exited: Promise<ExitResult>;

  constructor(readonly child: ChildProcess) {
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { this.stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { this.stderr += chunk; });
    this.exited = new Promise<ExitResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => {
        this.result = { code, signal };
        resolve(this.result);
      });
    });
  }

  get output(): string {
    return `${this.stdout}\n${this.stderr}`;
  }

  async stop(): Promise<ExitResult> {
    if (this.result) return this.result;
    this.child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (!this.result) this.child.kill('SIGKILL');
    }, 3_000);
    try {
      return await this.exited;
    } finally {
      clearTimeout(forceKill);
    }
  }
}

class MockPlatform {
  readonly requests: ObservedRequest[] = [];
  readonly connections: ObservedConnection[] = [];
  readonly server: Server;
  readonly wss = new WebSocketServer({ noServer: true });
  url = '';
  dropNextTokenResponse = false;
  tokenGate: { promise: Promise<void>; release: () => void } | undefined;
  private pkceTokens = 0;
  private deviceTokens = 0;
  private devicePolls = 0;

  constructor() {
    this.server = createServer((req, res) => {
      void this.handleHttp(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'mock_platform_error' }));
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/api/bridge/ws') {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        let markClosed = () => undefined;
        const closed = new Promise<void>((resolve) => { markClosed = resolve; });
        const connection: ObservedConnection = {
          url: req.url ?? '',
          authorization: req.headers.authorization,
          messages: [],
          socket: ws,
          closed,
        };
        this.connections.push(connection);
        ws.on('message', (data) => {
          connection.messages.push(JSON.parse(String(data)) as JsonObject);
        });
        ws.once('close', () => markClosed());
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (typeof address !== 'object' || address === null) throw new Error('mock 平台未监听端口');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  at(path: string): ObservedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  get hellos(): JsonObject[] {
    return this.connections.flatMap((connection) => connection.messages)
      .filter((message) => message.type === 'hello');
  }

  async close(): Promise<void> {
    this.tokenGate?.release();
    for (const connection of this.connections) connection.socket.terminate();
    const wsClosed = new Promise<void>((resolve) => { this.wss.close(() => resolve()); });
    this.server.closeAllConnections();
    const httpClosed = new Promise<void>((resolve) => { this.server.close(() => resolve()); });
    await Promise.all([wsClosed, httpClosed]);
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as JsonObject;
    this.requests.push({ path, body });

    if (path === '/api/bridge/token') {
      if (this.dropNextTokenResponse) {
        this.dropNextTokenResponse = false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"device_token":');
        setImmediate(() => res.destroy());
        return;
      }
      await this.tokenGate?.promise;
      this.pkceTokens += 1;
      this.sendJson(res, 200, {
        device_token: `fake-pkce-token-${this.pkceTokens}`,
        refresh_token: `fake-pkce-refresh-${this.pkceTokens}`,
        device_id: body.deviceId,
      });
      return;
    }

    if (path === '/api/bridge/device-code') {
      this.sendJson(res, 200, {
        device_code: 'fake-device-code',
        user_code: 'FAKE-USER-CODE',
        verification_uri: `${this.url}/verify`,
        interval: 0,
        expires_in: 30,
      });
      return;
    }

    if (path === '/api/bridge/device-token') {
      this.devicePolls += 1;
      if (this.devicePolls === 1) {
        this.sendJson(res, 428, { code: 'authorization_pending' });
        return;
      }
      this.deviceTokens += 1;
      this.sendJson(res, 200, {
        device_token: `fake-device-token-${this.deviceTokens}`,
        refresh_token: `fake-device-refresh-${this.deviceTokens}`,
        device_id: body.deviceId,
      });
      return;
    }

    this.sendJson(res, 404, { code: 'not_found' });
  }

  private sendJson(res: ServerResponse, status: number, body: JsonObject): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

interface TestContext {
  root: string;
  configFile: string;
  identityFile: string;
  lockFile: string;
  platform: MockPlatform;
  children: CliProcess[];
}

let context: TestContext;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bridge-e2e-identity-'));
  const profile = join(root, 'profile');
  const platform = new MockPlatform();
  context = {
    root,
    configFile: join(profile, 'config.toml'),
    identityFile: join(profile, 'identity.toml'),
    lockFile: join(profile, 'profile.lock'),
    platform,
    children: [],
  };
  await platform.listen();
});

afterEach(async () => {
  await Promise.allSettled(context.children.map((child) => child.stop()));
  await context.platform.close();
  await rm(context.root, { recursive: true, force: true });
});

function startCliWithConfig(args: string[], configFile: string): CliProcess {
  const env = {
    ...process.env,
    AGENT_BRIDGE_CONFIG: configFile,
    NO_COLOR: '1',
  };
  delete env.AGENT_BRIDGE_DEVICE_ID;
  const child = spawn(process.execPath, ['--require', BROWSER_PRELOAD, CLI, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const processHandle = new CliProcess(child);
  context.children.push(processHandle);
  return processHandle;
}

function startCli(args: string[]): CliProcess {
  return startCliWithConfig(args, context.configFile);
}

function connect(...extraArgs: string[]): CliProcess {
  return startCli(['connect', context.platform.url, ...extraArgs]);
}

async function waitFor(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: WAIT_TIMEOUT, interval: 20 });
}

async function readIdentity(): Promise<string> {
  return readFile(context.identityFile, 'utf8');
}

async function readConfig(): Promise<JsonObject> {
  return parseToml(await readFile(context.configFile, 'utf8')) as JsonObject;
}

function expectCommonAuthFields(body: JsonObject, deviceId: string): void {
  expect(body).toMatchObject({
    clientId: 'agent-bridge',
    deviceId,
    hostname: hostname(),
    platform: process.platform,
    cliVersion: expect.any(String),
  });
}

function expectNoPseudoSecretsInErrors(child: CliProcess): void {
  expect(child.stderr).not.toMatch(/fake-(?:pkce|device)-(?:token|refresh)-\d+/);
}

describe('真实 CLI 稳定设备身份端到端', () => {
  it('首次 PKCE、重启复用、logout 后设备码 pending 重绑始终同 ID', async () => {
    const first = connect();
    await waitFor(() => expect(context.platform.hellos, first.output).toHaveLength(1));
    const tokenRequests = context.platform.at('/api/bridge/token');
    expect(tokenRequests).toHaveLength(1);
    const firstRequest = tokenRequests[0]!.body;
    const deviceId = String(firstRequest.deviceId);
    expect(deviceId).toMatch(/^bd_[0-9a-f]{32}$/);
    expect(firstRequest).toMatchObject({
      code: expect.stringMatching(/^e2e-pkce-/),
      codeVerifier: expect.any(String),
      redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
    });
    expectCommonAuthFields(firstRequest, deviceId);
    expect(context.platform.hellos[0]).toMatchObject({ protocolVersion: 1, deviceId });
    expect(new URL(context.platform.connections[0]!.url, 'http://127.0.0.1').searchParams.get('deviceId')).toBe(deviceId);
    const identityAfterCreate = await readIdentity();
    const firstConfig = await readConfig();
    expect(identityAfterCreate).toContain(`device_id = "${deviceId}"`);
    expect(firstConfig).toMatchObject({ deviceId, deviceToken: 'fake-pkce-token-1' });
    await first.stop();

    const restarted = connect();
    await waitFor(() => expect(context.platform.hellos).toHaveLength(2));
    expect(context.platform.at('/api/bridge/token')).toHaveLength(1);
    expect(context.platform.hellos[1]).toMatchObject({ protocolVersion: 1, deviceId });
    expect(await readIdentity()).toBe(identityAfterCreate);
    expect(await readConfig()).toMatchObject({ deviceId, deviceToken: 'fake-pkce-token-1' });
    await restarted.stop();

    const logout = startCli(['logout']);
    expect((await logout.exited).code).toBe(0);
    expect(await readIdentity()).toBe(identityAfterCreate);
    expect(await readConfig()).toMatchObject({ deviceId, platformUrl: context.platform.url });
    expect(await readConfig()).not.toHaveProperty('deviceToken');
    expect(await readConfig()).not.toHaveProperty('refreshToken');

    const rebound = connect('--no-browser');
    await waitFor(() => expect(context.platform.hellos).toHaveLength(3));
    expect(context.platform.at('/api/bridge/device-code')).toHaveLength(1);
    const deviceTokenRequests = context.platform.at('/api/bridge/device-token');
    expect(deviceTokenRequests).toHaveLength(2);
    for (const request of deviceTokenRequests) {
      expect(request.body.device_code).toBe('fake-device-code');
      expectCommonAuthFields(request.body, deviceId);
    }
    expect(context.platform.hellos[2]).toMatchObject({ protocolVersion: 1, deviceId });
    expect(await readIdentity()).toBe(identityAfterCreate);
    expect(await readConfig()).toMatchObject({ deviceId, deviceToken: 'fake-device-token-1' });
    for (const child of [first, restarted, logout, rebound]) expectNoPseudoSecretsInErrors(child);
    await rebound.stop();
  }, TEST_TIMEOUT);

  it('PKCE 请求已到达但响应断流后，换授权 code 重试仍复用身份文件', async () => {
    context.platform.dropNextTokenResponse = true;
    const failed = connect();
    expect((await failed.exited).code, failed.output).toBe(1);
    expect(context.platform.at('/api/bridge/token'), failed.output).toHaveLength(1);
    expect(context.platform.hellos).toHaveLength(0);
    const identityAfterFailure = await readIdentity();
    const firstCode = context.platform.at('/api/bridge/token')[0]!.body.code;
    expectNoPseudoSecretsInErrors(failed);

    const retried = connect();
    await waitFor(() => expect(context.platform.hellos).toHaveLength(1));
    const requests = context.platform.at('/api/bridge/token');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.code).not.toBe(firstCode);
    expect(requests[1]!.body.codeVerifier).not.toBe(requests[0]!.body.codeVerifier);
    const deviceId = String(requests[0]!.body.deviceId);
    expect(requests[1]!.body.deviceId).toBe(deviceId);
    expectCommonAuthFields(requests[1]!.body, deviceId);
    expect(context.platform.hellos[0]).toMatchObject({ protocolVersion: 1, deviceId });
    expect(await readIdentity()).toBe(identityAfterFailure);
    await retried.stop();
  }, TEST_TIMEOUT);

  it('进程在 token 保存前被终止后，重试回收 stale lock 并复用身份', async () => {
    let releaseGate = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    context.platform.tokenGate = { promise: gate, release: () => releaseGate() };

    const crashed = connect();
    await waitFor(() => expect(context.platform.at('/api/bridge/token')).toHaveLength(1));
    const identityBeforeCrash = await readIdentity();
    await expect(readFile(context.configFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const lock = JSON.parse(await readFile(context.lockFile, 'utf8')) as JsonObject;
    expect(lock.pid).toBe(crashed.child.pid);
    const firstRequest = context.platform.at('/api/bridge/token')[0]!.body;

    crashed.child.kill('SIGKILL');
    expect((await crashed.exited).code).not.toBe(0);
    expect(JSON.parse(await readFile(context.lockFile, 'utf8'))).toMatchObject({ pid: crashed.child.pid });
    expect(await readIdentity()).toBe(identityBeforeCrash);
    releaseGate();
    context.platform.tokenGate = undefined;

    const retried = connect();
    await waitFor(() => expect(context.platform.hellos).toHaveLength(1));
    const requests = context.platform.at('/api/bridge/token');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body.code).not.toBe(firstRequest.code);
    expect(requests[1]!.body.codeVerifier).not.toBe(firstRequest.codeVerifier);
    expect(requests[1]!.body.deviceId).toBe(firstRequest.deviceId);
    expect(context.platform.hellos[0]).toMatchObject({ protocolVersion: 1, deviceId: firstRequest.deviceId });
    expect(await readIdentity()).toBe(identityBeforeCrash);
    expect(await readConfig()).toMatchObject({ deviceId: firstRequest.deviceId });
    await retried.stop();
  }, TEST_TIMEOUT);

  it('同 profile 并发 connect 在首个持锁时明确拒绝第二个且不重复授权', async () => {
    let releaseGate = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    context.platform.tokenGate = { promise: gate, release: () => releaseGate() };

    const first = connect();
    await waitFor(() => expect(context.platform.at('/api/bridge/token')).toHaveLength(1));
    const identityWhileLocked = await readIdentity();
    const lock = JSON.parse(await readFile(context.lockFile, 'utf8')) as JsonObject;
    expect(lock.pid).toBe(first.child.pid);

    const second = connect();
    expect((await second.exited).code).toBe(1);
    expect(second.stderr).toMatch(/已有 bridge 运行实例|该 profile 已有绑定进行中/);
    expect(context.platform.at('/api/bridge/token')).toHaveLength(1);
    expect(context.platform.hellos).toHaveLength(0);

    releaseGate();
    await waitFor(() => expect(context.platform.hellos).toHaveLength(1));
    const deviceId = String(context.platform.at('/api/bridge/token')[0]!.body.deviceId);
    expect(context.platform.hellos[0]).toMatchObject({ protocolVersion: 1, deviceId });
    expect(await readIdentity()).toBe(identityWhileLocked);
    expect(await readConfig()).toMatchObject({ deviceId, deviceToken: 'fake-pkce-token-1' });
    expectNoPseudoSecretsInErrors(second);
    await first.stop();
  }, TEST_TIMEOUT);

  it('同 ID 两条真实 WS 的 URL/hello 一致，旧进程退出后新进程仍响应 ping', async () => {
    const oldProcess = connect();
    await waitFor(() => expect(context.platform.hellos).toHaveLength(1));
    // 同一 profile 会被运行期单实例锁拒绝；这里用独立 profile 复制同一身份，验证平台替换语义。
    const secondDir = join(context.root, 'second-profile');
    await mkdir(secondDir, { recursive: true });
    const secondConfig = join(secondDir, 'config.toml');
    await copyFile(context.configFile, secondConfig);
    await copyFile(context.identityFile, join(secondDir, 'identity.toml'));
    const newProcess = startCliWithConfig(['connect', context.platform.url], secondConfig);
    await waitFor(() => expect(context.platform.hellos).toHaveLength(2));

    const [oldConnection, newConnection] = context.platform.connections;
    expect(oldConnection).toBeDefined();
    expect(newConnection).toBeDefined();
    expect(newConnection!.url).toBe(oldConnection!.url);
    expect(newConnection!.authorization).toBe(oldConnection!.authorization);
    const deviceId = String(context.platform.hellos[0]!.deviceId);
    expect(deviceId).toMatch(/^bd_[0-9a-f]{32}$/);
    expect(context.platform.hellos[1]).toMatchObject({ protocolVersion: 1, deviceId });
    expect(new URL(newConnection!.url, 'http://127.0.0.1').searchParams.get('deviceId')).toBe(deviceId);
    expect(context.platform.at('/api/bridge/token')).toHaveLength(1);

    await oldProcess.stop();
    await oldConnection!.closed;
    expect(newProcess.result).toBeNull();
    newConnection!.socket.send(JSON.stringify({ type: 'ping' }));
    await waitFor(() => {
      expect(newConnection!.messages.some((message) => message.type === 'pong')).toBe(true);
    });
    expect(newProcess.result).toBeNull();
    await newProcess.stop();
  }, TEST_TIMEOUT);
});

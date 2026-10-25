/**
 * 授权：B 方案（本地回环回调 + PKCE），兼容手动 token 与 Device Code 兜底
 *
 * 流程：bridge 起一个只监听 127.0.0.1 的临时 http 服务 → 唤起浏览器到平台授权页
 * （复用用户已登录的 session）→ 平台 302 回 `http://127.0.0.1:<port>/callback?code=…`
 * → bridge 用 code + code_verifier 换 device_token → 关掉临时服务。
 *
 * 安全：
 *  - 只绑 127.0.0.1（禁止 0.0.0.0），且只处理一次 callback 后立即关闭
 *  - PKCE S256 防授权码被劫持
 *  - 平台必须校验 redirect_uri 以 `http://127.0.0.1` 开头（平台侧职责）
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { DEVICE_ID_PATTERN } from '../core/device-identity.js';

export interface AuthContext {
  platformUrl: string;
  deviceId: string;
  hostname: string;
  platform: NodeJS.Platform;
  cliVersion: string;
}

export interface AuthResult {
  platformUrl: string;
  deviceToken: string;
  refreshToken?: string;
}

export class AuthError extends Error {
  readonly httpStatus?: number;
  readonly code?: string;

  constructor(message: string, options: { httpStatus?: number; code?: string } = {}) {
    super(message);
    this.name = 'AuthError';
    this.httpStatus = options.httpStatus;
    this.code = options.code;
  }
}

const CALLBACK_TIMEOUT_MS = 180_000;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * 唤起浏览器的命令（纯函数，可在非 Windows 上单测）。
 *
 * ⛔ Windows 不得走 `cmd /c start "" <url>`：Node 只在参数含空格时加引号，而授权 URL
 * 里全是 `&`，cmd 会把 `&` 当成**命令分隔符** —— 浏览器只收到第一个 query 参数
 * （2026-10-24 实测：`?client_id=agent-bridge` 之后的 `code_challenge` / `redirect_uri`
 * 全被当成命令吞掉，平台授权页读不到 code_challenge，报「授权链接无效」）。
 *
 * ✅ 走 `rundll32 url.dll,FileProtocolHandler`：由 CreateProcess 直接收 argv，
 * 全程不经任何 shell 解析，`&` 无需引号、无需转义，也不会引入 `shell: true`
 * （对齐 always-on.md §4「参数一律字符串数组传给 spawn」）。
 * 实测对照：cmd start 只送到 `?client_id=agent-bridge`；rundll32 整条送达（含 state）。
 * 取舍：rundll32 对超长 URL（~2048 字符）有限制，而授权 URL 实测约 200 字符，够用。
 * （`explorer.exe <url>` 是另一条零引号路径，但本机 Win11 实测不再转交默认浏览器，弃用。）
 */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === 'win32') {
    return { cmd: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] };
  }
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  return { cmd: 'xdg-open', args: [url] };
}

export function openBrowser(url: string): void {
  const { cmd, args } = browserOpenCommand(process.platform, url);
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
  child.on('error', () => {
    /* 打不开浏览器由调用方降级到 device code */
  });
  child.unref();
}

function normalizeBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 网络层错误要翻译成人话：地址写错 / 服务没起 / 被防火墙拦，都会是 "fetch failed" */
async function postJson(url: string, body: unknown, timeoutMs = 15_000): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const msg = (e as Error).message;
    throw new AuthError(
      `连接平台失败（${url}）：${msg}。请确认地址正确、平台在运行、且该端口可达。`,
    );
  }
}

async function readPublicErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const code = (body as { code?: unknown }).code;
    return typeof code === 'string' && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
  }
}

function authErrorFromResponse(res: Response, endpoint: string, code?: string): AuthError {
  const options = { httpStatus: res.status, code };
  if (res.status === 404) {
    const hint = endpoint === '/api/bridge/device-code'
      ? '（且本机无法打开浏览器）'
      : '（bridge 配套接口未上线）';
    return new AuthError(`平台还没有实现 ${endpoint}${hint}`, options);
  }
  if (res.status === 400 && code === 'invalid_device_id') {
    return new AuthError(
      '本地设备身份格式无效，平台拒绝该 deviceId；请检查本地身份，不会自动更换设备 ID。',
      options,
    );
  }
  if (res.status === 409 && code === 'device_bound_to_other_account') {
    return new AuthError(
      '设备已绑定其他账号；请联系平台管理员处理设备所有权，不会自动更换设备 ID。',
      options,
    );
  }
  if (res.status === 409 && code === 'device_identity_ambiguous') {
    return new AuthError(
      '平台存在设备身份历史重复；请联系平台管理员处理，不会自动合并或更换设备 ID。',
      options,
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new AuthError(
      `平台授权或凭证失败（HTTP ${res.status}）；本地设备身份已保留，请重新发起授权。`,
      options,
    );
  }
  return new AuthError(
    `授权请求失败：HTTP ${res.status}。请检查平台状态后重新发起授权。`,
    options,
  );
}

function protocolError(detail: string): AuthError {
  return new AuthError(`平台授权响应协议错误：${detail}`);
}

async function parseTokenResponse(res: Response, context: AuthContext): Promise<AuthResult> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw protocolError('响应不是有效 JSON。');
  }
  if (typeof body !== 'object' || body === null) throw protocolError('响应必须是 JSON 对象。');
  const value = body as Record<string, unknown>;
  const deviceToken = value['device_token'];
  const refreshToken = value['refresh_token'];
  const deviceId = value['device_id'];
  if (typeof deviceToken !== 'string' || deviceToken.length === 0) {
    throw protocolError('device_token 缺失或不是非空字符串。');
  }
  if (refreshToken !== undefined && (typeof refreshToken !== 'string' || refreshToken.length === 0)) {
    throw protocolError('refresh_token 必须是非空字符串。');
  }
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    throw protocolError('device_id 缺失或格式无效。');
  }
  if (deviceId !== context.deviceId) {
    throw protocolError(`device_id 与本地身份不一致（预期 ${context.deviceId}，实际 ${deviceId}）。`);
  }
  return {
    platformUrl: normalizeBase(context.platformUrl),
    deviceToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
  };
}

/** 起临时回调服务，返回 { port, waitForCode } */
async function startCallbackServer(): Promise<{
  port: number;
  waitForCode: Promise<string>;
  close: () => void;
}> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (err: Error) => void = () => undefined;
  const waitForCode = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/callback') {
      res.writeHead(404).end('not found');
      return;
    }
    const code = u.searchParams.get('code');
    const error = u.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      error
        ? `<h2>授权失败</h2><p>${error}</p><p>可以关闭此页面回到终端。</p>`
        : '<h2>设备绑定成功</h2><p>可以关闭此页面回到终端。</p>',
    );
    if (error) rejectCode(new AuthError(`平台拒绝授权：${error}`));
    else if (code) resolveCode(code);
    else rejectCode(new AuthError('回调缺少 code'));
  });

  // listen 是异步的：必须等 listening 事件，否则 address() 还是 null
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      if (!p) reject(new AuthError('无法启动本地回调端口'));
      else resolve(p);
    });
  });

  return { port, waitForCode, close: () => server.close() };
}

async function exchangeCode(
  context: AuthContext,
  body: { code: string; codeVerifier: string; redirectUri: string },
): Promise<AuthResult> {
  const platform = normalizeBase(context.platformUrl);
  const res = await postJson(`${platform}/api/bridge/token`, {
    ...body,
    clientId: 'agent-bridge',
    deviceId: context.deviceId,
    hostname: context.hostname,
    platform: context.platform,
    cliVersion: context.cliVersion,
  });
  if (!res.ok) {
    const code = await readPublicErrorCode(res);
    throw authErrorFromResponse(res, '/api/bridge/token', code);
  }
  return parseTokenResponse(res, context);
}

/** 回环回调授权（主路径）：用户只需确认浏览器里的授权框 */
export async function authorizeWithBrowser(
  context: AuthContext,
  opts: {
    onPrompt?: (url: string) => void;
    openBrowser?: (url: string) => void | Promise<void>;
  } = {},
): Promise<AuthResult> {
  const platform = normalizeBase(context.platformUrl);
  const { verifier, challenge } = createPkce();
  const cb = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${cb.port}/callback`;
  const authUrl =
    `${platform}/bridge/authorize?client_id=agent-bridge` +
    `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${randomUUID()}`;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    opts.onPrompt?.(authUrl);
    if (opts.openBrowser) await opts.openBrowser(authUrl);
    else openBrowser(authUrl);
    const timeout = new Promise<never>((_, rej) => {
      timeoutHandle = setTimeout(() => rej(new AuthError('等待浏览器授权超时（180s）')), CALLBACK_TIMEOUT_MS);
    });
    const code = await Promise.race([cb.waitForCode, timeout]);
    return await exchangeCode(context, { code, codeVerifier: verifier, redirectUri });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    cb.close();
  }
}

/** Device Code 兜底（SSH / 打不开浏览器）：平台返回验证码，用户去任意浏览器确认 */
export async function authorizeWithDeviceCode(
  context: AuthContext,
  opts: { onPrompt?: (verificationUri: string, userCode: string) => void } = {},
): Promise<AuthResult> {
  const platform = normalizeBase(context.platformUrl);
  const start = await postJson(`${platform}/api/bridge/device-code`, {
    clientId: 'agent-bridge',
  });
  if (!start.ok) {
    const code = await readPublicErrorCode(start);
    throw authErrorFromResponse(start, '/api/bridge/device-code', code);
  }
  let j: {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  };
  try {
    j = (await start.json()) as typeof j;
  } catch {
    throw protocolError('设备码申请响应不是有效 JSON。');
  }
  opts.onPrompt?.(j.verification_uri, j.user_code);

  const deadline = Date.now() + (j.expires_in ?? 600) * 1000;
  const interval = (j.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await postJson(`${platform}/api/bridge/device-token`, {
      device_code: j.device_code,
      clientId: 'agent-bridge',
      deviceId: context.deviceId,
      hostname: context.hostname,
      platform: context.platform,
      cliVersion: context.cliVersion,
    });
    if (res.ok) return parseTokenResponse(res, context);

    const code = await readPublicErrorCode(res);
    if (res.status === 428 && code === 'authorization_pending') continue;
    throw authErrorFromResponse(res, '/api/bridge/device-token', code);
  }
  throw new AuthError('设备码授权超时');
}

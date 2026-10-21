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

export interface AuthResult {
  platformUrl: string;
  deviceId: string;
  deviceToken: string;
  refreshToken?: string;
}

export class AuthError extends Error {}

const CALLBACK_TIMEOUT_MS = 180_000;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
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
  platform: string,
  body: { code: string; codeVerifier: string; redirectUri: string },
): Promise<AuthResult> {
  const res = await postJson(`${platform}/api/bridge/token`, {
    ...body,
    clientId: 'agent-bridge',
  });
  if (res.status === 404) {
    throw new AuthError('平台还没有实现 /api/bridge/token（bridge 配套接口未上线）');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new AuthError(`换取 device_token 失败：HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    device_token?: string;
    refresh_token?: string;
    device_id?: string;
  };
  if (!j.device_token || !j.device_id) throw new AuthError('平台返回缺少 device_token / device_id');
  return {
    platformUrl: platform,
    deviceId: j.device_id,
    deviceToken: j.device_token,
    refreshToken: j.refresh_token,
  };
}

/** 回环回调授权（主路径）：用户只需确认浏览器里的授权框 */
export async function authorizeWithBrowser(
  platformUrl: string,
  opts: { onPrompt?: (url: string) => void } = {},
): Promise<AuthResult> {
  const platform = normalizeBase(platformUrl);
  const { verifier, challenge } = createPkce();
  const cb = await startCallbackServer();
  const redirectUri = `http://127.0.0.1:${cb.port}/callback`;
  const authUrl =
    `${platform}/bridge/authorize?client_id=agent-bridge` +
    `&code_challenge=${encodeURIComponent(challenge)}&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&state=${randomUUID()}`;

  try {
    opts.onPrompt?.(authUrl);
    openBrowser(authUrl);
    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new AuthError('等待浏览器授权超时（180s）')), CALLBACK_TIMEOUT_MS),
    );
    const code = await Promise.race([cb.waitForCode, timeout]);
    return await exchangeCode(platform, { code, codeVerifier: verifier, redirectUri });
  } finally {
    cb.close();
  }
}

/** Device Code 兜底（SSH / 打不开浏览器）：平台返回验证码，用户去任意浏览器确认 */
export async function authorizeWithDeviceCode(
  platformUrl: string,
  opts: { onPrompt?: (verificationUri: string, userCode: string) => void } = {},
): Promise<AuthResult> {
  const platform = normalizeBase(platformUrl);
  const start = await postJson(`${platform}/api/bridge/device-code`, {
    clientId: 'agent-bridge',
  });
  if (start.status === 404) {
    throw new AuthError('平台还没有实现 /api/bridge/device-code（且本机无法打开浏览器）');
  }
  if (!start.ok) throw new AuthError(`申请设备码失败：HTTP ${start.status}`);
  const j = (await start.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  };
  opts.onPrompt?.(j.verification_uri, j.user_code);

  const deadline = Date.now() + (j.expires_in ?? 600) * 1000;
  const interval = (j.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await postJson(`${platform}/api/bridge/device-token`, {
      device_code: j.device_code,
      clientId: 'agent-bridge',
    });
    if (res.ok) {
      const t = (await res.json()) as {
        device_token?: string;
        device_id?: string;
        refresh_token?: string;
      };
      if (t.device_token && t.device_id) {
        return {
          platformUrl: platform,
          deviceId: t.device_id,
          deviceToken: t.device_token,
          refreshToken: t.refresh_token,
        };
      }
    }
    // 404/400 继续等；401 视为用户拒绝
    if (res.status === 401) throw new AuthError('设备码已被拒绝或过期');
  }
  throw new AuthError('设备码授权超时');
}

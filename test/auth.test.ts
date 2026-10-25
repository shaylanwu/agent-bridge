import { get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuthError,
  authorizeWithBrowser,
  authorizeWithDeviceCode,
  refreshDeviceToken,
  type AuthContext,
} from '../src/infra/auth.js';

const DEVICE_ID = 'bd_0123456789abcdef0123456789abcdef';
const CONTEXT: AuthContext = {
  platformUrl: 'https://platform.example/',
  deviceId: DEVICE_ID,
  hostname: 'test-host',
  platform: 'win32',
  cliVersion: '0.2.3-test',
};
const TOKEN_RESPONSE = {
  device_token: 'device-token-secret',
  refresh_token: 'refresh-token-secret',
  device_id: DEVICE_ID,
};

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse(200, { ...TOKEN_RESPONSE, ...overrides });
}

async function sendCallback(authUrl: string, code = 'pkce-code'): Promise<void> {
  const authorizeUrl = new URL(authUrl);
  const redirect = new URL(authorizeUrl.searchParams.get('redirectUri') ?? authorizeUrl.searchParams.get('redirect_uri')!);
  redirect.searchParams.set('code', code);
  await new Promise<void>((resolve, reject) => {
    get(redirect, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
}

function requestBody(call: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1];
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function captureAuthError(promise: Promise<unknown>): Promise<AuthError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AuthError);
    return error as AuthError;
  }
  throw new Error('预期授权失败，但实际成功了');
}

describe('refresh token', () => {
  it('用 grant_type=refresh_token 换新设备凭证并保留身份校验', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    const result = await refreshDeviceToken(CONTEXT, 'refresh-token-secret');
    expect(result.deviceToken).toBe('device-token-secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toBe('https://platform.example/api/bridge/token');
    expect(requestBody(0)).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token-secret',
      deviceId: DEVICE_ID,
      clientId: 'agent-bridge',
    });
  });

  it('平台拒绝 refresh 时抛 AuthError，由上层回退重新授权', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { code: 'invalid_grant', detail: 'expired' }),
    );
    const error = await captureAuthError(refreshDeviceToken(CONTEXT, 'bad'));
    expect(error.code).toBe('invalid_grant');
  });
});

describe('PKCE 浏览器授权', () => {
  it('打开授权页前已有本地 ID，换 token 请求携带稳定 ID 与元信息', async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse());
    const openBrowser = vi.fn(sendCallback);

    const result = await authorizeWithBrowser(CONTEXT, { openBrowser });

    expect(openBrowser).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://platform.example/api/bridge/token');
    expect(requestBody(0)).toEqual({
      code: 'pkce-code',
      codeVerifier: expect.any(String),
      redirectUri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
      clientId: 'agent-bridge',
      deviceId: DEVICE_ID,
      hostname: 'test-host',
      platform: 'win32',
      cliVersion: '0.2.3-test',
    });
    expect(result).toEqual({
      platformUrl: 'https://platform.example',
      deviceToken: 'device-token-secret',
      refreshToken: 'refresh-token-secret',
    });
    expect(result).not.toHaveProperty('deviceId');
  });
});

describe('设备码授权', () => {
  it('申请正文保持不变，轮询携带同一身份并按服务端 interval 在 pending 后继续', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        device_code: 'device-code-123',
        user_code: 'USER-123',
        verification_uri: 'https://platform.example/verify',
        interval: 2,
        expires_in: 60,
      }))
      .mockResolvedValueOnce(jsonResponse(428, { code: 'authorization_pending' }))
      .mockResolvedValueOnce(tokenResponse());
    const onPrompt = vi.fn();

    const promise = authorizeWithDeviceCode(CONTEXT, { onPrompt });
    const observed = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(0);

    expect(onPrompt).toHaveBeenCalledWith('https://platform.example/verify', 'USER-123');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://platform.example/api/bridge/device-code');
    expect(requestBody(0)).toEqual({ clientId: 'agent-bridge' });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://platform.example/api/bridge/device-token');
    expect(requestBody(1)).toEqual({
      device_code: 'device-code-123',
      clientId: 'agent-bridge',
      deviceId: DEVICE_ID,
      hostname: 'test-host',
      platform: 'win32',
      cliVersion: '0.2.3-test',
    });

    await vi.advanceTimersByTimeAsync(2_000);
    const settled = await observed;
    if ('error' in settled) throw settled.error;
    expect(settled.value).toEqual({
      platformUrl: 'https://platform.example',
      deviceToken: 'device-token-secret',
      refreshToken: 'refresh-token-secret',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('终态错误后立即停止，不重放旧 device_code', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        device_code: 'terminal-device-code',
        user_code: 'USER-123',
        verification_uri: 'https://platform.example/verify',
        interval: 1,
        expires_in: 60,
      }))
      .mockResolvedValueOnce(jsonResponse(409, { code: 'device_bound_to_other_account' }));

    const promise = authorizeWithDeviceCode(CONTEXT);
    const observed = promise.then(
      () => { throw new Error('终态错误后仍完成了授权'); },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await observed).toMatchObject({
      name: 'AuthError',
      httpStatus: 409,
      code: 'device_bound_to_other_account',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('成功 200 缺少 device_token 时立即报协议错误，不再轮询', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, {
        device_code: 'malformed-success-code',
        user_code: 'USER-123',
        verification_uri: 'https://platform.example/verify',
        interval: 1,
        expires_in: 60,
      }))
      .mockResolvedValueOnce(tokenResponse({ device_token: undefined }));

    const promise = authorizeWithDeviceCode(CONTEXT);
    const observed = promise.then(
      () => { throw new Error('缺字段的成功响应不应完成授权'); },
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await observed).toMatchObject({ name: 'AuthError' });
    expect((await observed).message).toMatch(/协议/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('授权响应协议校验', () => {
  it.each([
    ['device_token 缺失', { device_token: undefined }],
    ['device_token 为空', { device_token: '' }],
    ['device_token 类型错误', { device_token: 42 }],
    ['refresh_token 为空', { refresh_token: '' }],
    ['refresh_token 类型错误', { refresh_token: 42 }],
    ['device_id 缺失', { device_id: undefined }],
    ['device_id 非法', { device_id: 'bd_NOT-VALID' }],
    ['device_id 不一致', { device_id: 'bd_fedcba9876543210fedcba9876543210' }],
  ])('%s 时拒绝返回凭证', async (_name, responseOverride) => {
    fetchMock.mockResolvedValueOnce(tokenResponse(responseOverride));

    const error = await captureAuthError(authorizeWithBrowser(CONTEXT, { openBrowser: sendCallback }));

    expect(error.message).toMatch(/协议/);
    expect(error.message).not.toContain('device-token-secret');
    expect(error.message).not.toContain('refresh-token-secret');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('平台错误映射与不重放', () => {
  it.each([
    [400, 'invalid_device_id', /本地设备身份格式无效/],
    [409, 'device_bound_to_other_account', /已绑定其他账号.*平台管理员/],
    [409, 'device_identity_ambiguous', /历史重复.*平台管理员/],
    [401, 'unauthorized', /授权或凭证失败/],
    [403, 'forbidden', /授权或凭证失败/],
  ])('HTTP %i / %s 映射为受控 AuthError', async (status, code, message) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, {
      code,
      message: '内部详情 device-token-secret Authorization: Bearer refresh-token-secret',
    }));

    const error = await captureAuthError(authorizeWithBrowser(CONTEXT, { openBrowser: sendCallback }));

    expect(error).toMatchObject({ httpStatus: status, code });
    expect(error.message).toMatch(message);
    expect(error.message).not.toContain('内部详情');
    expect(error.message).not.toContain('device-token-secret');
    expect(error.message).not.toContain('refresh-token-secret');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('浏览器流程收到 authorization_pending 也立即终止，不当作轮询信号', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(428, { code: 'authorization_pending' }));

    const error = await captureAuthError(authorizeWithBrowser(CONTEXT, { openBrowser: sendCallback }));

    expect(error).toMatchObject({ httpStatus: 428, code: 'authorization_pending' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('其他错误仅保留顶层公开 code，不泄露正文或写日志', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fetchMock.mockResolvedValueOnce(jsonResponse(500, {
      code: 'internal_error',
      debug: 'secret-response-body device-token-secret',
    }));

    const error = await captureAuthError(authorizeWithBrowser(CONTEXT, { openBrowser: sendCallback }));

    expect(error).toMatchObject({ httpStatus: 500, code: 'internal_error' });
    expect(error.message).toContain('HTTP 500');
    expect(error.message).not.toContain('secret-response-body');
    expect(error.message).not.toContain('device-token-secret');
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each([
    ['网络错误', new Error('injected network failure')],
    ['超时', new DOMException('injected timeout', 'TimeoutError')],
  ])('%s 终止本轮且不重放授权码', async (_name, failure) => {
    fetchMock.mockRejectedValueOnce(failure);

    const error = await captureAuthError(authorizeWithBrowser(CONTEXT, { openBrowser: sendCallback }));

    expect(error.message).toMatch(/连接平台失败/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('保留 token 端点 404 的未实现提示', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { code: 'not_found' }));

    const error = await captureAuthError(authorizeWithBrowser(CONTEXT, { openBrowser: sendCallback }));

    expect(error.message).toContain('/api/bridge/token');
    expect(error.message).toMatch(/未上线|还没有实现/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('保留 device-code 端点 404 的未实现提示', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { code: 'not_found' }));

    const error = await captureAuthError(authorizeWithDeviceCode(CONTEXT));

    expect(error.message).toContain('/api/bridge/device-code');
    expect(error.message).toMatch(/未上线|还没有实现/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

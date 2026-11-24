import { describe, expect, it, vi } from 'vitest';
import { externalProxyEnv, parseWindowsProxyRegistry } from '../src/infra/proxy-env.js';

describe('外部代理环境', () => {
  it('解析 Windows 单一代理与分协议代理，未启用时不返回', () => {
    const enabled = 'ProxyEnable    REG_DWORD    0x1';
    const disabled = 'ProxyEnable    REG_DWORD    0x0';
    expect(parseWindowsProxyRegistry(enabled, 'ProxyServer    REG_SZ    127.0.0.1:7897')).toBe(
      'http://127.0.0.1:7897',
    );
    expect(
      parseWindowsProxyRegistry(enabled, 'ProxyServer    REG_SZ    http=127.0.0.1:80;https=127.0.0.1:7897'),
    ).toBe('http://127.0.0.1:7897');
    expect(parseWindowsProxyRegistry(disabled, 'ProxyServer    REG_SZ    127.0.0.1:7897')).toBeUndefined();
  });

  it('显式 AGENT_BRIDGE_EXTERNAL_PROXY 优先，Windows 自动读取系统代理', () => {
    const detect = vi.fn(() => 'http://127.0.0.1:7897');
    const explicit = externalProxyEnv(
      { AGENT_BRIDGE_EXTERNAL_PROXY: 'http://127.0.0.1:9000' },
      { platform: 'win32', detect },
    );
    expect(explicit.HTTPS_PROXY).toBe('http://127.0.0.1:9000');
    expect(detect).not.toHaveBeenCalled();

    const automatic = externalProxyEnv({}, { platform: 'win32', detect });
    expect(automatic).toMatchObject({
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897',
      http_proxy: 'http://127.0.0.1:7897',
    });
  });

  it('非 Windows 无显式覆盖时不改环境，也不探测注册表', () => {
    const detect = vi.fn(() => 'http://127.0.0.1:7897');
    const base = { HTTPS_PROXY: 'http://proxy.internal:8080', NO_PROXY: 'localhost' };
    expect(externalProxyEnv(base, { platform: 'linux', detect })).toEqual(base);
    expect(detect).not.toHaveBeenCalled();
  });
});

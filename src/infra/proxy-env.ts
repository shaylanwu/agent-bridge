/** 外部 CLI 的代理环境：显式配置优先，Windows 自动读取当前用户的系统代理。 */
import { execFileSync } from 'node:child_process';

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function normalizeProxy(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function parseWindowsProxyRegistry(enableOutput: string, serverOutput: string): string | undefined {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enableOutput)) return undefined;
  const match = /ProxyServer\s+REG_SZ\s+(.+)$/im.exec(serverOutput);
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  if (!value.includes('=')) return normalizeProxy(value);
  const entries = new Map(
    value
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const at = part.indexOf('=');
        return [part.slice(0, at).toLowerCase(), part.slice(at + 1)] as const;
      }),
  );
  return normalizeProxy(entries.get('https') ?? entries.get('http') ?? '');
}

function queryRegistry(value: string): string {
  return execFileSync('reg.exe', ['query', INTERNET_SETTINGS, '/v', value], {
    encoding: 'utf8',
    timeout: 1_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
}

export function detectWindowsSystemProxy(): string | undefined {
  try {
    return parseWindowsProxyRegistry(queryRegistry('ProxyEnable'), queryRegistry('ProxyServer'));
  } catch {
    return undefined;
  }
}

export function externalProxyEnv(
  base: NodeJS.ProcessEnv,
  opts: { platform?: NodeJS.Platform; detect?: () => string | undefined } = {},
): NodeJS.ProcessEnv {
  const explicit = normalizeProxy(base['AGENT_BRIDGE_EXTERNAL_PROXY'] ?? '');
  const proxy =
    explicit ??
    ((opts.platform ?? process.platform) === 'win32'
      ? (opts.detect ?? detectWindowsSystemProxy)()
      : undefined);
  if (!proxy) return { ...base };
  return {
    ...base,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
  };
}

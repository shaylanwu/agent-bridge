/**
 * 本地配置：`~/.agent-bridge/config.toml`（Windows 为 `%APPDATA%\bridge\config.toml`）
 *
 * 安全：文件权限 0600（仅当前用户可读写）；终端输出**永不打印** device_token 明文，
 * 只显示尾号与设备 id。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export interface BridgeConfig {
  platformUrl: string;
  deviceId: string;
  deviceToken: string;
  refreshToken?: string;
  /** 设备展示名（默认 hostname） */
  label?: string;
  /** 记一次绑定时间，便于排查 */
  boundAt?: string;
}

export function configPath(): string {
  if (process.env.AGENT_BRIDGE_CONFIG) return process.env.AGENT_BRIDGE_CONFIG;
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : join(homedir(), '.bridge');
  return process.platform === 'win32'
    ? join(base, 'agent-bridge', 'config.toml')
    : join(base, 'config.toml');
}

export function loadConfig(): BridgeConfig | null {
  const file = configPath();
  if (!existsSync(file)) return null;
  try {
    const raw = parseToml(readFileSync(file, 'utf8')) as unknown as BridgeConfig;
    if (!raw?.platformUrl || !raw?.deviceId) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveConfig(cfg: BridgeConfig): string {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  // smol-toml 的类型要求索引签名，这里用它的 stringify 前先收窄成普通对象
  const body = stringifyToml(cfg as unknown as Record<string, unknown>);
  writeFileSync(file, `${body}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 只改只读位；文件仍在用户目录内，属可接受范围
  }
  return file;
}

export function clearConfig(): boolean {
  const file = configPath();
  if (!existsSync(file)) return false;
  writeFileSync(file, '', { encoding: 'utf8', mode: 0o600 });
  return true;
}

/** 只回尾号，用于终端展示 */
export function tokenTail(token: string): string {
  return token.length <= 8 ? '****' : `…${token.slice(-6)}`;
}

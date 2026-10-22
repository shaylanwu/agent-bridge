/**
 * 本地配置：`~/.agent-bridge/config.toml`（Windows 为 `%APPDATA%\agent-bridge\config.toml`）
 *
 * 安全：文件权限 0600（仅当前用户可读写）；终端输出**永不打印** device_token 明文，
 * 只显示尾号与设备 id。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export interface BridgeConfig {
  platformUrl: string;
  deviceId: string;
  deviceToken: string;
  refreshToken?: string;
  /** 任务只允许在这些目录下执行（缺省 = 不限制；见 runner 的 allowedCwd 校验） */
  allowedCwd?: string[];
  /** 设备展示名（默认 hostname） */
  label?: string;
  /** 记一次绑定时间，便于排查 */
  boundAt?: string;
}

/**
 * 白名单条目规范化：`resolve()` 成绝对路径、丢弃空项、去重；空数组等价于「未配置」。
 * 配置里写相对路径（如 `"./"`）时以启动 bridge 时的 cwd 为基准 —— 规范化一次，避免每次任务都算。
 */
export function normalizeAllowedCwd(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dirs = value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => resolve(v.trim()));
  return dirs.length ? [...new Set(dirs)] : undefined;
}

export function configPath(): string {
  if (process.env.AGENT_BRIDGE_CONFIG) return process.env.AGENT_BRIDGE_CONFIG;
  // 三处口径必须一致（README / CHANGELOG / 本文件）：目录名统一 `.agent-bridge`
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : homedir();
  return join(base, '.agent-bridge', 'config.toml');
}

export function loadConfig(): BridgeConfig | null {
  const file = configPath();
  if (!existsSync(file)) return null;
  try {
    const raw = parseToml(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (!raw['platformUrl'] || !raw['deviceId']) return null;
    // 白名单：文档口径是 snake_case（allowed_cwd），同时兼容早期手写的 camelCase
    const allowedCwd = normalizeAllowedCwd(raw['allowed_cwd'] ?? raw['allowedCwd']);
    return { ...(raw as unknown as BridgeConfig), allowedCwd };
  } catch {
    return null;
  }
}

export function saveConfig(cfg: BridgeConfig): string {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  // 显式构造输出对象：避免写入 undefined 字段，且白名单统一落 snake_case（与 README 一致）
  const out: Record<string, unknown> = {
    platformUrl: cfg.platformUrl,
    deviceId: cfg.deviceId,
    deviceToken: cfg.deviceToken,
  };
  if (cfg.refreshToken) out['refreshToken'] = cfg.refreshToken;
  if (cfg.allowedCwd?.length) out['allowed_cwd'] = cfg.allowedCwd;
  if (cfg.label) out['label'] = cfg.label;
  if (cfg.boundAt) out['boundAt'] = cfg.boundAt;
  const body = stringifyToml(out);
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

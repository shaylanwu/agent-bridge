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
  /** 同时运行的任务数上限（缺省 3；见 resolveMaxTasks） */
  maxTasks?: number;
  /** 排队等待的任务数上限（缺省 32；见 resolveMaxQueued） */
  maxQueued?: number;
  /** diff 文本上限（字节，缺省 256 KB；见 resolveDiffMaxBytes） */
  diffMaxBytes?: number;
  /** 全局默认开启 diff 捕获（平台未下发 captureDiff 时也捕获；缺省 false） */
  diffDefault?: boolean;
  /** 强制要求有效的服务令牌才执行任务（缺省 false = 兼容无令牌的老平台） */
  requireServiceToken?: boolean;
  /** 本地回环控制面（默认关闭；见 resolveControlPlane） */
  controlPlane?: {
    enabled?: boolean;
    host?: string;
    port?: number;
    /** 是否强制 scope 令牌（默认 true；关掉等于本机任意程序可调用） */
    requireToken?: boolean;
  };
  /** 设备展示名（默认 hostname） */
  label?: string;
  /** 记一次绑定时间，便于排查 */
  boundAt?: string;
}

/**
 * 并发上限解析：`AGENT_BRIDGE_MAX_TASKS`（临时/CI 覆盖）> config.toml 的 `max_tasks` > 默认 3。
 * 夹在 1~32：0 或负数会让 bridge 一个任务都跑不了，过大则回到"并发打爆开发机"的老问题。
 */
export const DEFAULT_MAX_TASKS = 3;
const MAX_TASKS_CEILING = 32;

export function resolveMaxTasks(fromConfig?: number): number {
  const envRaw = Number(process.env['AGENT_BRIDGE_MAX_TASKS'] ?? '');
  const chosen = Number.isFinite(envRaw) && envRaw > 0 ? envRaw : fromConfig;
  if (!Number.isFinite(chosen ?? NaN) || (chosen ?? 0) <= 0) return DEFAULT_MAX_TASKS;
  return Math.min(MAX_TASKS_CEILING, Math.max(1, Math.floor(chosen as number)));
}

/** 队列上限：默认 32，夹在 0~1024（0 = 不允许排队，超限直接失败） */
export const DEFAULT_MAX_QUEUED = 32;
const MAX_QUEUED_CEILING = 1024;

export function resolveMaxQueued(fromConfig?: number): number {
  const rawEnv = process.env['AGENT_BRIDGE_MAX_QUEUE'];
  const envValue = rawEnv === undefined || rawEnv.trim() === '' ? undefined : Number(rawEnv);
  const chosen = envValue !== undefined && Number.isFinite(envValue) && envValue >= 0 ? envValue : fromConfig;
  if (chosen === undefined || !Number.isFinite(chosen) || chosen < 0) return DEFAULT_MAX_QUEUED;
  return Math.min(MAX_QUEUED_CEILING, Math.floor(chosen));
}

/** diff 上限：默认 256 KB，夹在 1 KB ~ 8 MB（人工审核看不了几 MB，也别让报文失控） */
export const DEFAULT_DIFF_MAX_BYTES = 256 * 1024;
const DIFF_MIN_BYTES = 1024;
const DIFF_MAX_CEILING = 8 * 1024 * 1024;

/** 解析顺序：`AGENT_BRIDGE_DIFF_MAX_BYTES` > config.toml 的 `diff_max_bytes` > 默认 256 KB */
export function resolveDiffMaxBytes(fromConfig?: number): number {
  const rawEnv = process.env['AGENT_BRIDGE_DIFF_MAX_BYTES'];
  const envValue = rawEnv === undefined || rawEnv.trim() === '' ? undefined : Number(rawEnv);
  const chosen = envValue !== undefined && Number.isFinite(envValue) && envValue > 0 ? envValue : fromConfig;
  if (chosen === undefined || !Number.isFinite(chosen) || chosen <= 0) return DEFAULT_DIFF_MAX_BYTES;
  return Math.min(DIFF_MAX_CEILING, Math.max(DIFF_MIN_BYTES, Math.floor(chosen)));
}

/** 控制面默认端口（显式写在配置里即可改；端口 0 = 由系统分配） */
export const DEFAULT_CONTROL_PLANE_PORT = 8787;
/** 控制面只允许绑回环：非回环一律回落，不报错也不放行（护栏另有一道硬校验） */
const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

export interface ControlPlaneSettings {
  enabled: boolean;
  host: string;
  port: number;
  requireToken: boolean;
}

/**
 * 控制面设置解析：`AGENT_BRIDGE_CONTROL_PLANE`（1/0，CI 临时开）> config.toml 的 `[control_plane]` > 默认（**关闭**）。
 *
 * 默认关闭是红线：不开就一个端口都不监听，"零入站"卖点不受影响。
 * host 只允许回环值，其它值静默回落 127.0.0.1。
 */
export function resolveControlPlane(fromConfig?: BridgeConfig['controlPlane']): ControlPlaneSettings {
  const envOn = process.env['AGENT_BRIDGE_CONTROL_PLANE'];
  const envEnabled = envOn === '1' || envOn === 'true' ? true : envOn === '0' || envOn === 'false' ? false : undefined;
  const rawHost = (fromConfig?.host ?? '').trim();
  const host = LOOPBACK_HOSTS.includes(rawHost) ? rawHost : '127.0.0.1';
  const rawPort = Number(fromConfig?.port ?? '');
  const envPort = Number(process.env['AGENT_BRIDGE_CONTROL_PORT'] ?? '');
  const port =
    Number.isFinite(envPort) && envPort >= 0
      ? Math.floor(envPort)
      : Number.isFinite(rawPort) && rawPort >= 0
        ? Math.floor(rawPort)
        : DEFAULT_CONTROL_PLANE_PORT;
  return {
    enabled: envEnabled ?? fromConfig?.enabled === true,
    host,
    port,
    // 默认必须带令牌：本机控制面一旦免鉴权，等于给机器上任何程序下发任务的权限
    requireToken: fromConfig?.requireToken !== false,
  };
}

/** 白名单条目规范化：`resolve()` 成绝对路径、丢弃空项、去重；空数组等价于「未配置」。
 * 配置里写相对路径（如 `"./"`）时以启动 bridge 时的 cwd 为基准 —— 规范化一次，避免每次任务都算。
 */
export function normalizeAllowedCwd(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const dirs = value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => resolve(v.trim()));
  return dirs.length ? [...new Set(dirs)] : undefined;
}

/** 本地状态目录（`~/.agent-bridge/`）。config.toml / services.toml / audit.jsonl 都在这里 */
export function stateDir(): string {
  return dirname(configPath());
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
    const maxTasksRaw = Number(raw['max_tasks'] ?? raw['maxTasks'] ?? '');
    const maxTasks = Number.isFinite(maxTasksRaw) && maxTasksRaw > 0 ? Math.floor(maxTasksRaw) : undefined;
    const maxQueuedRaw = Number(raw['max_queue'] ?? raw['maxQueued'] ?? '');
    const maxQueued = Number.isFinite(maxQueuedRaw) && maxQueuedRaw >= 0 ? Math.floor(maxQueuedRaw) : undefined;
    const diffRaw = Number(raw['diff_max_bytes'] ?? raw['diffMaxBytes'] ?? '');
    const diffMaxBytes = Number.isFinite(diffRaw) && diffRaw > 0 ? Math.floor(diffRaw) : undefined;
    const diffDefault = raw['diff_default'] === true || raw['diffDefault'] === true;
    const requireServiceToken = raw['require_service_token'] === true || raw['requireServiceToken'] === true;
    // 控制面：[control_plane] 表；也兼容 `control_plane_enabled = true` 这种扁平写法
    const cpRaw = (raw['control_plane'] ?? {}) as Record<string, unknown>;
    const cpEnabled = cpRaw['enabled'] === true || raw['control_plane_enabled'] === true;
    const controlPlane = {
      enabled: cpEnabled,
      host: typeof cpRaw['host'] === 'string' ? cpRaw['host'] : undefined,
      port: Number.isFinite(Number(cpRaw['port'])) ? Math.floor(Number(cpRaw['port'])) : undefined,
      requireToken: cpRaw['require_token'] !== false,
    };
    return {
      ...(raw as unknown as BridgeConfig),
      allowedCwd,
      maxTasks,
      maxQueued,
      diffMaxBytes,
      diffDefault,
      requireServiceToken,
      controlPlane,
    };
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
  if (cfg.maxTasks) out['max_tasks'] = cfg.maxTasks;
  if (cfg.maxQueued !== undefined) out['max_queue'] = cfg.maxQueued;
  if (cfg.diffMaxBytes) out['diff_max_bytes'] = cfg.diffMaxBytes;
  if (cfg.diffDefault) out['diff_default'] = true;
  if (cfg.requireServiceToken) out['require_service_token'] = true;
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

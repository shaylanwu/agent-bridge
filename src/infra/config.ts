/**
 * 本地配置：`~/.agent-bridge/config.toml`（Windows 为 `%APPDATA%\agent-bridge\config.toml`）
 *
 * 安全：文件权限 0600（仅当前用户可读写）；终端输出**永不打印** device_token 明文，
 * 只显示尾号与设备 id。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { assertDeviceId } from '../core/device-identity.js';
import { writeAtomicFile } from './atomic-file.js';

export interface BridgeConfig {
  platformUrl: string;
  deviceId: string;
  deviceToken?: string;
  refreshToken?: string;
  /** 任务只允许在这些目录下执行（缺省 = 不限制；见 runner 的 allowedCwd 校验） */
  allowedCwd?: string[];
  /** 同时运行的任务数上限（缺省 30；见 resolveMaxTasks） */
  maxTasks?: number;
  /** 排队等待的任务数上限（缺省 60；见 resolveMaxQueued） */
  maxQueued?: number;
  /** diff 文本上限（字节，缺省 256 KB；见 resolveDiffMaxBytes） */
  diffMaxBytes?: number;
  /** 全局默认开启 diff 捕获（平台未下发 captureDiff 时也捕获；缺省 false） */
  diffDefault?: boolean;
  /** 强制要求有效的服务令牌才执行任务（缺省 false = 兼容无令牌的老平台） */
  requireServiceToken?: boolean;
  /** waiting_user 会话空闲多久自动关闭（毫秒，缺省 0 = 不自动关闭） */
  sessionIdleMs?: number;
  /** 控制面 principal JWT（可选；缺省不启用） */
  jwt?: {
    jwksUrl: string;
    issuer?: string;
    audience?: string;
    tenantClaim?: string;
    cacheMs?: number;
  };
  /** 本机 MCP server 宿主配置（stdio） */
  mcp?: {
    servers: Record<
      string,
      {
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
      }
    >;
  };
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

export interface BoundBridgeConfig extends BridgeConfig {
  deviceToken: string;
}

/**
 * 并发上限解析：启动参数 `--max-tasks` > `AGENT_BRIDGE_MAX_TASKS`（临时/CI 覆盖）
 * > config.toml 的 `max_tasks` > 默认 30。
 * 夹在 1~128：0 或负数会让 bridge 一个任务都跑不了；128 是防手滑的保险丝，
 * 批量调度场景的默认值是 30（2026-10-24 调整，原为 3），真需要更高请先评估本机资源。
 */
export const DEFAULT_MAX_TASKS = 30;
const MAX_TASKS_CEILING = 128;

export function resolveMaxTasks(fromConfig?: number, override?: number): number {
  const envRaw = Number(process.env['AGENT_BRIDGE_MAX_TASKS'] ?? '');
  const chosen =
    override !== undefined && Number.isFinite(override) && override > 0
      ? override
      : Number.isFinite(envRaw) && envRaw > 0
        ? envRaw
        : fromConfig;
  if (!Number.isFinite(chosen ?? NaN) || (chosen ?? 0) <= 0) return DEFAULT_MAX_TASKS;
  return Math.min(MAX_TASKS_CEILING, Math.max(1, Math.floor(chosen as number)));
}

/**
 * 队列上限：默认 60，夹在 0~1024（0 = 不允许排队，超限直接失败）。
 * 优先级：启动参数 `--max-queue` > `AGENT_BRIDGE_MAX_QUEUE` > config.toml 的 `max_queue` > 默认。
 */
/**
 * waiting_user 空闲关闭：默认 0（不自动关闭，保持旧行为）。
 * 环境变量 `AGENT_BRIDGE_SESSION_IDLE_MS` > config.toml `session_idle_ms`。
 * 上限 24h，防止手滑写成 `99999999999` 把会话永久占住。
 */
export function resolveSessionIdleMs(fromConfig?: number): number {
  const raw = process.env['AGENT_BRIDGE_SESSION_IDLE_MS'];
  const envRaw = raw === undefined || raw.trim() === '' ? undefined : Number(raw);
  const chosen = envRaw !== undefined && Number.isFinite(envRaw) && envRaw >= 0 ? envRaw : fromConfig;
  if (!Number.isFinite(chosen ?? NaN) || (chosen ?? 0) <= 0) return 0;
  return Math.min(24 * 60 * 60 * 1000, Math.floor(chosen as number));
}

export const DEFAULT_MAX_QUEUED = 60;
const MAX_QUEUED_CEILING = 1024;

export function resolveMaxQueued(fromConfig?: number, override?: number): number {
  const rawEnv = process.env['AGENT_BRIDGE_MAX_QUEUE'];
  const envValue = rawEnv === undefined || rawEnv.trim() === '' ? undefined : Number(rawEnv);
  const chosen =
    override !== undefined && Number.isFinite(override) && override >= 0
      ? override
      : envValue !== undefined && Number.isFinite(envValue) && envValue >= 0
        ? envValue
        : fromConfig;
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

/**
 * Session/Turn/Event SQLite 路径。
 * 默认与配置同目录；`AGENT_BRIDGE_STATE_DB` 仅供测试/运维显式覆盖。
 */
export function stateDbPath(): string {
  const override = process.env['AGENT_BRIDGE_STATE_DB']?.trim();
  return override ? override : join(stateDir(), 'state.db');
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

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function invalidConfig(file: string, detail: string): Error {
  return new Error(`配置无效：${file}。${detail}；请修复该文件后重试。`);
}

function optionalString(raw: Record<string, unknown>, key: string, file: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') throw invalidConfig(file, `${key} 必须是非空字符串`);
  return value;
}

function optionalNumber(
  value: unknown,
  name: string,
  file: string,
  minimum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw invalidConfig(file, `${name} 必须是不小于 ${minimum} 的有限数字`);
  }
  return Math.floor(value);
}

function optionalBoolean(value: unknown, name: string, file: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidConfig(file, `${name} 必须是布尔值`);
  return value;
}

function serializeConfig(cfg: BridgeConfig): string {
  const out: Record<string, unknown> = {
    platformUrl: cfg.platformUrl,
    deviceId: cfg.deviceId,
  };
  if (cfg.deviceToken !== undefined) out['deviceToken'] = cfg.deviceToken;
  if (cfg.refreshToken !== undefined) out['refreshToken'] = cfg.refreshToken;
  if (cfg.allowedCwd?.length) out['allowed_cwd'] = cfg.allowedCwd;
  if (cfg.maxTasks !== undefined) out['max_tasks'] = cfg.maxTasks;
  if (cfg.maxQueued !== undefined) out['max_queue'] = cfg.maxQueued;
  if (cfg.diffMaxBytes !== undefined) out['diff_max_bytes'] = cfg.diffMaxBytes;
  if (cfg.diffDefault !== undefined) out['diff_default'] = cfg.diffDefault;
  if (cfg.requireServiceToken !== undefined) out['require_service_token'] = cfg.requireServiceToken;
  if (cfg.sessionIdleMs !== undefined) out['session_idle_ms'] = cfg.sessionIdleMs;
  if (cfg.mcp !== undefined) {
    const servers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(cfg.mcp.servers)) {
      servers[name] = {
        command: server.command,
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
      };
    }
    out['mcp'] = { servers };
  }
  if (cfg.jwt !== undefined) {
    out['jwt'] = {
      jwks_url: cfg.jwt.jwksUrl,
      ...(cfg.jwt.issuer !== undefined ? { issuer: cfg.jwt.issuer } : {}),
      ...(cfg.jwt.audience !== undefined ? { audience: cfg.jwt.audience } : {}),
      ...(cfg.jwt.tenantClaim !== undefined ? { tenant_claim: cfg.jwt.tenantClaim } : {}),
      ...(cfg.jwt.cacheMs !== undefined ? { cache_ms: cfg.jwt.cacheMs } : {}),
    };
  }
  if (cfg.controlPlane !== undefined) {
    const controlPlane: Record<string, unknown> = {};
    if (cfg.controlPlane.enabled !== undefined) controlPlane['enabled'] = cfg.controlPlane.enabled;
    if (cfg.controlPlane.host !== undefined) controlPlane['host'] = cfg.controlPlane.host;
    if (cfg.controlPlane.port !== undefined) controlPlane['port'] = cfg.controlPlane.port;
    if (cfg.controlPlane.requireToken !== undefined) controlPlane['require_token'] = cfg.controlPlane.requireToken;
    out['control_plane'] = controlPlane;
  }
  if (cfg.label !== undefined) out['label'] = cfg.label;
  if (cfg.boundAt !== undefined) out['boundAt'] = cfg.boundAt;
  const body = stringifyToml(out);
  return body.endsWith('\n') ? body : `${body}\n`;
}

export function loadConfig(): BridgeConfig | null {
  const file = configPath();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(`读取配置失败（${errorCode(error) ?? 'UNKNOWN'}）：${file}；请检查文件权限和路径后重试。`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = parseToml(text) as Record<string, unknown>;
  } catch {
    throw new Error(`解析配置失败：${file}；请修复 TOML 语法后重试。`);
  }

  const platformUrl = optionalString(raw, 'platformUrl', file);
  if (!platformUrl) throw invalidConfig(file, 'platformUrl 必须是非空字符串');

  const currentId = optionalString(raw, 'deviceId', file);
  const legacyId = optionalString(raw, 'device_id', file);
  if (currentId !== undefined && legacyId !== undefined && currentId !== legacyId) {
    throw invalidConfig(file, 'deviceId 与 legacy device_id 镜像冲突');
  }
  const deviceId = currentId ?? legacyId;
  if (deviceId === undefined) throw invalidConfig(file, '缺少 deviceId');
  try {
    assertDeviceId(deviceId);
  } catch {
    throw invalidConfig(file, 'deviceId 格式非法');
  }

  const deviceToken = optionalString(raw, 'deviceToken', file);
  const refreshToken = optionalString(raw, 'refreshToken', file);
  const boundAt = optionalString(raw, 'boundAt', file);
  if (deviceToken === undefined && (refreshToken !== undefined || boundAt !== undefined)) {
    throw invalidConfig(file, 'refreshToken/boundAt 只能与 deviceToken 同时存在');
  }

  const allowedRaw = raw['allowed_cwd'] ?? raw['allowedCwd'];
  if (allowedRaw !== undefined && (!Array.isArray(allowedRaw) || allowedRaw.some((value) => typeof value !== 'string' || value.trim() === ''))) {
    throw invalidConfig(file, 'allowed_cwd 必须是非空字符串数组');
  }
  const allowedCwd = normalizeAllowedCwd(allowedRaw);
  const sessionIdleMs = optionalNumber(
    raw['session_idle_ms'] ?? raw['sessionIdleMs'],
    'session_idle_ms',
    file,
    0,
  );
  const maxTasks = optionalNumber(raw['max_tasks'] ?? raw['maxTasks'], 'max_tasks', file, 1);
  const maxQueued = optionalNumber(raw['max_queue'] ?? raw['maxQueued'], 'max_queue', file, 0);
  const diffMaxBytes = optionalNumber(raw['diff_max_bytes'] ?? raw['diffMaxBytes'], 'diff_max_bytes', file, 1);
  const diffDefault = optionalBoolean(raw['diff_default'] ?? raw['diffDefault'], 'diff_default', file);
  const requireServiceToken = optionalBoolean(
    raw['require_service_token'] ?? raw['requireServiceToken'],
    'require_service_token',
    file,
  );
  const label = optionalString(raw, 'label', file);

  const cpValue = raw['control_plane'];
  if (cpValue !== undefined && (typeof cpValue !== 'object' || cpValue === null || Array.isArray(cpValue))) {
    throw invalidConfig(file, 'control_plane 必须是 TOML 表');
  }
  const cpRaw = (cpValue ?? {}) as Record<string, unknown>;
  const flatEnabled = optionalBoolean(raw['control_plane_enabled'], 'control_plane_enabled', file);
  const controlPlane = cpValue !== undefined || flatEnabled !== undefined
    ? {
        enabled: optionalBoolean(cpRaw['enabled'], 'control_plane.enabled', file) ?? flatEnabled,
        host: optionalString(cpRaw, 'host', file),
        port: optionalNumber(cpRaw['port'], 'control_plane.port', file, 0),
        requireToken: optionalBoolean(cpRaw['require_token'], 'control_plane.require_token', file),
      }
    : undefined;

  const mcpValue = raw['mcp'];
  if (mcpValue !== undefined && (typeof mcpValue !== 'object' || mcpValue === null || Array.isArray(mcpValue))) {
    throw invalidConfig(file, 'mcp 必须是 TOML 表');
  }
  let mcp: BridgeConfig['mcp'];
  if (mcpValue !== undefined) {
    const serversValue = (mcpValue as Record<string, unknown>)['servers'];
    if (serversValue !== undefined && (typeof serversValue !== 'object' || serversValue === null || Array.isArray(serversValue))) {
      throw invalidConfig(file, 'mcp.servers 必须是 TOML 表');
    }
    const servers: NonNullable<BridgeConfig['mcp']>['servers'] = {};
    for (const [name, value] of Object.entries((serversValue ?? {}) as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalidConfig(file, `mcp.servers.${name} 必须是 TOML 表`);
      }
      const server = value as Record<string, unknown>;
      const command = optionalString(server, 'command', file);
      if (!command) throw invalidConfig(file, `mcp.servers.${name}.command 必须是非空字符串`);
      const argsRaw = server['args'];
      if (argsRaw !== undefined && (!Array.isArray(argsRaw) || argsRaw.some((arg) => typeof arg !== 'string'))) {
        throw invalidConfig(file, `mcp.servers.${name}.args 必须是字符串数组`);
      }
      const envRaw = server['env'];
      if (envRaw !== undefined && (typeof envRaw !== 'object' || envRaw === null || Array.isArray(envRaw))) {
        throw invalidConfig(file, `mcp.servers.${name}.env 必须是 TOML 表`);
      }
      const env: Record<string, string> = {};
      for (const [key, val] of Object.entries((envRaw ?? {}) as Record<string, unknown>)) {
        if (typeof val !== 'string') throw invalidConfig(file, `mcp.servers.${name}.env.${key} 必须是字符串`);
        env[key] = val;
      }
      servers[name] = {
        command,
        ...(Array.isArray(argsRaw) ? { args: argsRaw as string[] } : {}),
        ...(optionalString(server, 'cwd', file) ? { cwd: optionalString(server, 'cwd', file) } : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }
    mcp = { servers };
  }

  const jwtValue = raw['jwt'];
  if (jwtValue !== undefined && (typeof jwtValue !== 'object' || jwtValue === null || Array.isArray(jwtValue))) {
    throw invalidConfig(file, 'jwt 必须是 TOML 表');
  }
  let jwt: BridgeConfig['jwt'];
  if (jwtValue !== undefined) {
    const jwtRaw = jwtValue as Record<string, unknown>;
    const jwksUrl = optionalString(jwtRaw, 'jwks_url', file);
    if (!jwksUrl) throw invalidConfig(file, 'jwt.jwks_url 必须是非空字符串');
    jwt = {
      jwksUrl,
      issuer: optionalString(jwtRaw, 'issuer', file),
      audience: optionalString(jwtRaw, 'audience', file),
      tenantClaim: optionalString(jwtRaw, 'tenant_claim', file),
      cacheMs: optionalNumber(jwtRaw['cache_ms'], 'jwt.cache_ms', file, 0),
    };
  }

  return {
    platformUrl,
    deviceId,
    ...(deviceToken !== undefined ? { deviceToken } : {}),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
    ...(allowedCwd !== undefined ? { allowedCwd } : {}),
    ...(maxTasks !== undefined ? { maxTasks } : {}),
    ...(maxQueued !== undefined ? { maxQueued } : {}),
    ...(diffMaxBytes !== undefined ? { diffMaxBytes } : {}),
    ...(diffDefault !== undefined ? { diffDefault } : {}),
    ...(requireServiceToken !== undefined ? { requireServiceToken } : {}),
    ...(sessionIdleMs !== undefined ? { sessionIdleMs } : {}),
    ...(mcp !== undefined ? { mcp } : {}),
    ...(jwt !== undefined ? { jwt } : {}),
    ...(controlPlane !== undefined ? { controlPlane } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(boundAt !== undefined ? { boundAt } : {}),
  };
}

export async function saveConfig(cfg: BoundBridgeConfig): Promise<string> {
  const file = configPath();
  await writeAtomicFile(file, serializeConfig(cfg));
  return file;
}

export async function clearConfig(): Promise<boolean> {
  const file = configPath();
  const cfg = loadConfig();
  if (!cfg) return false;
  delete cfg.deviceToken;
  delete cfg.refreshToken;
  delete cfg.boundAt;
  await writeAtomicFile(file, serializeConfig(cfg));
  return true;
}

/** 只回尾号，用于终端展示 */
export function tokenTail(token: string): string {
  return token.length <= 8 ? '****' : `…${token.slice(-6)}`;
}

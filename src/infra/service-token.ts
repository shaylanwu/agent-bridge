/**
 * Scoped service token（P0-8：服务间调用身份）
 *
 * 定位：给**任何外部系统**（编排平台后端、CI、IDE 插件、本地脚本）一个标准的服务身份 ——
 * 最小权限（scope）、可轮换、可吊销、带审计。不是为某一个平台做的单点功能。
 *
 * 形态：`abs_<kid>_<secret>`
 *  - `kid`：8 位十六进制，用于定位记录并支持**轮换宽限期**（新旧并存）；
 *  - `secret`：32 字节 base64url 随机串，本地**只存 SHA-256**，比对用 `timingSafeEqual`。
 *
 * 兼容策略（重要）：`require_service_token` 默认 false —— 本地没登记任何令牌时，
 * 平台不带令牌也能跑（v1 行为零破坏）；但**只要报文带了令牌就必须校验通过**，
 * 不存在"带了也跳过"的口子。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { stateDir, tokenTail } from './config.js';

/** 受控 scope 集合（新增 scope = 新增能力，必须同步文档） */
export const SERVICE_SCOPES = [
  'task:create',
  'task:cancel',
  'task:read',
  'task:approve',
  'task:respond',
  'device:read',
] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export interface ServiceTokenRecord {
  /** 稳定 id（svc_xxxx），吊销/轮换用它 */
  id: string;
  /** 令牌 key id，出现在令牌正文里，用于定位 */
  kid: string;
  label: string;
  scopes: ServiceScope[];
  /** hex(sha256(secret)) —— 明文永不落盘 */
  sha256: string;
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
  /** 轮换宽限期终点：在此之前的被轮换令牌仍然有效 */
  graceEndsAt?: string;
  /** 由哪条令牌轮换而来（追溯链） */
  rotatedFrom?: string;
  lastUsedAt?: string;
}

export interface Store {
  services: ServiceTokenRecord[];
}

const TOKEN_PREFIX = 'abs';
const SECRET_BYTES = 32;
const KID_HEX = 8;
const ID_HEX = 6;

export function servicesPath(): string {
  return join(stateDir(), 'services.toml');
}

export function loadServices(): ServiceTokenRecord[] {
  const file = servicesPath();
  if (!existsSync(file)) return [];
  try {
    const raw = parseToml(readFileSync(file, 'utf8')) as { services?: unknown };
    if (!Array.isArray(raw.services)) return [];
    return (raw.services as ServiceTokenRecord[]).filter(
      (s): s is ServiceTokenRecord => typeof s?.id === 'string' && typeof s?.sha256 === 'string',
    );
  } catch {
    return [];
  }
}

function saveServices(list: ServiceTokenRecord[]): void {
  const file = servicesPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${stringifyToml({ services: list })}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows 上 chmod 语义有限；文件在用户目录内，可接受
  }
}

/**
 * 随机串一律用 **hex**（不能用 base64url）：base64url 字母表里含 `_`，
 * 而 `_` 是令牌的分隔符，会让 `abs_<kid>_<secret>` 解析错位。
 */
function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function sha256Hex(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 归一化 scope：去重、只保留受控集合内的项；空集合视为 `task:create` */
export function normalizeScopes(input: string[] | undefined): ServiceScope[] {
  const cleaned = (input ?? [])
    .map((s) => s.trim())
    .filter((s): s is ServiceScope => (SERVICE_SCOPES as readonly string[]).includes(s));
  const uniq = [...new Set(cleaned)];
  return uniq.length > 0 ? uniq : ['task:create'];
}

export interface IssueOptions {
  label: string;
  scopes?: string[];
  /** 有效期（天）；0 / 缺省 = 不过期 */
  ttlDays?: number;
  rotatedFrom?: string;
}

export interface IssuedToken {
  record: ServiceTokenRecord;
  /** 明文只在签发这一刻出现一次，之后任何地方都不再保留 */
  token: string;
}

export function issueServiceToken(opts: IssueOptions): IssuedToken {
  const kid = hex(KID_HEX / 2);
  const secret = hex(SECRET_BYTES);
  const now = new Date();
  const record: ServiceTokenRecord = {
    id: `svc_${hex(ID_HEX / 2)}`,
    kid,
    label: opts.label.trim().slice(0, 64) || 'service',
    scopes: normalizeScopes(opts.scopes),
    sha256: sha256Hex(secret),
    createdAt: now.toISOString(),
    ...(opts.ttlDays && opts.ttlDays > 0
      ? { expiresAt: new Date(now.getTime() + opts.ttlDays * 86_400_000).toISOString() }
      : {}),
    ...(opts.rotatedFrom ? { rotatedFrom: opts.rotatedFrom } : {}),
  };
  const list = loadServices();
  list.push(record);
  saveServices(list);
  return { record, token: `${TOKEN_PREFIX}_${kid}_${secret}` };
}

export type DenyReason = 'missing' | 'malformed' | 'unknown-kid' | 'mismatch' | 'revoked' | 'expired' | 'scope';

export interface VerifyResult {
  ok: boolean;
  record?: ServiceTokenRecord;
  reason?: DenyReason;
  /** 人类可读原因（不含令牌内容） */
  message?: string;
}

/** 解析令牌正文；格式不对返回 undefined（不抛） */
function parseToken(token: string): { kid: string; secret: string } | undefined {
  const t = token.trim();
  const parts = t.split('_');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return undefined;
  const kid = parts[1] ?? '';
  const secret = parts[2] ?? '';
  if (!/^[0-9a-f]{8}$/.test(kid) || secret.length < 16) return undefined;
  return { kid, secret };
}

/**
 * 校验服务令牌 + scope。
 * 「没有令牌」与「令牌无效」是两件事：前者由调用方按 `requireServiceToken` 决定，后者一律拒绝。
 */
export function verifyServiceToken(
  token: string | undefined,
  requiredScope: ServiceScope,
  now = new Date(),
): VerifyResult {
  if (!token || !token.trim()) return { ok: false, reason: 'missing', message: '未提供服务令牌' };
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, reason: 'malformed', message: '服务令牌格式非法' };

  const list = loadServices();
  const rec = list.find((s) => s.kid === parsed.kid);
  if (!rec) return { ok: false, reason: 'unknown-kid', message: '服务令牌未登记（kid 未知）' };

  const expected = Buffer.from(rec.sha256, 'hex');
  const actual = Buffer.from(sha256Hex(parsed.secret), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'mismatch', message: '服务令牌不匹配' };
  }

  if (rec.expiresAt && Date.parse(rec.expiresAt) <= now.getTime()) {
    return { ok: false, reason: 'expired', message: '服务令牌已过期' };
  }
  if (rec.revokedAt) {
    const grace = rec.graceEndsAt ? Date.parse(rec.graceEndsAt) : Date.parse(rec.revokedAt);
    if (!(grace > now.getTime())) {
      return { ok: false, reason: 'revoked', message: '服务令牌已吊销' };
    }
  }
  if (!rec.scopes.includes(requiredScope)) {
    return { ok: false, reason: 'scope', message: `服务令牌缺少 scope：${requiredScope}` };
  }

  // 记录最近使用（best-effort：写失败不影响本次判定）
  try {
    const idx = list.findIndex((s) => s.id === rec.id);
    if (idx >= 0) {
      list[idx] = { ...rec, lastUsedAt: now.toISOString() };
      saveServices(list);
    }
  } catch {
    /* 旁路 */
  }
  return { ok: true, record: rec };
}

/** 本地是否已登记过任何服务令牌（决定"默认不强校验"是否成立） */
export function hasAnyService(): boolean {
  return loadServices().length > 0;
}

export function revokeServiceToken(id: string): boolean {
  const list = loadServices();
  const idx = list.findIndex((s) => s.id === id || s.kid === id);
  if (idx < 0) return false;
  const rec = list[idx];
  if (!rec) return false;
  list[idx] = { ...rec, revokedAt: new Date().toISOString(), graceEndsAt: undefined };
  saveServices(list);
  return true;
}

/**
 * 轮换：签发新令牌，旧令牌进入宽限期（期间仍然有效），宽限期后自动失效。
 * 这样平台可以"先换后撤"，不必停服。
 */
export function rotateServiceToken(id: string, graceHours = 24): IssuedToken | undefined {
  const list = loadServices();
  const idx = list.findIndex((s) => (s.id === id || s.kid === id) && !s.revokedAt);
  if (idx < 0) return undefined;
  const old = list[idx];
  if (!old) return undefined;
  const now = new Date();
  const issued = issueServiceToken({
    label: old.label,
    scopes: old.scopes,
    rotatedFrom: old.id,
  });
  const after = loadServices();
  const oldIdx = after.findIndex((s) => s.id === old.id);
  if (oldIdx >= 0 && after[oldIdx]) {
    after[oldIdx] = {
      ...after[oldIdx]!,
      revokedAt: now.toISOString(),
      graceEndsAt: new Date(now.getTime() + Math.max(0, graceHours) * 3_600_000).toISOString(),
    };
    saveServices(after);
  }
  return issued;
}

/** 展示用：令牌只打尾号（明文永不进终端/日志/审计） */
export function serviceTokenTail(token: string): string {
  return tokenTail(token);
}

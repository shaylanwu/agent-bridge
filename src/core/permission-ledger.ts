/**
 * 持久授权账本（1.0 approval ledger）—— 纯逻辑，不碰数据库。
 *
 * 为什么单独一层：账本的安全性全在「什么时候能自动批准」这一个判断上。
 * 把它写成纯函数，才能用测试把规则钉死；一旦散进 supervisor 的 Promise 回调里，
 * 任何一次重构都可能悄悄放宽条件，而放宽条件 = 无人值守地替用户点「永远允许」。
 *
 * 三条硬规则（来自 openspec specs/session-gateway「持久授权账本」）：
 *  1. 自动命中必须**同时**满足：请求本身真实提供了持久允许选项、fingerprint 匹配、permissionMode=default；
 *  2. full 模式永不用账本自动批准（残余权限请求 fail closed）；
 *  3. tool title/kind 与模型文本不得创建授权或扩大 scope —— 故 fingerprint 只取
 *     「工具 kind + 归一化资源」，**不取 title、不取模型输出的文字**。
 */

import { createHash } from 'node:crypto';

/** 持久授权的语义范围。v1 只开放 `always`（跨任务，带过期时间） */
export type ApprovalScope = 'always';

/** 账本记录（与 SQLite `approvals` 表一一对应） */
export interface ApprovalRecord {
  tenantId: string;
  approvalId: string;
  principalId: string;
  agentType: string;
  /** 工具类别（ACP toolCall.kind 归一化，如 execute / edit / read） */
  tool: string;
  /** 动作（v1 只有 permission） */
  action: string;
  /** 面向人的资源标识（basename，落库供审计阅读；匹配不用它） */
  resource: string;
  scope: string;
  /** 匹配用的稳定指纹（含完整归一化资源，见 approvalFingerprint） */
  fingerprint: string;
  expiresAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface PermissionTarget {
  /** 工具类别：ACP `toolCall.kind`，缺失时 `other` */
  tool: string;
  /** 归一化资源键（用于匹配，含目录）；无资源时为 `-` */
  resourceKey: string;
  /** 展示用资源名（basename），不含目录 */
  display: string;
}

/** ACP 受控 tool kind；不在表里的一律降级成 other（不按 title 猜） */
const TOOL_KINDS = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'other']);

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** 统一分隔符与大小写，保证同一资源在不同轮次算出同一指纹 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
}

/**
 * 从 ACP toolCall 提取「工具 + 资源」。
 *
 * 只认结构化字段：`kind`、`locations[].path`、`rawInput.file_path|path|command|url`。
 * `title` 是模型/CLI 写的自由文本，**故意不读** —— 否则一句"顺便帮我清空工作区"就可能被
 * 当成已授权的依据。
 */
export function permissionTarget(toolCall: unknown, cwd?: string): PermissionTarget {
  const call = asRecord(toolCall);
  const rawKind = typeof call?.['kind'] === 'string' ? (call['kind'] as string).toLowerCase() : '';
  const tool = TOOL_KINDS.has(rawKind) ? rawKind : 'other';

  // 1) locations[].path（ACP 标准字段，最可信）
  const locations = Array.isArray(call?.['locations']) ? (call?.['locations'] as unknown[]) : [];
  for (const loc of locations) {
    const path = asRecord(loc)?.['path'];
    if (typeof path === 'string' && path.trim()) {
      const full = normalizePath(path.trim());
      return { tool, resourceKey: full, display: baseName(full) };
    }
  }

  // 2) rawInput 里的结构化字段
  const input = asRecord(call?.['rawInput']);
  if (input) {
    for (const key of ['file_path', 'filePath', 'path', 'notebook_path'] as const) {
      const v = input[key];
      if (typeof v === 'string' && v.trim()) {
        const full = normalizePath(resolveAgainst(v.trim(), cwd));
        return { tool, resourceKey: full, display: baseName(full) };
      }
    }
    const command = input['command'];
    if (typeof command === 'string' && command.trim()) {
      // 只取命令首词：整条命令行每轮都不同，拿它做指纹等于永不命中
      const first = command.trim().split(/\s+/)[0] ?? '';
      return { tool, resourceKey: `cmd:${baseName(normalizePath(first))}`, display: 'command' };
    }
    const url = input['url'];
    if (typeof url === 'string' && url.trim()) {
      // URL 只留 host：查询串可能带 token，绝不进指纹或审计
      try {
        return { tool, resourceKey: `url:${new URL(url.trim()).host}`, display: 'url' };
      } catch {
        return { tool, resourceKey: 'url:-', display: 'url' };
      }
    }
  }

  return { tool, resourceKey: '-', display: '-' };
}

function baseName(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? '-').slice(0, 60);
}

function resolveAgainst(p: string, cwd?: string): string {
  if (!cwd) return p;
  if (/^([a-zA-Z]:[\\/]|[\\/])/.test(p)) return p;
  return `${normalizePath(cwd)}/${p}`;
}

/** 稳定指纹：sha256(agent | action | tool | resourceKey)，截 32 位 hex */
export function approvalFingerprint(input: {
  agentType: string;
  action?: string;
  tool: string;
  resourceKey: string;
}): string {
  const canonical = [
    input.agentType.toLowerCase(),
    (input.action ?? 'permission').toLowerCase(),
    input.tool.toLowerCase(),
    input.resourceKey.toLowerCase(),
  ].join('\u0000');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/**
 * 「持久允许」类选项的 ACP kind 取值。
 *
 * 不同 CLI 用词不一：ACP 规范是 `allow_always`，CodeBuddy/Grok 用 `allow_persistent`，
 * 少数实现用 `allow_session`。只认这三个 —— 其余（allow_once / reject_*）绝不落账本。
 */
export const PERSISTENT_OPTION_KINDS = ['allow_always', 'allow_persistent', 'allow_session'] as const;

/** 请求里真实存在的持久允许选项（找不到就是找不到，绝不构造 optionId） */
export function persistentAllowOption(
  options: unknown,
): { optionId: string; kind: string } | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const option of options) {
    const rec = asRecord(option);
    const optionId = rec?.['optionId'];
    const kind = rec?.['kind'];
    if (typeof optionId !== 'string' || typeof kind !== 'string') continue;
    if ((PERSISTENT_OPTION_KINDS as readonly string[]).includes(kind)) {
      return { optionId, kind };
    }
  }
  return undefined;
}

export interface MatchInput {
  fingerprint: string;
  permissionMode: 'default' | 'full';
  /** 请求是否真实提供了持久允许选项（false 时不得审批，哪怕账本命中） */
  hasPersistentOption: boolean;
  now?: number;
}

/**
 * 账本能否自动批准本次请求。
 *
 * ⚠️ 返回 true 的唯一含义是「可以复用用户此前的人工授权」；
 * 任一条件不满足都返回 false 并给出原因，调用方据此决定是否去问人。
 */
export function canAutoApprove(
  record: Pick<ApprovalRecord, 'fingerprint' | 'expiresAt' | 'revokedAt'> | undefined,
  input: MatchInput,
): { ok: true } | { ok: false; reason: string } {
  if (input.permissionMode !== 'default') {
    // full 已由受管参数模式整体放开，残余请求意味着该 CLI 还有自己的审批闸 —— 只能问人
    return { ok: false, reason: 'full_mode_no_ledger' };
  }
  if (!input.hasPersistentOption) return { ok: false, reason: 'no_persistent_option' };
  if (!record) return { ok: false, reason: 'no_match' };
  if (record.revokedAt) return { ok: false, reason: 'revoked' };
  if (record.fingerprint !== input.fingerprint) return { ok: false, reason: 'fingerprint_mismatch' };
  const now = input.now ?? Date.now();
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true };
}

/** 过期时间：未配置 TTL 时给 7 天（永不过期的授权不该存在） */
export const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function approvalExpiry(now: number, ttlMs: number = DEFAULT_APPROVAL_TTL_MS): string {
  return new Date(now + Math.max(60_000, ttlMs)).toISOString();
}

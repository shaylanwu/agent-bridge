/**
 * 审计流水：`~/.agent-bridge/audit.jsonl`（单行 JSON，追加，0600）
 *
 * 为什么单独一块：服务令牌校验、diff 捕获、任务执行都要留痕，且必须是**同一份**格式 ——
 * 否则每处各写一个 appendFile，格式必然漂移。
 *
 * 红线（对齐 .harness/rules/always-on.md）：
 *  - 绝不写令牌明文、凭据内容、diff 正文；只写 id / scope / purpose / 动作 / 结果；
 *  - 写失败（磁盘满、权限）**绝不抛异常** —— 审计是旁路，不能反过来搞挂任务执行。
 */

import { appendFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './config.js';

export type AuditOutcome = 'allowed' | 'denied' | 'executed' | 'error';

export interface AuditEntry {
  at: string;
  /** 动作：run_task / cancel_task / scan / token_issue / token_revoke / token_rotate */
  action: string;
  outcome: AuditOutcome;
  taskId?: string;
  agent?: string;
  cwd?: string;
  /** 服务身份（不含令牌） */
  requestedBy?: string;
  purpose?: string;
  serviceId?: string;
  scopes?: string[];
  /** 人类可读原因（拒绝时给出；不含敏感内容） */
  reason?: string;
}

export function auditPath(): string {
  return join(stateDir(), 'audit.jsonl');
}

/** 单行 JSON 字段上限：审计是给人排查用的，不是数据库 —— 超长一律截断 */
const MAX_FIELD = 300;

function clip(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const s = v.replace(/\r?\n/g, ' ');
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
}

export function writeAudit(entry: AuditEntry): void {
  try {
    const line = JSON.stringify({
      at: entry.at ?? new Date().toISOString(),
      action: entry.action,
      outcome: entry.outcome,
      taskId: clip(entry.taskId),
      agent: clip(entry.agent),
      cwd: clip(entry.cwd),
      requestedBy: clip(entry.requestedBy),
      purpose: clip(entry.purpose),
      serviceId: clip(entry.serviceId),
      scopes: entry.scopes?.slice(0, 16),
      reason: clip(entry.reason),
    });
    const file = auditPath();
    appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
    if (!existsSync(file)) return;
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows 上 chmod 只改只读位；文件仍在用户目录内，属可接受范围
    }
  } catch {
    // 审计失败绝不影响主流程
  }
}

/**
 * `agent-bridge approvals` —— 持久授权账本的查看与撤销（1.0）
 *
 * 账本只由人工在交互里选「永久允许」时写入；这里补上**撤销**这一半 ——
 * 没有撤销入口的持久授权等于永久后门，所以它和写入在同一批交付。
 *
 * 存储是本地 SQLite（与 session/event 同一个库），命令层只做打印与调用，语义在
 * `core/permission-ledger.ts`（判定）与 `core/session-store.ts`（持久化）。
 */

import { posFlag, strFlag, type Flags } from '../cli/flags.js';
import { C, out } from '../cli/render.js';
import { DEFAULT_TENANT, SessionStore } from '../core/session-store.js';
import { stateDbPath } from '../infra/config.js';
import { writeAudit } from '../infra/audit.js';

export function cmdApprovals(flags: Flags): void {
  const sub = posFlag(flags, 1) || 'list';
  const tenantId = strFlag(flags, 'tenant') ?? DEFAULT_TENANT;
  const withRevoked = flags['all'] === true || flags['all'] === 'true';

  let store: SessionStore | undefined;
  const open = (): SessionStore => {
    store = new SessionStore(stateDbPath());
    return store;
  };

  try {
    if (sub === 'list') {
      const rows = open().listApprovals(tenantId, withRevoked);
      if (!rows.length) {
        out.info(
          '账本为空。开启方式：config.toml 设 approval_ledger_enabled = true（或 connect --approval-ledger），' +
            '之后交互里选择「永久允许」才会记录。',
        );
        return;
      }
      console.log(C.bold('\nID                      AGENT             TOOL      资源            到期时间'));
      console.log(C.dim('─'.repeat(96)));
      const now = Date.now();
      for (const row of rows) {
        const expired = row.expiresAt !== undefined && Date.parse(row.expiresAt) <= now;
        const state = row.revokedAt ? C.red('已撤销 ') : expired ? C.yellow('已过期 ') : '';
        console.log(
          `${row.approvalId.padEnd(24)}${row.agentType.padEnd(18)}${row.tool.padEnd(10)}` +
            `${row.resource.slice(0, 14).padEnd(16)}${row.expiresAt ?? '-'}  ${state}`,
        );
      }
      console.log('');
      out.info(`共 ${rows.length} 条${withRevoked ? '' : '（不含已撤销；加 --all 可看）'}`);
      return;
    }

    if (sub === 'revoke') {
      const id = strFlag(flags, 'id') ?? posFlag(flags, 2);
      if (!id) return out.fatal('用法：agent-bridge approvals revoke <approvalId>');
      const ok = open().revokeApproval(tenantId, id);
      if (!ok) {
        out.error(`未找到可撤销的授权：${id}`);
        process.exit(1);
      }
      out.ok(`✅ 已撤销 ${id}（后续任务不会再自动命中）`);
      writeAudit({
        at: new Date().toISOString(),
        action: 'approval_revoke',
        outcome: 'allowed',
        approvalId: id,
        reason: 'cli',
      });
      return;
    }

    if (sub === 'purge') {
      const removed = open().purgeExpiredApprovals(tenantId);
      out.ok(`✅ 已清理 ${removed} 条过期授权`);
      writeAudit({
        at: new Date().toISOString(),
        action: 'approval_purge',
        outcome: 'allowed',
        reason: `removed=${removed}`,
      });
      return;
    }

    return out.fatal(`未知子命令：approvals ${sub}\n可用：list / revoke / purge`);
  } finally {
    store?.close();
  }
}

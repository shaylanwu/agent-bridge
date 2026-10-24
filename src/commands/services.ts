/**
 * `agent-bridge services` —— 服务令牌生命周期（P0-8）
 *
 * 令牌明文只在 `issue` / `rotate` 这一刻打印一次，之后本地只有 SHA-256，终端只打尾号。
 * 这一层只做命令解析与打印；签发/校验/吊销的语义在 `infra/service-token.ts`。
 */

import { numFlag, posFlag, strFlag, type Flags } from '../cli/flags.js';
import { C, out } from '../cli/render.js';
import { writeAudit } from '../infra/audit.js';
import {
  issueServiceToken,
  loadServices,
  rotateServiceToken,
  revokeServiceToken,
  SERVICE_SCOPES,
} from '../infra/service-token.js';

export function cmdServices(flags: Flags): void {
  const sub = posFlag(flags, 1) || 'list';

  if (sub === 'issue') {
    const raw = (strFlag(flags, 'scopes') ?? 'task:create').split(',').filter(Boolean);
    const unknown = raw.filter((s) => !(SERVICE_SCOPES as readonly string[]).includes(s.trim()));
    if (unknown.length) {
      out.warn(
        `[agent-bridge] 忽略未知 scope：${unknown.join(', ')}（可用：${SERVICE_SCOPES.join(', ')}）`,
      );
    }
    const { record, token } = issueServiceToken({
      label: strFlag(flags, 'label') ?? 'service',
      scopes: raw,
      ttlDays: numFlag(flags, 'ttl-days', 0),
    });
    out.ok(`✅ 已签发服务令牌 ${record.id}（${record.label}）`);
    console.log(C.bold(`   ${token}`));
    out.info(
      `   scopes=${record.scopes.join(',')}  kid=${record.kid}${record.expiresAt ? `  有效期至 ${record.expiresAt}` : '  长期有效'}`,
    );
    out.warn('   ⚠️ 明文只显示这一次，请立即交给调用方；本地仅保存 SHA-256。');
    writeAudit({
      at: new Date().toISOString(),
      action: 'token_issue',
      outcome: 'allowed',
      serviceId: record.id,
      scopes: record.scopes,
      reason: record.label,
    });
    return;
  }

  if (sub === 'list') {
    const list = loadServices();
    if (!list.length) {
      out.info(
        '未签发任何服务令牌。用法：agent-bridge services issue --label=<name> --scopes=task:create,task:cancel',
      );
      return;
    }
    console.log(C.bold('\nID            SCOPES                              状态      最近使用'));
    console.log(C.dim('─'.repeat(84)));
    for (const s of list) {
      const revoked = s.revokedAt && !(s.graceEndsAt && Date.parse(s.graceEndsAt) > Date.now());
      const state = revoked ? C.red('已吊销') : s.revokedAt ? C.yellow('轮换中') : C.green('有效');
      console.log(`${s.id.padEnd(14)}${s.scopes.join(',').padEnd(36)}${state}      ${s.lastUsedAt ?? '-'}`);
    }
    console.log('');
    return;
  }

  if (sub === 'revoke') {
    const id = strFlag(flags, 'id') ?? posFlag(flags, 2);
    if (!id) return out.fatal('用法：agent-bridge services revoke <id>');
    if (!revokeServiceToken(id)) {
      out.error(`未找到服务令牌：${id}`);
      process.exit(1);
    }
    out.ok(`✅ 已吊销 ${id}`);
    writeAudit({ at: new Date().toISOString(), action: 'token_revoke', outcome: 'allowed', serviceId: id });
    return;
  }

  if (sub === 'rotate') {
    const id = strFlag(flags, 'id') ?? posFlag(flags, 2);
    if (!id) return out.fatal('用法：agent-bridge services rotate <id> [--grace-hours=24]');
    const grace = numFlag(flags, 'grace-hours', 24);
    const issued = rotateServiceToken(id, grace);
    if (!issued) {
      out.error(`未找到可轮换的服务令牌：${id}`);
      process.exit(1);
    }
    out.ok(`✅ 已轮换 ${id} → ${issued.record.id}（旧令牌宽限 ${grace}h）`);
    console.log(C.bold(`   ${issued.token}`));
    out.warn('   ⚠️ 明文只显示这一次。');
    writeAudit({
      at: new Date().toISOString(),
      action: 'token_rotate',
      outcome: 'allowed',
      serviceId: issued.record.id,
      reason: id,
    });
    return;
  }

  return out.fatal(`未知子命令：services ${sub}\n可用：issue / list / revoke / rotate`);
}

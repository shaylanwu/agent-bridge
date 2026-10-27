/**
 * `agent-bridge sessions` —— 本地状态库里会话历史的查看与清理（1.0）
 *
 * 存在的理由有两个，缺一不可：
 *  1. 运维现实：`state.db` 会随长跑不断长大（events 每回合几十条），需要一个受控的瘦身入口；
 *  2. 契约诚实：`session_deleted`（410）这个受控码必须真的能被触发 —— `close_session` 只写
 *     tombstone 并保留历史，所以「关了」和「没了」在数据层是两回事。本命令的 purge 是
 *     `session_deleted` 的唯一产生点；不做这一步，协议里那个码就是空口承诺。
 *
 * 删除只做**整会话**粒度，不做单事件删除：留下半截会话比不删更糟（平台会以为那是完整历史）。
 */

import { posFlag, strFlag, type Flags } from '../cli/flags.js';
import { C, out } from '../cli/render.js';
import { DEFAULT_TENANT, SessionStore } from '../core/session-store.js';
import { stateDbPath } from '../infra/config.js';
import { writeAudit } from '../infra/audit.js';

/** `--older-than=<days>` → 截止时间戳；非法或未给返回 undefined */
function cutoffFromDays(days: string | undefined): number | undefined {
  if (days === undefined || days.trim() === '') return undefined;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Date.now() - Math.floor(n) * 86_400_000;
}

export function cmdSessions(flags: Flags): void {
  const sub = posFlag(flags, 1) || 'list';
  const tenantId = strFlag(flags, 'tenant') ?? DEFAULT_TENANT;

  let store: SessionStore | undefined;
  const open = (): SessionStore => {
    store = new SessionStore(stateDbPath());
    return store;
  };

  try {
    if (sub === 'list') {
      const sessions = open().listSessions(tenantId);
      if (!sessions.length) {
        out.info('状态库里还没有会话。');
        return;
      }
      console.log(
        C.bold('\nSESSION                  AGENT             MODE           STATUS     事件区间   更新于'),
      );
      console.log(C.dim('─'.repeat(104)));
      for (const session of sessions) {
        const window = store!.eventWindow(session.sessionId);
        const seqs = window.latest === undefined ? '-' : `${window.oldest ?? 0}..${window.latest}`;
        console.log(
          `${session.sessionId.padEnd(25)}${session.agentType.padEnd(18)}` +
            `${session.mode.padEnd(15)}${session.status.padEnd(12)}${seqs.padEnd(11)}${session.updatedAt}`,
        );
      }
      console.log('');
      out.info(
        `共 ${sessions.length} 个会话。清理：agent-bridge sessions purge --session=<id>（或 --older-than=<天>）`,
      );
      return;
    }

    if (sub === 'purge') {
      const single = strFlag(flags, 'session') ?? posFlag(flags, 2);
      const cutoff = cutoffFromDays(strFlag(flags, 'older-than'));
      if (!single && cutoff === undefined) {
        return out.fatal(
          '用法：agent-bridge sessions purge --session=<taskId> | --older-than=<天>\n' +
            '      只删已终结的会话（running 的会被跳过）；tombstone 会保留，平台随后拿到 session_deleted。',
        );
      }
      const db = open();
      const targets = single
        ? db
            .listSessions(tenantId)
            .filter((session) => session.sessionId === single)
        : db.listSessions(tenantId).filter((session) => {
            const at = Date.parse(session.updatedAt);
            return Number.isFinite(at) && at <= cutoff!;
          });
      if (!targets.length) {
        out.info(single ? `未找到会话：${single}` : '没有满足条件的会话。');
        return;
      }

      let deleted = 0;
      let skipped = 0;
      for (const session of targets) {
        const result = db.deleteSession(session.sessionId, { tenantId, reason: 'cli_purge' });
        if (!result.deleted) {
          skipped += 1;
          if (result.reason === 'session_running') {
            out.error(`跳过 ${session.sessionId}：会话仍在 running（删掉等于让平台永远等不到终态）`);
          }
          continue;
        }
        deleted += 1;
        writeAudit({
          at: new Date().toISOString(),
          action: 'session_purge',
          outcome: 'allowed',
          taskId: session.sessionId,
          reason: `events=${result.events} turns=${result.turns}`,
        });
      }
      if (!deleted) {
        out.error('没有会话被删除。');
        process.exit(1);
      }
      out.ok(`✅ 已删除 ${deleted} 个会话${skipped ? `（跳过 ${skipped} 个）` : ''}`);
      out.info('tombstone 已保留：平台对这些 taskId 会收到 session_deleted（410），不应重试。');
      return;
    }

    return out.fatal(`未知子命令：sessions ${sub}\n可用：list / purge`);
  } finally {
    store?.close();
  }
}

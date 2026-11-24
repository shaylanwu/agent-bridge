/**
 * 迁移必须能**补齐后加的表**，不能被 `user_version` 门挡住。
 *
 * 2026-10-29 的真实故障（现场：平台「已下发，等待第一条输出」，本机面板「暂无任务」）：
 * `event_prunes` 是后来追加进建表 DDL 的，但老库的 `user_version` 已经等于 `SCHEMA_VERSION`，
 * `migrate()` 直接 return，表永远建不出来；而 `appendEvent()` 无条件读它，
 * 于是**每条事件写入都抛 `no such table`**。异常打断的位置恰好在
 * `registry.register()` 之前，任务连终端面板都进不去，看上去像"平台没下发"。
 *
 * 这条用例钉的正是那个形态：版本号已是最新、但表缺失 —— 打开后必须自愈。
 */

import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/session-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 下句柄释放可能滞后；临时目录可留给系统清理 */
    }
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-migrate-'));
  dirs.push(dir);
  return dir;
}

describe('migrate 自愈', () => {
  it('user_version 已是最新但缺 event_prunes 时，重新打开即可写入事件', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.db');

    const first = new SessionStore(dbPath);
    first.createSession({ sessionId: 'bt_missing_table', mode: 'conversation', agentType: 'claude-code', cwd: dir });
    first.appendEvent({ sessionId: 'bt_missing_table', type: 'task_status', payload: { status: 'running' } });
    first.close();

    // 复刻现场：表被漏建，版本号却已经写死在最新
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE event_prunes');
    const versionAfterDrop = Number(raw.pragma('user_version', { simple: true }));
    expect(versionAfterDrop).toBeGreaterThan(0);
    raw.close();

    const reopened = new SessionStore(dbPath);
    // 关键断言：不能抛 no such table,恢复到「能写事件」
    expect(() =>
      reopened.appendEvent({ sessionId: 'bt_missing_table', type: 'task_log', payload: { chunk: 'hi' } }),
    ).not.toThrow();
    expect(reopened.getPrunedThrough('bt_missing_table')).toBe(0);
    reopened.close();
  });

  it('重复打开不会重复建表报错，事件序号继续递增', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'state.db');

    const first = new SessionStore(dbPath);
    first.createSession({ sessionId: 'bt_again', mode: 'conversation', agentType: 'claude-code', cwd: dir });
    const seq1 = first.appendEvent({ sessionId: 'bt_again', type: 'task_status', payload: { n: 1 } }).eventSeq;
    first.close();

    const second = new SessionStore(dbPath);
    const seq2 = second.appendEvent({ sessionId: 'bt_again', type: 'task_status', payload: { n: 2 } }).eventSeq;
    second.close();

    expect(seq2).toBe(seq1 + 1);
  });
});

/**
 * 打开时的完整性自检（spec 9.1「Storage 接口 + migration + 完整性自检」）。
 *
 * 为什么值得单独钉住：损坏的 SQLite 文件通常**能正常 open**，schema 也读得出来，
 * 只是跑到一半读页失败。实测（22 MB 库）：不带自检 open 成功、读取也正常，
 * 带自检才在启动时把它拒掉。没有这条，故障现场是「任务跑到一半报内部错误」，
 * 排查成本远高于启动时报一句「完整性自检失败」。
 *
 * 口径要精确：quick_check 抓的是**结构**损坏（页头、b-tree、索引），
 * 正文里被改掉的字节它不校验 —— 别把它说成"能发现任何损坏"。
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-integrity-'));
  dirs.push(dir);
  return dir;
}

/** 造一个有真实数据页的库并正常关闭（WAL 已 checkpoint，单文件可读） */
function buildDb(dir: string): string {
  const dbPath = join(dir, 'state.db');
  const store = new SessionStore(dbPath);
  store.createSession({ sessionId: 's1', mode: 'task', agentType: 'codex', cwd: dir });
  const payload = 'x'.repeat(4000);
  for (let i = 0; i < 200; i += 1) {
    store.appendEvent({ sessionId: 's1', type: 'task_log', payload: { data: payload } });
  }
  store.close();
  return dbPath;
}

function pageSizeOf(dbPath: string): number {
  const raw = readFileSync(dbPath).subarray(16, 18).readUInt16BE(0);
  return raw === 1 ? 65536 : raw;
}

/** 把某页的页头打烂：SQLite 认为这页还在用，但结构已经不成立 */
function trashPageHeader(dbPath: string, pageIndex: number): void {
  const fd = openSync(dbPath, 'r+');
  writeSync(fd, Buffer.alloc(16, 0xff), 0, 16, pageSizeOf(dbPath) * pageIndex);
  closeSync(fd);
}

describe('SessionStore 完整性自检', () => {
  it('正常库：打开成功，checkIntegrity 报 ok', () => {
    const dir = tempDir();
    const store = new SessionStore(join(dir, 'state.db'));
    expect(store.checkIntegrity()).toEqual({ ok: true });
    store.close();
  });

  it('页头损坏的库：不带自检能打开，带自检在构造时就拒（这才是自检的价值）', () => {
    const dir = tempDir();
    const dbPath = buildDb(dir);
    trashPageHeader(dbPath, 2);

    // 证明这确实是「能 open 的损坏」：关掉自检就能构造成功
    const lenient = new SessionStore(dbPath, { integrityCheck: false });
    expect(lenient.checkIntegrity().ok).toBe(false);
    lenient.close();

    expect(() => new SessionStore(dbPath)).toThrow(/完整性自检失败/);
  });

  it('integrityCheck: false 可显式跳过（超大库 / 只读校验场景）', () => {
    const dir = tempDir();
    const dbPath = buildDb(dir);
    trashPageHeader(dbPath, 2);
    const store = new SessionStore(dbPath, { integrityCheck: false });
    // 跳过的是「启动时拒绝」，不是「把损坏藏起来」：按需自检照样能查出来
    expect(store.checkIntegrity()).toMatchObject({ ok: false });
    store.close();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, SessionStoreError } from '../src/core/session-store.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function makeStore(options: { retentionMaxEvents?: number } = {}): SessionStore {
  const store = new SessionStore(':memory:', options);
  cleanups.push(() => store.close());
  return store;
}

function seed(store: SessionStore, sessionId = 'sess_retention', status: 'running' | 'success' = 'success') {
  store.createSession({
    sessionId,
    mode: 'task',
    agentType: 'claude-code',
    cwd: process.cwd(),
    status,
    phase: status === 'running' ? 'running' : 'settled',
  });
  return sessionId;
}

function appendMany(store: SessionStore, sessionId: string, count: number, start = 0): number[] {
  const seqs: number[] = [];
  for (let i = start; i < start + count; i += 1) {
    seqs.push(store.appendEvent({ sessionId, type: 'task_log', payload: { i } }).eventSeq);
  }
  return seqs;
}

describe('事件保留阈值（retention）', () => {
  it('按条数裁剪最旧事件，并把水位记进 event_prunes', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 200);

    expect(store.getPrunedThrough(id)).toBe(0);
    const result = store.pruneEvents(id, { maxEvents: 50 });

    // 剩 50 条 → 裁掉 1..150，水位 = 150
    expect(result.removed).toBe(150);
    expect(result.prunedThrough).toBe(150);
    expect(store.getPrunedThrough(id)).toBe(150);
    expect(store.listEvents(id, { limit: 1000 })).toHaveLength(50);
    expect(store.listEvents(id, { limit: 1000 })[0]?.eventSeq).toBe(151);
  });

  it('未超上限时不裁剪、不写水位', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 10);
    const result = store.pruneEvents(id, { maxEvents: 50 });
    expect(result).toEqual({ removed: 0, prunedThrough: 0 });
    expect(store.getPrunedThrough(id)).toBe(0);
    expect(store.listEvents(id, { limit: 1000 })).toHaveLength(10);
  });

  it('maxEvents = 0 是合法的「永久保留」，不是「删光」', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 20);
    expect(store.pruneEvents(id, { maxEvents: 0 })).toEqual({ removed: 0, prunedThrough: 0 });
    expect(store.listEvents(id, { limit: 1000 })).toHaveLength(20);
  });

  it('裁剪后 eventSeq 不会从 1 重新发号（水位是发号下界）', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 20);
    store.pruneEvents(id, { maxEvents: 5 });

    const next = store.appendEvent({ sessionId: id, type: 'task_log', payload: { after: true } });
    // 水位 15，最后一条是 20 —— 新号必须是 21，不能撞回被裁掉的 1..15
    expect(next.eventSeq).toBe(21);
    expect(store.getPrunedThrough(id)).toBe(15);
  });

  it('事件被裁光后仍从水位继续发号（MAX 退回 0 的坑）', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 4);
    // 保留 1 条 → 裁掉 1..3
    expect(store.pruneEvents(id, { maxEvents: 1 }).prunedThrough).toBe(3);
    const next = store.appendEvent({ sessionId: id, type: 'task_log', payload: { seq: 'x' } });
    expect(next.eventSeq).toBe(5);
  });

  it('构造函数配了阈值就惰性裁剪，不用手动调用', () => {
    const store = makeStore({ retentionMaxEvents: 50 });
    const id = seed(store);
    appendMany(store, id, 200);
    // 第 100 与第 200 条写入时各触发一次（eventSeq % 100 === 0）
    expect(store.getPrunedThrough(id)).toBe(150);
    expect(store.listEvents(id, { limit: 1000 })).toHaveLength(50);
  });

  it('裁剪后仍能判断缺口：eventGaps 看到 151 之前全没了', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 200);
    store.pruneEvents(id, { maxEvents: 50 });
    // 窗口内是连续的 151..200，没有洞；但 1..150 已不在库里
    expect(store.eventGaps(id)).toEqual([]);
    expect(store.eventWindow(id).oldest).toBe(151);
  });

  it('裁剪只删事件，不动 turns / artifacts 这些「发生过」的证据', () => {
    const store = makeStore();
    const id = seed(store);
    const turn = store.createTurn({ sessionId: id });
    store.putArtifact({
      artifactId: 'art_keep',
      sessionId: id,
      tenantId: 'default',
      name: 'out.txt',
      mimeType: 'text/plain',
      size: 3,
      sha256: 'a'.repeat(64),
      kind: 'file',
      storageKey: 'k',
    });
    appendMany(store, id, 60);
    store.pruneEvents(id, { maxEvents: 10 });

    expect(store.listEvents(id, { limit: 1000 })).toHaveLength(10);
    expect(store.getTurn(id, turn.turnId)).toBeDefined();
    expect(store.listArtifacts(id)).toHaveLength(1);
  });
});

describe('before 游标（回翻）', () => {
  it('返回升序，且最大值严格小于 before', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 30);

    const page = store.listEvents(id, { beforeEventSeq: 21, limit: 5 });
    expect(page.map((event) => event.eventSeq)).toEqual([16, 17, 18, 19, 20]);
  });

  it('连续回翻能翻到最早一条且不重不漏', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 12);

    const seen: number[] = [];
    let cursor: number | undefined = 13;
    for (let guard = 0; guard < 10 && cursor !== undefined; guard += 1) {
      const page = store.listEvents(id, { beforeEventSeq: cursor, limit: 5 });
      if (!page.length) break;
      seen.unshift(...page.map((event) => event.eventSeq));
      cursor = page[0]?.eventSeq;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('snapshot 的 hasMoreBefore：窗口起点之前还有内容才为 true', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 30);

    const recent = store.snapshot(id, { limit: 10 });
    expect(recent.events).toHaveLength(10);
    expect(recent.events[0]?.eventSeq).toBe(21);
    expect(recent.hasMoreBefore).toBe(true);

    const fromStart = store.snapshot(id, { afterEventSeq: 0, limit: 10 });
    expect(fromStart.events[0]?.eventSeq).toBe(1);
    expect(fromStart.hasMoreBefore).toBe(false);

    const whole = store.snapshot(id, { limit: 200 });
    expect(whole.hasMoreBefore).toBe(false);
  });

  it('回翻跨过裁剪水位：events 为空但 prunedThrough 标出真实起点', () => {
    const store = makeStore();
    const id = seed(store);
    appendMany(store, id, 100);
    store.pruneEvents(id, { maxEvents: 10 });

    const snapshot = store.snapshot(id, { beforeEventSeq: 90, limit: 10 });
    expect(snapshot.events).toEqual([]);
    expect(snapshot.prunedThrough).toBe(90);
  });
});

describe('会话删除（session_deleted 的唯一产生点）', () => {
  it('running 的会话拒删 —— 删了平台永远等不到终态', () => {
    const store = makeStore();
    const id = seed(store, 'sess_running', 'running');
    const result = store.deleteSession(id);
    expect(result).toMatchObject({ deleted: false, reason: 'session_running' });
    expect(store.getSession(id)).toBeDefined();
  });

  it('删除会话会带走全部子记录，但保留 tombstone', () => {
    const store = makeStore();
    const id = seed(store);
    store.createTurn({ sessionId: id });
    appendMany(store, id, 5);
    store.putArtifact({
      artifactId: 'art_gone',
      sessionId: id,
      tenantId: 'default',
      name: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'b'.repeat(64),
      kind: 'file',
      storageKey: 'k2',
    });
    store.saveTransfer({
      transferId: 'tr_gone',
      sessionId: id,
      operationId: 'op_gone',
      artifactId: 'art_gone',
      direction: 'upload',
      name: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'b'.repeat(64),
      chunkSize: 4,
      nextOffset: 0,
      state: 'committed',
      tenantId: 'local',
    });

    const result = store.deleteSession(id);
    expect(result).toMatchObject({ deleted: true, events: 5, turns: 1 });
    expect(store.getSession(id)).toBeUndefined();
    expect(store.listEvents(id, { limit: 1000 })).toEqual([]);
    expect(store.listTurns(id)).toEqual([]);
    expect(store.listArtifacts(id)).toEqual([]);
    // artifact_transfers 没有外键，必须由 deleteSession 显式清掉，否则留孤儿行
    expect(store.getTransfer('tr_gone')).toBeUndefined();
    // tombstone 是「存在过、没了、永不复用」的唯一依据
    expect(store.getTombstone(id)).toBeDefined();
    expect(store.getTombstone(id)?.reason).toBe('deleted');
  });

  it('删除后同一个 id 不能重新创建（tombstone 挡住）', () => {
    const store = makeStore();
    const id = seed(store);
    store.deleteSession(id);
    expect(() =>
      store.createSession({
        sessionId: id,
        mode: 'task',
        agentType: 'claude-code',
        cwd: process.cwd(),
      }),
    ).toThrowError(SessionStoreError);
    try {
      store.createSession({ sessionId: id, mode: 'task', agentType: 'claude-code', cwd: process.cwd() });
    } catch (error) {
      expect((error as SessionStoreError).code).toBe('session_deleted');
    }
  });

  it('不存在的会话删了也不报错，reason 说明是 not_found', () => {
    const store = makeStore();
    expect(store.deleteSession('never_existed')).toMatchObject({ deleted: false, reason: 'not_found' });
  });

  it('close_session 之后仍然可读，delete 之后才不可读', () => {
    const store = makeStore();
    const id = seed(store, 'sess_close_then_delete', 'running');
    store.closeSession(id, 'success', 'done');
    expect(store.getSession(id)?.status).toBe('success');
    expect(store.snapshot(id).session.status).toBe('success');

    store.deleteSession(id);
    expect(store.getSession(id)).toBeUndefined();
  });

  it('删除一个会话不影响另一个会话的事件与水位', () => {
    const store = makeStore();
    const a = seed(store, 'sess_a');
    const b = seed(store, 'sess_b');
    appendMany(store, a, 20);
    appendMany(store, b, 20);
    store.pruneEvents(a, { maxEvents: 5 });

    store.deleteSession(a);
    expect(store.listEvents(b, { limit: 1000 })).toHaveLength(20);
    expect(store.getPrunedThrough(a)).toBe(0);
    expect(store.getPrunedThrough(b)).toBe(0);
  });
});

describe('on-disk 状态库', () => {
  it('落盘库同样执行保留阈值（不是只在内存里生效）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-retention-'));
    const dbPath = join(dir, 'state.db');
    try {
      const store = new SessionStore(dbPath, { retentionMaxEvents: 20 });
      const id = seed(store);
      appendMany(store, id, 100);
      expect(store.getPrunedThrough(id)).toBe(80);
      store.close();

      const reopened = new SessionStore(dbPath, { retentionMaxEvents: 20 });
      expect(reopened.getPrunedThrough(id)).toBe(80);
      expect(reopened.listEvents(id, { limit: 1000 })).toHaveLength(20);
      reopened.close();
    } finally {
      // Windows 上句柄未全关时 rmSync 会 EPERM：先确保上面两段都 close 过再删
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

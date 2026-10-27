import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import { dispatchGetTask, type TaskDispatchOptions } from '../src/app/task-dispatch.js';
import { PartialMessageTracker } from '../src/core/partial-messages.js';
import type { ClientMessage } from '../src/protocol.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

interface Harness {
  store: SessionStore;
  options: TaskDispatchOptions;
  sent: ClientMessage[];
}

function harness(extra: Partial<TaskDispatchOptions> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-snapshot-'));
  const store = new SessionStore(join(dir, 'state.db'));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const sent: ClientMessage[] = [];
  const options: TaskDispatchOptions = {
    emitter: new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) }),
    tasks: new Map(),
    registry: new TaskRegistry(),
    maxConcurrent: 2,
    maxQueued: 2,
    diffMaxBytes: 4096,
    captureDiffByDefault: false,
    requireServiceToken: false,
    store,
    log: () => undefined,
    ...extra,
  };
  return { store, options, sent };
}

function seedSession(store: SessionStore, sessionId: string, events = 0): string {
  store.createSession({
    sessionId,
    mode: 'task',
    agentType: 'claude-code',
    cwd: process.cwd(),
    status: 'success',
    phase: 'settled',
  });
  for (let i = 1; i <= events; i += 1) {
    store.appendEvent({ sessionId, type: 'task_log', payload: { i } });
  }
  return sessionId;
}

function lastSnapshot(sent: ClientMessage[]) {
  const msg = [...sent].reverse().find((item) => item.type === 'task_snapshot');
  if (msg?.type !== 'task_snapshot') throw new Error('没有发出 task_snapshot');
  return msg;
}

describe('get_task 游标组合', () => {
  it('afterEventSeq 与 beforeEventSeq 同时给：明确拒绝，而不是猜一个', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_both', 10);
    dispatchGetTask(
      { type: 'get_task', taskId: id, requestId: 'r1', afterEventSeq: 2, beforeEventSeq: 8 },
      options,
    );
    expect(lastSnapshot(sent)).toMatchObject({
      found: false,
      errorCode: 'protocol_incompatible',
    });
  });

  it('afterEventSeq 只回游标之后的事件（补洞路径，升序）', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_after', 10);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r2', afterEventSeq: 7 }, options);
    expect(lastSnapshot(sent).events?.map((event) => event.eventSeq)).toEqual([8, 9, 10]);
  });

  it('beforeEventSeq 回翻历史（输出仍升序，最大值小于游标）', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_before', 10);
    dispatchGetTask(
      { type: 'get_task', taskId: id, requestId: 'r3', beforeEventSeq: 6, limit: 3 },
      options,
    );
    expect(lastSnapshot(sent).events?.map((event) => event.eventSeq)).toEqual([3, 4, 5]);
  });

  it('无游标时给的是「现在」：最新一页 + hasMoreBefore 标出更早还有内容', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_tail', 30);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r4', limit: 10 }, options);
    const snapshot = lastSnapshot(sent);
    expect(snapshot.events?.map((event) => event.eventSeq)).toEqual([
      21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    ]);
    expect(snapshot.hasMoreBefore).toBe(true);
    expect(snapshot.latestEventSeq).toBe(30);
  });

  it('从头发起（afterEventSeq: 0）时 hasMoreBefore 为 false', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_head', 30);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r5', afterEventSeq: 0, limit: 10 }, options);
    const snapshot = lastSnapshot(sent);
    expect(snapshot.events?.[0]?.eventSeq).toBe(1);
    expect(snapshot.hasMoreBefore).toBe(false);
  });
});

describe('get_task 的三个 not-found 语义', () => {
  it('从未存在的 taskId 回 task_not_found（404 语义，可放弃）', () => {
    const { options, sent } = harness();
    dispatchGetTask({ type: 'get_task', taskId: 'never_existed', requestId: 'r6' }, options);
    expect(lastSnapshot(sent)).toMatchObject({ found: false, errorCode: 'task_not_found' });
  });

  it('已删除的会话回 session_deleted（410 语义，不要重试）', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_deleted', 5);
    expect(store.deleteSession(id).deleted).toBe(true);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r7' }, options);
    expect(lastSnapshot(sent)).toMatchObject({ found: false, errorCode: 'session_deleted' });
  });

  it('close_session 之后仍可读快照 —— 「关了」不等于「没了」', () => {
    const { store, options, sent } = harness();
    store.createSession({
      sessionId: 'sess_closed',
      mode: 'task',
      agentType: 'claude-code',
      cwd: process.cwd(),
      status: 'running',
      phase: 'running',
    });
    store.appendEvent({ sessionId: 'sess_closed', type: 'task_log', payload: { i: 1 } });
    store.closeSession('sess_closed', 'success', 'done');
    dispatchGetTask({ type: 'get_task', taskId: 'sess_closed', requestId: 'r8' }, options);
    const snapshot = lastSnapshot(sent);
    expect(snapshot.found).toBe(true);
    expect(snapshot.errorCode).toBeUndefined();
    expect(snapshot.session).toMatchObject({ status: 'success' });
  });

  it('游标落在已裁剪区间：found 仍为 true，但带 session_history_pruned 与 prunedThrough', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_pruned', 100);
    store.pruneEvents(id, { maxEvents: 10 });

    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r9', afterEventSeq: 5 }, options);
    const snapshot = lastSnapshot(sent);
    expect(snapshot.found).toBe(true);
    expect(snapshot.errorCode).toBe('session_history_pruned');
    expect(snapshot.prunedThrough).toBe(90);
    // 已裁剪区间的补取只能拿到还在库里的那部分
    expect(snapshot.events?.[0]?.eventSeq).toBe(91);
  });

  it('游标正好在水位上不算裁剪（边界，> prunedThrough 的内容都还在）', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_boundary', 100);
    store.pruneEvents(id, { maxEvents: 10 });

    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r10', afterEventSeq: 90 }, options);
    const snapshot = lastSnapshot(sent);
    expect(snapshot.errorCode).toBeUndefined();
    expect(snapshot.events?.map((event) => event.eventSeq)).toEqual([
      91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
    ]);
  });

  it('未裁剪的会话不带 prunedThrough 字段（不留无意义的 0）', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_noprune', 5);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r11', afterEventSeq: 0 }, options);
    expect(lastSnapshot(sent).prunedThrough).toBeUndefined();
  });
});

describe('快照里的半截消息（partialMessages）', () => {
  it('没接累积器时不带该字段 —— 不假装「接了但没有文本」', () => {
    const { store, options, sent } = harness();
    const id = seedSession(store, 'sess_pm_none', 3);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'pm1' }, options);
    expect(lastSnapshot(sent).partialMessages).toBeUndefined();
  });

  it('接了累积器但还没吐出文本：仍是空字段（空数组不占位）', () => {
    const { store, options, sent } = harness({ partialMessages: () => [] });
    const id = seedSession(store, 'sess_pm_empty', 3);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'pm2' }, options);
    expect(lastSnapshot(sent).partialMessages).toBeUndefined();
  });

  it('运行中给出已累积的半截文本（刷新后不至于白屏）', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('sess_pm_live', '我正在读配置，', { at: '2026-10-27T00:00:00.000Z' });
    tracker.append('sess_pm_live', '马上就好');
    const { store, options, sent } = harness({ partialMessages: (taskId) => tracker.list(taskId) });
    const id = seedSession(store, 'sess_pm_live', 3);

    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'pm3' }, options);
    const snapshot = lastSnapshot(sent);
    expect(snapshot.partialMessages).toHaveLength(1);
    expect(snapshot.partialMessages?.[0]).toMatchObject({
      messageId: 'pm_sess_pm_live',
      role: 'agent',
      text: '我正在读配置，马上就好',
    });
  });

  it('终态清空：清完之后快照不再带半截文本', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('sess_pm_settled', '半截');
    const { store, options, sent } = harness({ partialMessages: (taskId) => tracker.list(taskId) });
    const id = seedSession(store, 'sess_pm_settled', 3);
    store.closeSession(id, 'success', 'done');
    tracker.clear(id);

    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'pm4' }, options);
    expect(lastSnapshot(sent).partialMessages).toBeUndefined();
  });
});

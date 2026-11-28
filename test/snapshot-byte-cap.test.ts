import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import { dispatchGetTask, type TaskDispatchOptions } from '../src/app/task-dispatch.js';
import { SNAPSHOT_MAX_BYTES, capEventsByBytes } from '../src/core/snapshot-cap.js';
import type { ClientMessage } from '../src/protocol.js';

/**
 * 规格写着「单响应 1 MiB 是默认可配置安全策略」，但此前**没有任何地方执行**：
 * `get_task` 默认 limit 200，配上带日志的事件（一条几 KB 很常见），单帧就能到几 MB。
 *
 * 这里守住两件事：
 *  1. 真的截：帧字节数 ≤ 1 MiB；
 *  2. 截的方向对：保住**最新**的事件（平台要知道"现在什么状态"），用 `hasMoreBefore` 说"更早还有"。
 */
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function harness(): { store: SessionStore; options: TaskDispatchOptions; sent: ClientMessage[] } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-snapcap-'));
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
  };
  return { store, options, sent };
}

/** 每条事件 ~8 KiB（用带空格的文本，避免被长串脱敏折小后测不准） */
const BIG_TEXT = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(160);

function seed(store: SessionStore, sessionId: string, events: number, payload = { data: BIG_TEXT }): string {
  store.createSession({
    sessionId,
    mode: 'task',
    agentType: 'claude-code',
    cwd: process.cwd(),
    status: 'success',
    phase: 'settled',
  });
  for (let i = 1; i <= events; i += 1) {
    store.appendEvent({ sessionId, type: 'task_log', payload });
  }
  return sessionId;
}

function lastSnapshot(sent: ClientMessage[]) {
  const msg = [...sent].reverse().find((item) => item.type === 'task_snapshot');
  if (msg?.type !== 'task_snapshot') throw new Error('没有发出 task_snapshot');
  return msg;
}

describe('capEventsByBytes（纯函数）', () => {
  it('空列表 / 全部装得下：原样返回且不算截断', () => {
    expect(capEventsByBytes([], 100)).toEqual({ kept: [], truncated: false });
    const events = [{ a: 1 }, { b: 2 }];
    expect(capEventsByBytes(events, 1024)).toEqual({ kept: events, truncated: false });
  });

  it('装不下时从**最旧**开始丢，保留尾部（最新）', () => {
    const events = [{ v: 'a'.repeat(100) }, { v: 'b'.repeat(100) }, { v: 'c'.repeat(100) }];
    const { kept, truncated } = capEventsByBytes(events, 250);
    expect(truncated).toBe(true);
    expect(kept).toHaveLength(2);
    expect(kept.at(-1)).toBe(events[2]);
  });

  it('单条就超预算：仍然保留这一条（空 events 会误导成"没有任何事件"）', () => {
    const events = [{ v: 'x'.repeat(5000) }];
    expect(capEventsByBytes(events, 10)).toEqual({ kept: events, truncated: false });
  });
});

describe('get_task 的 1 MiB 单响应上限', () => {
  it('事件总量超限时按字节裁剪，保住最新事件并置 hasMoreBefore', () => {
    const { store, options, sent } = harness();
    // 200 条 × ~8 KiB ≈ 1.6 MiB，明显超过 1 MiB
    const id = seed(store, 'sess_big', 200);
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r_big' }, options);

    const snapshot = lastSnapshot(sent);
    expect(snapshot.found).toBe(true);
    const events = snapshot.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(200);

    // 帧字节数不超上限（留一点序列化余量）
    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);

    // 保住的是最新一段：最后一条就是库里最新的事件
    expect(events.at(-1)?.eventSeq).toBe(snapshot.latestEventSeq);
    // 更早还有货：平台按 hasMoreBefore + beforeEventSeq 继续翻
    expect(snapshot.hasMoreBefore).toBe(true);
  });

  /**
   * 「更早还有货」不能只是嘴上说说：hasMoreBefore=true 是给平台的**承诺**，
   * 承诺的兑付路径是 `beforeEventSeq` 回翻。这里把整条路径走完 ——
   * 裁掉的旧事件必须都能翻回来，且翻页要收敛（不能永远说"还有"）。
   *
   * 注意断言顺序：先钉住「第一页确实被裁了、并且说了还有更早」，
   * 否则一旦丢掉 `|| truncated`，第一页就把 200 条全塞进去、后面根本不会翻页，
   * 覆盖率断言照样满足 —— 测试会变成假绿。
   */
  it('按 hasMoreBefore 回翻能把裁掉的事件全部取回，且翻页收敛', () => {
    const { store, options, sent } = harness();
    const id = seed(store, 'sess_paging', 200);

    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r_page_1' }, options);
    const first = lastSnapshot(sent);
    const firstEvents = first.events ?? [];
    expect(firstEvents.length, '第一页没被字节上限裁掉，本用例失去意义').toBeLessThan(200);
    expect(first.hasMoreBefore, '裁掉了前面的事件却没置 hasMoreBefore，平台永远不会回翻').toBe(true);

    const seen = firstEvents.map((event) => event.eventSeq);
    let before = firstEvents[0]?.eventSeq as number;
    let pages = 1;
    for (;;) {
      pages += 1;
      expect(pages, '翻页不收敛：hasMoreBefore 一直为 true').toBeLessThanOrEqual(20);
      dispatchGetTask({ type: 'get_task', taskId: id, requestId: `r_page_${pages}`, beforeEventSeq: before }, options);
      const page = lastSnapshot(sent);
      const events = page.events ?? [];
      // 每一页都得守住上限，不是只有第一页
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
      for (const event of events) seen.push(event.eventSeq);
      // 除最旧那一页外，回翻的页同样可能被裁 —— 那就继续往前
      if (!page.hasMoreBefore) break;
      const oldest = events[0]?.eventSeq;
      expect(oldest, '说"还有更早"却给了空页 = 死循环').toBeDefined();
      // 游标必须真的向前推进，否则同一页会无限重放
      expect(oldest as number).toBeLessThan(before);
      before = oldest;
    }

    // 一次不少、一条不重：1..200 全覆盖
    expect(seen).toHaveLength(200);
    expect(new Set(seen).size).toBe(200);
    expect(Math.min(...seen)).toBe(1);
    expect(Math.max(...seen)).toBe(200);
  });

  it('总量在上限内：一条不少，hasMoreBefore 保持 false', () => {
    const { store, options, sent } = harness();
    const id = seed(store, 'sess_small', 5, { data: 'ok' });
    dispatchGetTask({ type: 'get_task', taskId: id, requestId: 'r_small' }, options);

    const snapshot = lastSnapshot(sent);
    expect(snapshot.events).toHaveLength(5);
    expect(snapshot.hasMoreBefore).toBe(false);
  });
});

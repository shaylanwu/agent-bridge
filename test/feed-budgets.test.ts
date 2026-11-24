import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/core/session-store.js';

/**
 * per-task 有界 canonical feed（tasks.md 2.9 / 3.9；spec「会话快照、预算与终态收尾」）：
 *
 *  200 messages / 200 steps / 50 artifacts、4 MiB 单任务、64 MiB 进程是**默认配置**而非
 *  产品硬上限 —— 这里用小预算验证机制本身：
 *   - 分类超限淘汰最旧同类事件；类型交错时产生**窗口内** gap（reason=count），
 *     前缀删除则推进 prunedThrough（get_task 的 session_history_pruned 语义）；
 *   - 字节预算（单任务 / 进程全局）从最旧事件删起，
 *     绝不淘汰各会话最新终态 task_status 与每会话最新一条事件（pending 交互在独立表）；
 *   - 0 / 未配置 = 该维不启用；完全不传 feedBudgets = 整套机制关闭。
 */
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放滞后 */
    }
  }
});

interface Budgets {
  maxMessages?: number;
  maxSteps?: number;
  maxArtifacts?: number;
  taskMaxBytes?: number;
  globalMaxBytes?: number;
}

function storeWith(budgets: Budgets, sessions: string[] = ['t1']): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-feed-'));
  dirs.push(dir);
  const store = new SessionStore(join(dir, 'state.db'), { feedBudgets: budgets });
  for (const sessionId of sessions) {
    store.createSession({ sessionId, mode: 'task', agentType: 'kimi-code', cwd: dir, phase: 'queued' });
  }
  return store;
}

describe('per-task 有界 canonical feed', () => {
  it('分类上限（类型交错）：淘汰最旧同类，窗口内 gap 带 reason=count，水位不前移', () => {
    const store = storeWith({ maxMessages: 3 });
    // 交错：step 在最前 —— 删 message 不会清空前缀，缺号落在窗口内
    store.appendEvent({ sessionId: 't1', type: 'task_step', payload: { seq: 0 } });
    for (let i = 0; i < 5; i += 1) {
      store.appendEvent({ sessionId: 't1', type: 'task_message', payload: { n: i } });
    }
    store.appendEvent({ sessionId: 't1', type: 'task_status', payload: { status: 'success' } });

    const messages = store.listEvents('t1').filter((e) => e.type === 'task_message');
    expect(messages.map((e) => (e.payload as { n: number }).n)).toEqual([2, 3, 4]);
    expect(store.getLatestEvent('t1', 'task_status')?.payload).toMatchObject({ status: 'success' });
    // seq 2..3（前两条 message）被淘汰，seq 1（step）保留 → 缺口在窗口内
    expect(store.eventGaps('t1')).toEqual([{ from: 2, to: 3, reason: 'count' }]);
    // 前缀（seq 1）未被删：水位不推进 —— 补洞方还能从 oldest 正常回翻
    expect(store.getPrunedThrough('t1')).toBe(0);
  });

  it('steps / artifacts 分类同机制（各自独立上限）', () => {
    const store = storeWith({ maxSteps: 2, maxArtifacts: 1 });
    store.appendEvent({ sessionId: 't1', type: 'task_message', payload: { anchor: true } });
    for (let i = 0; i < 4; i += 1) {
      store.appendEvent({ sessionId: 't1', type: 'task_step', payload: { seq: i } });
      store.appendEvent({ sessionId: 't1', type: 'task_artifact', payload: { artifactId: `a${i}` } });
    }
    const count = (type: string): number =>
      store.listEvents('t1').filter((e) => e.type === type).length;
    expect(count('task_step')).toBe(2);
    expect(count('task_artifact')).toBe(1);
    // 锚点 message（seq 1）保留：缺口全部落在窗口内且带原因
    const gaps = store.eventGaps('t1');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => g.reason === 'count')).toBe(true);
    expect(gaps.every((g) => g.from >= 2)).toBe(true);
  });

  it('单任务字节预算：从最旧删起，最新终态与最新一条事件保留，前缀水位推进', () => {
    const store = storeWith({ taskMaxBytes: 300 });
    const big = 'x'.repeat(180);
    for (let i = 0; i < 4; i += 1) {
      store.appendEvent({ sessionId: 't1', type: 'task_log', payload: { data: `${i}${big}` } });
    }
    store.appendEvent({ sessionId: 't1', type: 'task_status', payload: { status: 'failed', errorCode: 'agent_error' } });

    const events = store.listEvents('t1');
    // ~200B/条、预算 300B：只能留下最新一条 log + 终态
    expect(events.length).toBeLessThanOrEqual(2);
    expect(store.getLatestEvent('t1', 'task_status')?.payload).toMatchObject({ status: 'failed' });
    // 删除是前缀（每次删最旧）：水位推进而不是窗口内 gap
    expect(store.getPrunedThrough('t1')).toBeGreaterThanOrEqual(3);
    const seqs = events.map((e) => e.eventSeq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs.at(-1)).toBe(5);
  });

  it('进程全局字节预算：跨会话从最旧删起，每会话最新终态保留', () => {
    const store = storeWith({ globalMaxBytes: 420 }, ['t1', 't2']);
    const big = 'y'.repeat(150);
    for (let i = 0; i < 3; i += 1) {
      store.appendEvent({ sessionId: 't1', type: 'task_log', payload: { data: `${i}${big}` } });
    }
    for (let i = 0; i < 3; i += 1) {
      store.appendEvent({ sessionId: 't2', type: 'task_log', payload: { data: `${i}${big}` } });
    }
    store.appendEvent({ sessionId: 't1', type: 'task_status', payload: { status: 'success' } });
    // 生产路径是每 64 条惰性触发；这里显式收口（运维语义相同）
    store.enforceGlobalFeedBytes();

    const total = store.listEvents('t1').length + store.listEvents('t2').length;
    // 6 条各 ~170B ≈ 1KB，预算 420B：只允许留下少量最新事件
    expect(total).toBeLessThanOrEqual(3);
    expect(store.getLatestEvent('t1', 'task_status')?.payload).toMatchObject({ status: 'success' });
    // 全局淘汰删的是前缀：两侧水位推进（具体推到哪由删除量决定，只验证方向与保护）
    expect(store.getPrunedThrough('t1')).toBeGreaterThanOrEqual(1);
    expect(store.getPrunedThrough('t2')).toBeGreaterThanOrEqual(1);
  });

  it('删空前缀推进 prunedThrough：新事件序号永不与已删历史撞号', () => {
    const store = storeWith({ taskMaxBytes: 120 });
    const big = 'z'.repeat(150);
    store.appendEvent({ sessionId: 't1', type: 'task_log', payload: { data: big } });
    const seqA = store.appendEvent({ sessionId: 't1', type: 'task_log', payload: { data: big } }).eventSeq;
    expect(seqA).toBe(2);
    store.appendEvent({ sessionId: 't1', type: 'task_log', payload: { data: big } });
    store.appendEvent({ sessionId: 't1', type: 'task_log', payload: { data: big } });
    // 每条都超预算：只剩最新一条；水位 ≥3，后续发号 > 水位
    const floor = store.getPrunedThrough('t1');
    expect(floor).toBeGreaterThanOrEqual(3);
    const latest = store.listEvents('t1').at(-1);
    expect(latest?.eventSeq).toBe(4);
    expect(latest?.eventSeq).toBeGreaterThan(floor);
  });

  it('未启用（0 / 缺省）= 不淘汰：机制默认关闭，由部署配置显式开启', () => {
    const store = storeWith({ maxMessages: 0 });
    for (let i = 0; i < 10; i += 1) {
      store.appendEvent({ sessionId: 't1', type: 'task_message', payload: { n: i } });
    }
    expect(store.listEvents('t1')).toHaveLength(10);
    expect(store.eventGaps('t1')).toEqual([]);
    // 完全不传 feedBudgets 的旧用法不受影响
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-feed-plain-'));
    dirs.push(dir);
    const plain = new SessionStore(join(dir, 'state.db'));
    plain.createSession({ sessionId: 't1', mode: 'task', agentType: 'kimi-code', cwd: dir, phase: 'queued' });
    for (let i = 0; i < 10; i += 1) {
      plain.appendEvent({ sessionId: 't1', type: 'task_message', payload: { n: i } });
    }
    expect(plain.listEvents('t1')).toHaveLength(10);
    plain.close();
  });

  it('快照消费方：被淘汰的 message 不进 snapshot，gaps 带原因透传', () => {
    const store = storeWith({ maxMessages: 2 });
    store.appendEvent({ sessionId: 't1', type: 'task_step', payload: { seq: 0 } });
    for (let i = 0; i < 4; i += 1) {
      store.appendEvent({ sessionId: 't1', type: 'task_message', payload: { n: i } });
    }
    const snapshot = store.snapshot('t1');
    expect(snapshot.events.filter((e) => e.type === 'task_message')).toHaveLength(2);
    expect(store.eventGaps('t1')).toEqual([
      { from: 2, to: 3, reason: 'count' },
    ]);
  });
});

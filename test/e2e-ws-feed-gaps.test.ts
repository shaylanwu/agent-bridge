/**
 * WS 直连的**有界 feed 缺口语义**（`eventWindow.gaps` / `feed_gaps` / `prunedThrough`）
 *
 * 为什么单独一个文件：`test/feed-budgets.test.ts` 已经把 store 层的三层预算与 `reason`
 * 覆盖得很细，但它验的是**库**；平台真正看到的是 `get_task` 的那一帧。这里补齐
 * 「预算 → 淘汰 → 快照帧 → 平台如何判断缺口」的整条链，尤其是两个最容易搞混的分层：
 *
 *   1. **窗口内缺口**（分类条数淘汰，类型交错留下洞）：`eventWindow.gaps` 带
 *      `reason=count|task_bytes|global_bytes`，事件序号**水位不前移**；
 *   2. **前缀删除**（从最旧删起，整段前缀没了）：推进 `prunedThrough`，
 *      用 `session_history_pruned` 表达，**不进 gaps**。
 *
 * 再加一条硬保证：各会话最新终态 `task_status` 是保护行，条数淘汰**不得**删掉它 ——
 * 否则平台会「任务在跑但永远等不到结论」。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import { createSession, type BridgeSession } from '../src/app/session.js';

/**
 * 假 ACP CLI：
 *  - `STEPS:<n>`   → 连发 n 条 `tool_call`（各自 completed），产出 n 条 task_step 事件；
 *  - `BIGLOGS:<n>` → 连发 n 条 1 KB 日志（用带空格的多行文本，避免被长串脱敏折叠）；
 *  - 其余          → 直接 end_turn。
 */
const FAKE_ACP = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const SID = 'sess_feed_' + process.pid;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const chunk = (text) => send({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId: SID, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const bigLine = (i) => {
  const rows = [];
  for (let k = 0; k < 25; k += 1) rows.push('log ' + i + ' row ' + k + ' payload data here');
  return rows.join('\n') + '\n';
};
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'session/new') return send({ jsonrpc: '2.0', id: m.id, result: { sessionId: SID } });
  if (m.method === 'session/load') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/cancel') process.exit(0);
  if (m.method !== 'session/prompt') return;
  const p = m.params || {};
  const text = (p.prompt && (p.prompt.text || (p.prompt[0] && p.prompt[0].text))) || '';
  const s = String(text);
  if (s.includes('STEPS:')) {
    const n = Number(s.split('STEPS:')[1]) || 1;
    for (let i = 0; i < n; i += 1) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SID, update: {
        sessionUpdate: 'tool_call', toolCallId: 'call_' + i, status: 'completed',
        kind: 'execute', title: 'run step ' + i,
      }}});
    }
    chunk('STEPS_DONE');
    return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
  }
  if (s.includes('BIGLOGS:')) {
    const n = Number(s.split('BIGLOGS:')[1]) || 1;
    for (let i = 0; i < n; i += 1) chunk(bigLine(i));
    return send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
  }
  chunk('PLAIN_OK');
  send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } });
});
`;

const DEVICE_ID = `bd_${'b'.repeat(32)}`;

/**
 * 预算刻意配小：`maxSteps: 2` 让 5 条 step 触发**分类条目**淘汰；
 * `taskMaxBytes: 3000` 让 6 KB 日志触发**前缀删除**（推进 prunedThrough）。
 * 两个机制互不干扰：STEPS 用例的总字节远小于 3 KB。
 */
const FEED = { maxSteps: 2, maxMessages: 2, maxArtifacts: 2, taskMaxBytes: 3000 };

interface Frame {
  type: string;
  [key: string]: unknown;
}

let tmpRoot = '';
let platform: Server;
let wss: WebSocketServer;
let socket: WebSocket | undefined;
let session: BridgeSession | undefined;
let store: SessionStore;
const frames: Frame[] = [];
const logs: string[] = [];
const restoreDef: Array<() => void> = [];

async function waitForFrame(predicate: (frame: Frame) => boolean, what: string): Promise<Frame> {
  let hit: Frame | undefined;
  await vi.waitFor(
    () => {
      hit = frames.find(predicate);
      expect(
        hit,
        `15s 内没有收到${what}；最近 5 帧=${JSON.stringify(frames.slice(-5))}\n桥接日志=${JSON.stringify(logs.slice(-8))}`,
      ).toBeTruthy();
    },
    { timeout: 15_000, interval: 20 },
  );
  return hit!;
}

async function waitForFrameSince(from: number, predicate: (frame: Frame) => boolean, what: string): Promise<Frame> {
  let hit: Frame | undefined;
  await vi.waitFor(
    () => {
      hit = frames.slice(from).find(predicate);
      expect(hit, `15s 内没有收到${what}；最近 5 帧=${JSON.stringify(frames.slice(-5))}`).toBeTruthy();
    },
    { timeout: 15_000, interval: 20 },
  );
  return hit!;
}

function sendToBridge(msg: Record<string, unknown>): void {
  if (!socket) throw new Error('平台侧 WS 尚未连上');
  socket.send(JSON.stringify(msg));
}

async function ensureConnected(): Promise<void> {
  await waitForFrame((frame) => frame.type === 'agent_list', 'agent_list 帧（握手完成）');
}

function runTask(taskId: string, prompt: string): void {
  sendToBridge({
    type: 'run_task',
    taskId,
    agentType: 'codebuddy-cli',
    cwd: tmpRoot,
    args: [],
    prompt,
    allowInteractive: false,
  });
}

async function waitTerminal(taskId: string): Promise<Frame> {
  return waitForFrame(
    (frame) =>
      frame.type === 'task_status' &&
      frame['taskId'] === taskId &&
      ['success', 'failed', 'cancelled', 'timeout'].includes(String(frame['status'])),
    `${taskId} 的终态`,
  );
}

async function snapshotOf(taskId: string, requestId: string, extra: Record<string, unknown> = {}): Promise<Frame> {
  sendToBridge({ type: 'get_task', taskId, requestId, ...extra });
  return waitForFrame(
    (frame) => frame.type === 'task_snapshot' && frame['requestId'] === requestId,
    `${taskId} 的 task_snapshot`,
  );
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agent-bridge-ws-feed-'));
  const script = join(tmpRoot, 'fake-acp.cjs');
  writeFileSync(script, FAKE_ACP);

  const def = agentDefOf('codebuddy-cli');
  if (!def) throw new Error('codebuddy-cli 定义缺失');
  const beforeDef = { bin: def.bin, acp: def.acp };
  def.bin = 'node';
  (def as { acp?: unknown }).acp = {
    command: process.execPath,
    args: [script],
    label: 'fake-acp',
    sanitizeHostEnv: false,
  };
  restoreDef.push(() => {
    def.bin = beforeDef.bin;
    (def as { acp?: unknown }).acp = beforeDef.acp;
  });

  platform = createServer();
  wss = new WebSocketServer({ server: platform });
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      try {
        frames.push(JSON.parse(String(data)) as Frame);
      } catch {
        /* 非 JSON 帧不计入 */
      }
    });
  });
  await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve));
  const { port } = platform.address() as AddressInfo;

  store = new SessionStore(':memory:', { feedBudgets: FEED });
  session = createSession({
    platformUrl: `http://127.0.0.1:${port}`,
    deviceToken: 'fake-device-token',
    deviceId: DEVICE_ID,
    cliVersion: '0.0.0-test',
    hostname: 'test-host',
    maxConcurrent: 4,
    maxQueued: 4,
    diffMaxBytes: 1024,
    captureDiffByDefault: false,
    requireServiceToken: false,
    interactionEnabled: false,
    sessionIdleMs: 0,
    registry: new TaskRegistry(),
    store,
    artifactRootDir: join(tmpRoot, 'artifacts'),
    log: (level, line) => logs.push(`[${level}] ${line}`),
  });
}, 60_000);

afterAll(async () => {
  session?.close();
  for (const fn of restoreDef.splice(0)) fn();
  for (const client of wss?.clients ?? []) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => platform.close(() => resolve()));
  store?.close();
  try {
    rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch {
    /* Windows 句柄释放可能滞后 */
  }
});

interface SnapEvent {
  eventSeq: number;
  type: string;
  payload: Record<string, unknown>;
}

interface Gap {
  from: number;
  to: number;
  reason?: string;
}

function gapsOf(frame: Frame): Gap[] {
  const window = (frame['eventWindow'] ?? {}) as Record<string, unknown>;
  return (window['gaps'] ?? []) as Gap[];
}

function eventsOf(frame: Frame): SnapEvent[] {
  return (frame['events'] ?? []) as SnapEvent[];
}

describe('有界 feed：分类淘汰在快照里必须显式给缺口', () => {
  it('step 条数超限 → gaps 带 reason=count，且最新终态仍被保护', async () => {
    await ensureConnected();
    runTask('feed_steps_1', 'STEPS:5');
    const terminal = await waitTerminal('feed_steps_1');
    expect(terminal['status']).toBe('success');

    const snapshot = await snapshotOf('feed_steps_1', 'req_feed_steps');
    expect(snapshot['found']).toBe(true);

    const steps = eventsOf(snapshot).filter((event) => event.type === 'task_step');
    // maxSteps=2：只剩最新的两条
    expect(steps).toHaveLength(2);

    const gaps = gapsOf(snapshot);
    expect(gaps.length).toBeGreaterThan(0);
    // 窗口内的洞必须带淘汰原因，否则平台会以为「序号连续」而静默丢内容
    expect(new Set(gaps.map((gap) => gap.reason))).toEqual(new Set(['count']));

    // 保护行：终态 task_status 绝不能被条数淘汰删掉（结论比过程重要）
    const terminals = eventsOf(snapshot).filter(
      (event) => event.type === 'task_status' && event.payload['status'] === 'success',
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.payload['result']).toBe('STEPS_DONE');

    // 快照的 events 与 eventSeq 序列是**同一集合**（含 task_log）——
    // 否则「窗口内缺口」会指向平台永远取不到的内容，gaps 语义就不自洽了。
    // 这也印证 task_log 占用 eventSeq（规格旧文写的是「不占」）。
    const logEvent = eventsOf(snapshot).find((event) => event.type === 'task_log');
    expect(logEvent).toBeTruthy();
    expect(Number(logEvent?.eventSeq)).toBeGreaterThan(0);
  }, 60_000);

  it('断线重连不会「治好」缺口：同一任务两次快照的 gaps 完全一致', async () => {
    await ensureConnected();
    const before = await snapshotOf('feed_steps_1', 'req_feed_before_cut');
    const cut = frames.length;
    socket?.terminate();
    await waitForFrameSince(cut, (frame) => frame.type === 'hello', '重连后的 hello');

    const after = await snapshotOf('feed_steps_1', 'req_feed_after_cut');
    expect(gapsOf(after)).toEqual(gapsOf(before));
    expect(after['eventWindow']).toMatchObject({
      oldestEventSeq: (before['eventWindow'] as Record<string, unknown>)['oldestEventSeq'],
      latestEventSeq: (before['eventWindow'] as Record<string, unknown>)['latestEventSeq'],
    });
    // 缺口是**事实**，不会因为换了条连接就消失 —— 否则平台会拿连续窗口的假设去补洞
    expect(gapsOf(after).length).toBeGreaterThan(0);
  }, 60_000);
});

describe('有界 feed：前缀删除走 prunedThrough，不进 gaps', () => {
  it('单任务字节超限 → prunedThrough 前移、游标落在已删区间时报 session_history_pruned', async () => {
    await ensureConnected();
    // 6 条 ~1 KB 日志：超过 taskMaxBytes=3000，从最旧删起（前缀删除）
    runTask('feed_bytes_1', 'BIGLOGS:6');
    const terminal = await waitTerminal('feed_bytes_1');
    expect(terminal['status']).toBe('success');

    const snapshot = await snapshotOf('feed_bytes_1', 'req_feed_bytes');
    const prunedThrough = Number(snapshot['prunedThrough'] ?? 0);
    expect(prunedThrough).toBeGreaterThan(0);

    // 分层语义：前缀删除**不**产生窗口内缺口（那是 eventWindow.gaps 的活儿）
    expect(gapsOf(snapshot)).toEqual([]);

    // 游标落在已删前缀里：内容确实取不回来了，必须显式说，而不是回一个从中间开始的「连续窗口」
    const stale = await snapshotOf('feed_bytes_1', 'req_feed_bytes_stale', { afterEventSeq: 1 });
    expect(stale['found']).toBe(true); // 任务还在，只是历史被裁
    expect(stale['errorCode']).toBe('session_history_pruned');
    expect(Number(stale['prunedThrough'] ?? 0)).toBe(prunedThrough);
  }, 60_000);
});

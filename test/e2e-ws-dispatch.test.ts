/**
 * WS 直连的端到端（cancel / approve / artifact）
 *
 * 缺口背景：网关 e2e（`npm run e2e:gateway`）覆盖的是 A2A/ACP over HTTP；而**平台真实使用的
 * 主通道是 WebSocket**（`/api/bridge/ws`），此前只有单元级用例，没有「真 WebSocket 服务器
 * ↔ 真 createSession ↔ 真 SQLite ↔ 真子进程」的闭环。
 *
 * 这里补的就是这条链，但**不跑真 CLI**：agent 侧用一个假 ACP 子进程（写死的 .cjs），
 * 因为它要精确控制「何时发权限请求 / 何时挂住不动」，真 CLI 做不到稳定复现。
 * 平台侧是**真的** `ws` 服务器，桥接侧是**真的** `createSession`（含 emitter、store、supervisor）。
 *
 * 覆盖：
 *   1. hello 协商（能力清单 + 容量水位）
 *   2. approve：run_task(allowInteractive) → `task_interaction_request` 下行 →
 *      `task_interaction_response` 上行 → 假 CLI 收到 allow_once → end_turn → success + 结果文本
 *   3. cancel：挂住的回合 → `cancel_task` → cancelled（不是 failed，也不是干等超时）
 *   4. artifact：未知 id → found:false + artifact_not_found；已知 id → 读到 base64 内容
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import { createSession, type BridgeSession } from '../src/app/session.js';

/**
 * 假 ACP CLI：prompt 里带 HANG 就永不回应（喂给 cancel），否则发一次权限请求，
 * 收到 allow_once 就回一段文本并 end_turn。
 */
const FAKE_ACP = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const selectedOut = process.argv[2]; // 把「实际收到的选项」落盘：交付证据不能只看桥接日志

const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'session/new') return send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_fake' } });
  if (m.method === 'session/prompt') {
    promptId = m.id;
    if (JSON.stringify(m.params || {}).includes('HANG')) return; // 挂住：给 cancel_task 用
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: 'sess_fake',
      toolCall: { toolCallId: 'call_1', title: 'Run tests' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    }});
    return;
  }
  if (m.id === 900 && m.result) {
    const selected = (m.result && m.result.outcome && m.result.outcome.optionId) || null;
    if (selectedOut) fs.writeFileSync(selectedOut, String(selected));
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_fake', update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: selected === 'allow_once' ? 'APPROVED_OK' : 'DENIED' },
    }}});
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
    return;
  }
  if (m.method === 'session/cancel') process.exit(0);
});
`;

const DEVICE_ID = `bd_${'a'.repeat(32)}`;

interface Frame {
  type: string;
  [key: string]: unknown;
}

let tmpRoot = '';
let platform: Server;
let wss: WebSocketServer;
let socket: WebSocket | undefined;
let session: BridgeSession | undefined;
let selectedOptionFile = '';
let store: SessionStore;
const frames: Frame[] = [];
const logs: string[] = [];
const restoreDef: Array<() => void> = [];

/** 等某个下行帧出现（超时给带上下文的可读错误，而不是一句空断言） */
async function waitForFrame(predicate: (frame: Frame) => boolean, what: string): Promise<Frame> {
  let hit: Frame | undefined;
  await vi.waitFor(
    () => {
      hit = frames.find(predicate);
      expect(hit, `15s 内没有收到${what}；最近 5 帧=${JSON.stringify(frames.slice(-5))}\n桥接日志=${JSON.stringify(logs.slice(-8))}`).toBeTruthy();
    },
    { timeout: 15_000, interval: 20 },
  );
  return hit!;
}

function sendToBridge(msg: Record<string, unknown>): void {
  if (!socket) throw new Error('平台侧 WS 尚未连上');
  socket.send(JSON.stringify(msg));
}

/** 等桥接连上再发指令（单跑某个用例时 beforeAll 里的连接可能尚未建立） */
async function ensureConnected(): Promise<void> {
  await waitForFrame((frame) => frame.type === 'agent_list', 'agent_list 帧（握手完成）');
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'agent-bridge-ws-e2e-'));
  const artifactRoot = join(tmpRoot, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const script = join(tmpRoot, 'fake-acp.cjs');
  writeFileSync(script, FAKE_ACP);
  selectedOptionFile = join(tmpRoot, 'acp-selected.txt');

  // 假 ACP 通过 def.acp 注入（**通道真源是 def.acp**，不是 acpSpec——后者由 manifest 派生）：
  // 安装闸门用 def.bin，所以 bin 指到 PATH 上必然存在的 node。
  // 不设 authEnv：canRunAcp 会据此判定该通道可用（真 CodeBuddy 需要 CODEBUDDY_AUTH_TOKEN）。
  const def = agentDefOf('codebuddy-cli');
  if (!def) throw new Error('codebuddy-cli 定义缺失');
  const beforeDef = { bin: def.bin, acp: def.acp };
  def.bin = 'node';
  (def as { acp?: unknown }).acp = {
    command: process.execPath,
    args: [script, selectedOptionFile],
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

  store = new SessionStore(':memory:');
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
    interactionEnabled: true,
    sessionIdleMs: 0,
    registry: new TaskRegistry(),
    store,
    artifactRootDir: artifactRoot,
    // 桥接侧日志接出来：失败断言要能看见「为什么没上行」，而不是只看到空数组
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
    /* Windows 句柄释放可能滞后；临时目录留给系统清理 */
  }
});

describe('WS 直连：hello 与能力协商', () => {
  it('握手即上报协议版本、能力清单与容量水位', async () => {
    const hello = await waitForFrame((frame) => frame.type === 'hello', 'hello 帧');
    expect(hello).toMatchObject({
      protocolVersion: 1,
      deviceId: DEVICE_ID,
      platform: process.platform,
      hostname: 'test-host',
      capacity: { maxTasks: 4, maxQueued: 4 },
    });
    expect(Array.isArray(hello['capabilities'])).toBe(true);
    expect((hello['capabilities'] as string[]).length).toBeGreaterThan(10);
  });
});

describe('WS 直连：approve（权限请求 → 响应 → 回合继续）', () => {
  it('task_interaction_request 下行、响应上行后 CLI 收到 allow_once 并 end_turn', async () => {
    await ensureConnected();
    sendToBridge({
      type: 'run_task',
      taskId: 'ws_approve_1',
      agentType: 'codebuddy-cli',
      cwd: tmpRoot,
      args: [],
      prompt: 'please run the tests',
      allowInteractive: true,
    });

    const request = await waitForFrame(
      (frame) => frame.type === 'task_interaction_request' && frame['taskId'] === 'ws_approve_1',
      '权限请求帧',
    );
    expect(request['kind']).toBe('permission');
    const options = ((request['payload'] as Record<string, unknown> | undefined)?.['options'] ??
      []) as Array<Record<string, unknown>>;
    expect(options.map((option) => option['optionId'])).toContain('allow_once');

    sendToBridge({
      type: 'task_interaction_response',
      taskId: 'ws_approve_1',
      requestId: request['requestId'],
      responseId: 'resp_1',
      state: 'accepted',
      payload: { optionId: 'allow_once' },
      respondedBy: 'tester',
    });

    const finalStatus = await waitForFrame(
      (frame) =>
        frame.type === 'task_status' &&
        frame['taskId'] === 'ws_approve_1' &&
        (frame['status'] === 'success' || frame['status'] === 'failed'),
      '任务终态',
    );
    expect(finalStatus['status']).toBe('success');
    // 交付证据看子进程落盘（它只在真收到响应时才写），不看桥接自己的日志
    expect(readFileSync(selectedOptionFile, 'utf8')).toBe('allow_once');
  }, 30_000);
});

describe('WS 直连：cancel', () => {
  it('cancel_task 让挂住的回合以 cancelled 结算（不是 failed / 不是干等超时）', async () => {
    await ensureConnected();
    sendToBridge({
      type: 'run_task',
      taskId: 'ws_cancel_1',
      agentType: 'codebuddy-cli',
      cwd: tmpRoot,
      args: [],
      prompt: 'HANG please',
      allowInteractive: false,
    });

    await waitForFrame(
      (frame) =>
        frame.type === 'task_status' && frame['taskId'] === 'ws_cancel_1' && frame['status'] === 'running',
      '任务进入 running',
    );

    sendToBridge({ type: 'cancel_task', taskId: 'ws_cancel_1' });

    const finalStatus = await waitForFrame(
      (frame) =>
        frame.type === 'task_status' &&
        frame['taskId'] === 'ws_cancel_1' &&
        ['cancelled', 'failed', 'success'].includes(String(frame['status'])),
      '取消后的终态',
    );
    expect(finalStatus['status']).toBe('cancelled');
    expect(finalStatus['errorCode']).toBe('cancelled');
  }, 30_000);
});

describe('WS 直连：artifact', () => {
  it('未知 artifactId 回 found:false + artifact_not_found（不报「任务不存在」）', async () => {
    await ensureConnected();
    // 先 ping 一次：确认这条上行通道仍然活着（否则「没有响应」会被误判成 artifact 逻辑坏了）
    sendToBridge({ type: 'ping' });
    await waitForFrame((frame) => frame.type === 'pong', 'pong 帧');
    sendToBridge({
      type: 'get_artifact',
      taskId: 'ws_cancel_1',
      artifactId: 'art_missing',
      requestId: 'req_missing',
    });

    const frame = await waitForFrame(
      (reply) => reply.type === 'artifact_content' && reply['requestId'] === 'req_missing',
      'artifact_content 帧',
    );
    expect(frame).toMatchObject({ found: false, errorCode: 'artifact_not_found' });
  });

  it('已知 artifact 回元数据与 base64 内容', async () => {
    await ensureConnected();
    // 任务会话必须先存在：ws_cancel_1 已由前面的 run_task 建过
    store.putArtifact({
      tenantId: 'default',
      artifactId: 'art_known',
      sessionId: 'ws_cancel_1',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
      sha256: 'a'.repeat(64),
      kind: 'file',
      storageKey: 'cas/notes.txt',
    });
    mkdirSync(join(tmpRoot, 'artifacts', 'cas'), { recursive: true });
    writeFileSync(join(tmpRoot, 'artifacts', 'cas', 'notes.txt'), 'HELLO');

    sendToBridge({
      type: 'get_artifact',
      taskId: 'ws_cancel_1',
      artifactId: 'art_known',
      requestId: 'req_known',
    });

    const frame = await waitForFrame(
      (reply) => reply.type === 'artifact_content' && reply['requestId'] === 'req_known',
      'artifact_content 帧（已知 id）',
    );
    expect(frame).toMatchObject({ found: true, name: 'notes.txt', mimeType: 'text/plain' });
    expect(Buffer.from(String(frame['data'] ?? ''), 'base64').toString('utf8')).toBe('HELLO');
  });
});

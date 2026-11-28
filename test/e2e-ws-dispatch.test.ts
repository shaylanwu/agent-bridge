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
 *   5. form（elicitation）：下行 `kind:'form'` + requestedSchema → 非法 content 被
 *      `interaction_invalid_response` 挡在桥内（回合不死、请求仍可作答）→ 合法 content 以
 *      `{action:'accept',content}` 原样送到 CLI。这是 form 链路**唯一**的真闭环证据来源：
 *      真 CLI 会不会发 elicitation 取决于各家实现与账号，桥接侧能自证的就是这一整条
 *      「请求 → 校验 → 应答 → 子进程真的收到」。
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
 * 假 ACP CLI：
 *  - prompt 里带 `HANG` → 永不回应（喂给 cancel）；
 *  - prompt 里带 `CONV:` → 不申请权限，把「会话 id + 文本」追加落盘后回 `ACK:` 并 end_turn
 *    （喂给多轮会话：第二轮能带上同一个 native session 才算真续接）；
 *  - prompt 里带 `FORM:` → 发一次标准 `elicitation/create`（带 requestedSchema），
 *    把**实际收到的应答**落盘，喂给 form 链路；
 *  - 其余 → 发一次权限请求，收到 allow_once 就回文本并 end_turn。
 */
const FAKE_ACP = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const selectedOut = process.argv[2]; // 把「实际收到的选项」落盘：交付证据不能只看桥接日志
const promptLog = process.argv[3];   // 每轮「会用到的 sessionId + 文本」，用于证明续接复用同一会话
const formOut = process.argv[4];     // form：把 elicitation/create 实际拿到的 result 原样落盘
// 按进程唯一：第二轮若新建会话（而不是续接），sessionId 就会变，断言立刻红
const SID = 'sess_' + process.pid;

const rl = readline.createInterface({ input: process.stdin });
let promptId = null;
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  if (m.method === 'session/new') return send({ jsonrpc: '2.0', id: m.id, result: { sessionId: SID } });
  // 续接：客户端先试 load，失败才退 resume。这里直接接受，证明「原生续接」这条路径通了。
  if (m.method === 'session/load') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'session/prompt') {
    promptId = m.id;
    const p = m.params || {};
    const text = (p.prompt && (p.prompt.text || (p.prompt[0] && p.prompt[0].text))) || '';
    if (String(text).includes('HANG')) return; // 挂住：给 cancel_task 用
    if (promptLog) fs.appendFileSync(promptLog, String(p.sessionId || '') + '\t' + process.pid + '\t' + String(text) + '\n');
    if (String(text).includes('CONV:')) {
      send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId || 'sess_fake', update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ACK:' + String(text) },
      }}});
      send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      return;
    }
    if (String(text).includes('FORM:')) {
      // 标准 ACP elicitation（另一个入口是 CodeBuddy 扩展的 session/request_form，语义一致）
      send({ jsonrpc: '2.0', id: 910, method: 'elicitation/create', params: {
        sessionId: p.sessionId || 'sess_fake',
        message: 'Pick an environment',
        requestedSchema: {
          type: 'object',
          properties: { env: { type: 'string' }, replicas: { type: 'integer' } },
          required: ['env'],
        },
      }});
      return;
    }
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: p.sessionId || 'sess_fake',
      toolCall: { toolCallId: 'call_1', title: 'Run tests' },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject' },
      ],
    }});
    return;
  }
  if (m.id === 910 && m.result) {
    // 落盘「CLI 实际收到的东西」：合法 content 必须原样到达，被拒的非法 content 必须**到不了**这里
    if (formOut) fs.writeFileSync(formOut, JSON.stringify(m.result));
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_fake', update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'FORM_OK:' + JSON.stringify((m.result && m.result.content) || {}) },
    }}});
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
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
let promptLogFile = '';
let formResultFile = '';
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
  promptLogFile = join(tmpRoot, 'acp-prompts.log');
  formResultFile = join(tmpRoot, 'acp-form-result.json');

  // 假 ACP 通过 def.acp 注入（**通道真源是 def.acp**，不是 acpSpec——后者由 manifest 派生）：
  // 安装闸门用 def.bin，所以 bin 指到 PATH 上必然存在的 node。
  // 不设 authEnv：canRunAcp 会据此判定该通道可用（真 CodeBuddy 需要 CODEBUDDY_AUTH_TOKEN）。
  const def = agentDefOf('codebuddy-cli');
  if (!def) throw new Error('codebuddy-cli 定义缺失');
  const beforeDef = { bin: def.bin, acp: def.acp };
  def.bin = 'node';
  (def as { acp?: unknown }).acp = {
    command: process.execPath,
    args: [script, selectedOptionFile, promptLogFile, formResultFile],
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
    expect(finalStatus['result']).toBe('APPROVED_OK');
    // 交付证据看子进程落盘（它只在真收到响应时才写），不看桥接自己的日志
    expect(readFileSync(selectedOptionFile, 'utf8')).toBe('allow_once');
  }, 30_000);
});

describe('WS 直连：form（elicitation 表单）', () => {
  /**
   * form 与 permission 的差别不在「能不能弹」，而在**应答要过 schema 校验**：
   * 非法 content 不能悄悄送到 CLI（那等于把坏数据塞给 agent），也不能把回合打死
   * （用户填错一个字段就该重填，不是整个任务失败）。
   */
  it('非法 content 被拦在桥内且回合存活，合法 content 原样送达 CLI', async () => {
    await ensureConnected();
    sendToBridge({
      type: 'run_task',
      taskId: 'ws_form_1',
      agentType: 'codebuddy-cli',
      cwd: tmpRoot,
      args: [],
      prompt: 'FORM: deploy please',
      allowInteractive: true,
    });

    const request = await waitForFrame(
      (frame) => frame.type === 'task_interaction_request' && frame['taskId'] === 'ws_form_1',
      '表单请求帧',
    );
    expect(request['kind']).toBe('form');
    const payload = (request['payload'] ?? {}) as Record<string, unknown>;
    expect(payload['message']).toBe('Pick an environment');
    expect((payload['requestedSchema'] as Record<string, unknown>)['required']).toEqual(['env']);

    // 1) 缺必填字段 → 桥内拒绝，并明确告知「这条应答无效」
    sendToBridge({
      type: 'task_interaction_response',
      taskId: 'ws_form_1',
      requestId: request['requestId'],
      responseId: 'resp_form_bad',
      state: 'accepted',
      payload: { content: { replicas: 2 } },
      respondedBy: 'tester',
    });

    const rejected = await waitForFrame(
      (frame) =>
        frame.type === 'task_interaction_result' &&
        frame['requestId'] === request['requestId'] &&
        frame['responseId'] === 'resp_form_bad',
      '非法应答的 task_interaction_result',
    );
    expect(rejected['responseStatus']).toBe('invalid');
    expect(rejected['errorCode']).toBe('interaction_invalid_response');
    // 请求仍是 pending：填错可以重填，不是「已使用」的终态
    expect(rejected['requestState']).toBe('pending');

    // 2) 修正后重新提交 → 正常受理
    sendToBridge({
      type: 'task_interaction_response',
      taskId: 'ws_form_1',
      requestId: request['requestId'],
      responseId: 'resp_form_ok',
      state: 'accepted',
      payload: { content: { env: 'staging', replicas: 2 } },
      respondedBy: 'tester',
    });

    const accepted = await waitForFrame(
      (frame) =>
        frame.type === 'task_interaction_result' &&
        frame['requestId'] === request['requestId'] &&
        frame['responseId'] === 'resp_form_ok',
      '合法应答的 task_interaction_result',
    );
    expect(accepted['responseStatus']).toBe('accepted');
    expect(accepted['requestState']).toBe('resolved');

    const finalStatus = await waitForFrame(
      (frame) =>
        frame.type === 'task_status' &&
        frame['taskId'] === 'ws_form_1' &&
        (frame['status'] === 'success' || frame['status'] === 'failed'),
      '任务终态',
    );
    expect(finalStatus['status']).toBe('success');
    // 协议字段表写着「终态最终回答文本（≤16KB）」，实现此前从没填过（fix-task-status-result）
    expect(String(finalStatus['result'] ?? '')).toContain('FORM_OK');

    // 3) 交付证据取子进程落盘：它写的是**自己收到的 result**，且只写过一次
    //    （非法 content 若被放行，这里会是 {replicas:2}）
    expect(JSON.parse(readFileSync(formResultFile, 'utf8'))).toEqual({
      action: 'accept',
      content: { env: 'staging', replicas: 2 },
    });
  }, 40_000);
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

describe('WS 直连：conversation 多轮续接', () => {
  /**
   * 续接的硬证据取**子进程落盘**：每轮 prompt 都把「实际使用的 sessionId + 文本」追加到文件。
   * 假 CLI 的 sessionId 按进程唯一（`sess_<pid>`），所以第二轮只要没复用会话，
   * 就会是另一个 pid 的 id，断言立刻红 —— 这比看桥接日志可靠。
   */
  it('run_task(sessionMode=conversation) 后 send_message 复用同一 native session', async () => {
    await ensureConnected();
    writeFileSync(promptLogFile, '');

    sendToBridge({
      type: 'run_task',
      taskId: 'ws_conv_1',
      agentType: 'codebuddy-cli',
      cwd: tmpRoot,
      args: [],
      prompt: 'CONV: first',
      sessionMode: 'conversation',
      allowInteractive: false,
    });

    // 会话模式下「一轮成功」不等于会话结束：上行是 running + phase=waiting_user（会话保持开启）
    const firstTurn = await waitForFrame(
      (frame) =>
        frame.type === 'task_status' &&
        frame['taskId'] === 'ws_conv_1' &&
        frame['phase'] === 'waiting_user',
      '第 1 轮回合完成（waiting_user）',
    );

    sendToBridge({
      type: 'send_message',
      taskId: 'ws_conv_1',
      messageId: 'msg_2',
      parts: [{ kind: 'text', text: 'CONV: second' }],
      mode: 'queue',
    });

    const ack = await waitForFrame(
      (frame) => frame.type === 'message_ack' && frame['messageId'] === 'msg_2',
      'message_ack',
    );
    expect(ack['delivery']).toBe('queued');
    expect(typeof ack['turnId']).toBe('string');

    const secondTurn = await waitForFrame(
      (frame) =>
        frame.type === 'task_status' &&
        frame['taskId'] === 'ws_conv_1' &&
        frame['phase'] === 'waiting_user' &&
        frame['turnId'] !== firstTurn['turnId'],
      '第 2 轮回合完成（waiting_user）',
    );
    expect(secondTurn['turnId']).toBe(ack['turnId']);

    const rounds = readFileSync(promptLogFile, 'utf8').trim().split('\n');
    expect(rounds).toHaveLength(2);
    const [session1, pid1, prompt1] = rounds[0]!.split('\t');
    const [session2, pid2, prompt2] = rounds[1]!.split('\t');
    expect(prompt1).toContain('CONV: first');
    expect(prompt2).toContain('CONV: second');
    expect(session1).toMatch(/^sess_\d+$/);
    // 两轮必须是同一个原生会话：续接走 session/load，不是新开一个。
    // 假 CLI 的 id 按**进程**唯一，所以 pid 不同而 id 相同，恰好证明「跨进程 load 续接」成立。
    expect(session2).toBe(session1);
    expect(Number(pid1)).toBeGreaterThan(0);
    expect(Number(pid2)).toBeGreaterThan(0);
  }, 40_000);
});

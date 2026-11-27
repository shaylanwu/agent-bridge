/**
 * ACP server 网关（含 add-acp-session-memory 的 conversation 多轮语义）——
 * ACP v1 over HTTP（vendor-specific：POST 上行 + SSE 下行）。
 *
 * 取证重点：
 *  - initialize 只声明真实能力（loadSession=false、只收 text prompt）；
 *  - session/new 固化 agentType/cwd（`params._meta.agentType` 扩展，网关不猜）；
 *  - session/prompt **conversation 语义**：首轮 run_task(conversation)、后续轮 send_message
 *    续接同一 bridge 会话（多轮记忆）；SSE 帧：prompt（taskId/turn 标记）→ update →
 *    交互时 request → result（本轮 turn 结束：waiting_user → end_turn；失败 → error）；
 *  - 交互闭环：waiting 时流中出现 agent→client `request` 帧，客户端 POST /acp 回响应报文，
 *    网关转成 `task_interaction_response`（与 /v1/interactions/{id}:respond 同一条 dispatch 路径）；
 *  - session/cancel 取消当前 turn；会话终态后的 prompt 如实拒绝（不假装可续）。
 */

import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import { startControlPlane, type ControlPlaneDeps } from '../src/transport/control-plane.js';
import type { CancelTurnCommand, RunTaskCommand, SendMessageCommand, TaskStatus, InteractionResponseCommand } from '../src/protocol.js';

interface Res {
  status: number;
  body: string;
  json: <T = unknown>() => T;
}

function call(
  port: number,
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body, json: <T,>() => JSON.parse(body) as T });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * conversation 编排 mock：记录调用；`turnOf` 模拟 dispatch 层的 turn 建立
 * （message_ack(queued) + turn 开始事件）；测试手动 settle（emit 终态）。
 */
interface ConversationMock {
  runs: RunTaskCommand[];
  messages: SendMessageCommand[];
  cancels: CancelTurnCommand[];
  /** 模拟「turn 已排队」：emit ack + turn 开始（run 轮由 startTurn 代替 dispatch 内部建轮） */
  startTurn: (taskId: string, messageId?: string) => string;
  settle: (taskId: string, turnId: string, status: TaskStatus, info?: { error?: string }) => void;
  ops: NonNullable<ControlPlaneDeps['conversation']>;
}
function mockConversation(store: SessionStore, emitter: Emitter): ConversationMock {
  const runs: RunTaskCommand[] = [];
  const messages: SendMessageCommand[] = [];
  const cancels: CancelTurnCommand[] = [];
  let seq = 0;
  const ops = {
    run: (msg: RunTaskCommand) => {
      runs.push(msg);
      // 模拟 dispatchConversationRun：建会话 + 建首轮 turn（同步）
      store.createSession({ sessionId: msg.taskId, tenantId: 'default', mode: 'conversation', agentType: msg.agentType, cwd: msg.cwd, phase: 'queued' });
      store.createTurn({ sessionId: msg.taskId, tenantId: 'default', status: 'queued' });
      emitter.emit({ type: 'task_status', taskId: msg.taskId, status: 'running', phase: 'queued', at: new Date().toISOString() });
    },
    message: (msg: SendMessageCommand) => {
      messages.push(msg);
      const turn = store.createTurn({ sessionId: msg.taskId, tenantId: 'default', status: 'queued' });
      emitter.emit({ type: 'message_ack', taskId: msg.taskId, messageId: msg.messageId, turnId: turn.turnId, delivery: 'queued', at: new Date().toISOString() });
      emitter.emit({ type: 'task_status', taskId: msg.taskId, turnId: turn.turnId, status: 'running', phase: 'queued', at: new Date().toISOString() });
      return Promise.resolve();
    },
    cancelTurn: (msg: CancelTurnCommand) => {
      cancels.push(msg);
      emitter.emit({ type: 'task_status', taskId: msg.taskId, turnId: msg.turnId, status: 'cancelled', at: new Date().toISOString() });
    },
  };
  return {
    runs,
    messages,
    cancels,
    ops,
    startTurn: (taskId, messageId) => {
      const turn = store.createTurn({ sessionId: taskId, tenantId: 'default', status: 'queued' });
      if (messageId) {
        emitter.emit({ type: 'message_ack', taskId, messageId, turnId: turn.turnId, delivery: 'queued', at: new Date().toISOString() });
      }
      emitter.emit({ type: 'task_status', taskId, turnId: turn.turnId, status: 'running', phase: 'queued', at: new Date().toISOString() });
      return turn.turnId;
    },
    settle: (taskId, turnId, status, info) => {
      const text = info?.error ?? `result of ${taskId}`;
      emitter.emit({ type: 'task_message', taskId, turnId, messageId: `msg_${++seq}`, role: 'agent', state: 'complete', text, at: new Date().toISOString() });
      if (status === 'success') {
        emitter.emit({ type: 'task_status', taskId, turnId, status: 'running', phase: 'waiting_user', at: new Date().toISOString() });
      } else {
        // 与真实 dispatchConversationRun 失败路径同口径：会话随之关闭（网关据此拒绝后续 prompt）
        store.closeSession(taskId, status, info?.error, 'default');
        emitter.emit({ type: 'task_status', taskId, turnId, status, error: info?.error, at: new Date().toISOString() });
      }
    },
  };
}

/** SSE 帧收集器（until 满足或流结束时 resolve） */
function collectSse(
  port: number,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string> },
  until: (events: Array<{ event: string; data: unknown }>) => boolean,
  timeoutMs = 4000,
): Promise<Array<{ event: string; data: unknown }>> {
  return new Promise((resolve, reject) => {
    const events: Array<{ event: string; data: unknown }> = [];
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(opts.headers ?? {}),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) !== 200) {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            reject(new Error(`SSE 状态码 ${res.statusCode}：${Buffer.concat(chunks).toString('utf8')}`)),
          );
          return;
        }
        let buf = '';
        res.on('data', (c: Buffer) => {
          buf += c.toString('utf8');
          for (;;) {
            const idx = buf.indexOf('\n\n');
            if (idx < 0) break;
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const ev = /^event: (.+)$/m.exec(frame)?.[1] ?? '';
            const raw = /^data: (.+)$/m.exec(frame)?.[1];
            if (raw !== undefined) {
              try {
                events.push({ event: ev, data: JSON.parse(raw) });
              } catch {
                events.push({ event: ev, data: raw });
              }
            }
          }
          if (until(events)) {
            req.destroy();
            resolve(events);
          }
        });
        res.on('end', () => resolve(events));
      },
    );
    req.on('error', () => resolve(events));
    if (payload) req.write(payload);
    req.end();
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE 超时（已收 ${events.length} 帧）`));
    }, timeoutMs);
    timer.unref?.();
  });
}

const started: Array<{ close: () => void }> = {};
const OK_VERIFY: ControlPlaneDeps['verify'] = () => ({ ok: true });

interface AcpFixture {
  port: number;
  store: SessionStore;
  emitter: Emitter;
  conv: ConversationMock;
  responded: InteractionResponseCommand[];
}

async function startAcp(overrides: {
  verify?: ControlPlaneDeps['verify'];
  respond?: ControlPlaneDeps['respondInteraction'];
  gateway?: { enabled?: boolean; a2a?: boolean; acp?: boolean };
} = {}): Promise<AcpFixture> {
  const store = new SessionStore(':memory:');
  const emitter = new Emitter({ sink: () => undefined, ringSize: 64 });
  const conv = mockConversation(store, emitter);
  const responded: InteractionResponseCommand[] = [];
  const plane = await startControlPlane(
    {
      enabled: true,
      host: '127.0.0.1',
      port: 0,
      requireToken: true,
      gateway: overrides.gateway ?? { enabled: true },
    },
    {
      emitter,
      registry: new TaskRegistry(),
      store,
      artifacts: {
        artifactPath: () => undefined,
        cleanupArtifacts: () => ({ scanned: 0, removed: 0 }),
      } as unknown as ControlPlaneDeps['artifacts'],
      startTask: () => {
        throw new Error('ACP 测试不触发单发 startTask（conversation 编排已注入）');
      },
      conversation: conv.ops,
      scan: async () => [],
      log: () => undefined,
      capabilities: ['diff'],
      version: '0.0.0-test',
      gatewayAgents: [
        { id: 'claude-code', name: 'Claude Code' },
        { id: 'codex', name: 'Codex CLI' },
      ],
      verify: overrides.verify ?? OK_VERIFY,
      respondInteraction:
        overrides.respond ??
        (async (msg) => {
          responded.push(msg);
          return { ok: true, state: msg.state, responseId: msg.responseId, resultSeq: 1 };
        }),
      defaults: { maxConcurrent: 1, maxQueued: 1, diffMaxBytes: 1024, captureDiffByDefault: false },
    },
  );
  (started.planes ??= []).push(plane);
  return { port: plane.port, store, emitter, conv, responded };
}

/** session/new → 返回 acpSessionId */
async function newSession(port: number): Promise<string> {
  const res = await call(port, 'POST', '/acp', {
    headers: { authorization: 'Bearer abs_x' },
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: { cwd: 'C:/work', _meta: { agentType: 'claude-code' } },
    },
  });
  expect(res.status).toBe(200);
  return res.json<{ result: { sessionId: string } }>().result.sessionId;
}

/** 发一轮 prompt 并收到 result 帧（helper：覆盖常见「跑到终帧」场景） */
function promptSse(
  port: number,
  acpSessionId: string,
  text: string,
  id = 12,
): Promise<Array<{ event: string; data: unknown }>> {
  return collectSse(
    port,
    '/acp',
    {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: acpSessionId, prompt: [{ type: 'text', text }] } },
    },
    (events) => events.some((e) => e.event === 'result'),
  );
}

describe('ACP 网关：路由与握手', () => {
  it('网关未启用 → /acp 404（不暴露存在性）；acp=false 单独关掉', async () => {
    const f = await startAcp({ gateway: { enabled: false } });
    const res = await call(f.port, 'POST', '/acp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(res.status).toBe(404);
    const g = await startAcp({ gateway: { enabled: true, acp: false } });
    const res2 = await call(g.port, 'POST', '/acp', { body: { jsonrpc: '2.0', id: 1, method: 'initialize' } });
    expect(res2.status).toBe(404);
  });

  it('initialize：只声明真实能力（loadSession=false、text-only、无 auth 方法）', async () => {
    const f = await startAcp();
    const res = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } },
    });
    expect(res.status).toBe(200);
    const result = res.json<{ result: Record<string, unknown> }>().result;
    expect(result['protocolVersion']).toBe(1);
    expect((result['agentCapabilities'] as Record<string, unknown>)['loadSession']).toBe(false);
    expect((result['agentCapabilities'] as Record<string, unknown>)['promptCapabilities']).toMatchObject({ image: false });
    expect(result['authMethods']).toEqual([]);
  });

  it('session/new：固化 agentType/cwd；缺字段或未知 agentType 拒绝', async () => {
    const f = await startAcp();
    const ok = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: 'C:/work', _meta: { agentType: 'codex' } } },
    });
    expect(ok.json<{ result: { sessionId: string } }>().result.sessionId).toMatch(/^acp_/);
    const missing = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: 'C:/work' } },
    });
    expect(missing.json<{ error: { code: number } }>().error.code).toBe(-32602);
    const unknown = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 3, method: 'session/new', params: { cwd: 'C:/work', _meta: { agentType: 'nope' } } },
    });
    expect(unknown.json<{ error: { code: number } }>().error.code).toBe(-32602);
  });
});

describe('ACP 网关：session/prompt conversation 多轮（add-acp-session-memory）', () => {
  it('首轮走 run_task(conversation)：SSE prompt 帧（first）→ update → waiting_user → end_turn', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    const sse = promptSse(f.port, sessionId, 'hello there');
    // 等 prompt 帧落地（turn 已由 mock run 建立）再 settle
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const run = f.conv.runs[0];
    expect(run).toMatchObject({ type: 'run_task', agentType: 'claude-code', cwd: 'C:/work', sessionMode: 'conversation' });
    expect(run?.prompt).toBe('hello there');
    const bridgeSessionId = run?.taskId as string;
    const turnId = f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string;
    f.conv.settle(bridgeSessionId, turnId, 'success');
    const events = await sse;
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe('prompt');
    expect((events[0] as { data: { turn: string; taskId: string } }).data).toMatchObject({ turn: 'first', taskId: bridgeSessionId });
    const resultFrame = events.find((e) => e.event === 'result') as { data: { result: { stopReason: string; content: string; sessionId: string } } };
    expect(resultFrame.data.result).toMatchObject({ stopReason: 'end_turn', sessionId });
    expect(resultFrame.data.result.content).toContain('result of');
    expect(events.some((e) => e.event === 'update')).toBe(true);
  });

  it('多轮记忆：第二轮走 send_message 续接同一 bridge 会话（同一 taskId、上下文不换）', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    // 第一轮
    const sse1 = promptSse(f.port, sessionId, 'remember the codeword BANANA42', 10);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const bridgeSessionId = f.conv.runs[0]?.taskId as string;
    const turn1 = f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string;
    f.conv.settle(bridgeSessionId, turn1, 'success');
    const r1 = await sse1;
    expect((r1.find((e) => e.event === 'result') as { data: { result: { stopReason: string } } }).data.result.stopReason).toBe('end_turn');
    // 第二轮：续接（send_message 而不是新 run）
    const sse2 = promptSse(f.port, sessionId, 'what was the codeword?', 11);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(f.conv.runs).toHaveLength(1); // 没有第二次 run
    expect(f.conv.messages).toHaveLength(1);
    expect(f.conv.messages[0]?.taskId).toBe(bridgeSessionId); // 同一 bridge 会话
    expect(f.conv.messages[0]?.parts[0]?.text).toBe('what was the codeword?');
    const turn2 = f.conv.messages[0] ? f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string : '';
    f.conv.settle(bridgeSessionId, turn2, 'success');
    const r2 = await sse2;
    const frame2 = r2.find((e) => e.event === 'result') as { data: { result: { stopReason: string } } };
    expect(frame2.data.result.stopReason).toBe('end_turn');
  });

  it('失败终态：会话关闭走 error 帧（不用假成功）；之后 prompt 如实拒绝', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    const sse = promptSse(f.port, sessionId, 'boom');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const bridgeSessionId = f.conv.runs[0]?.taskId as string;
    const turnId = f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string;
    f.conv.settle(bridgeSessionId, turnId, 'timeout', { error: '60s' });
    const events = await sse;
    const resultFrame = events.find((e) => e.event === 'result') as { data: { error: { code: number; data: { bridgeStatus: string } } } };
    expect(resultFrame.data.error.code).toBe(-32000);
    expect(resultFrame.data.error.data.bridgeStatus).toBe('timeout');
    // 会话已终态：后续 prompt 拒绝（提示新建会话）
    const after = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 13, method: 'session/prompt', params: { sessionId, prompt: 'again?' } },
    });
    expect(after.json<{ error: { code: number; message: string } }>().error.code).toBe(-32001);
    expect(after.json<{ error: { message: string } }>().error.message).toContain('session/new');
  });

  it('畸形帧：非 text prompt、未知会话、非 JSON-RPC 对象、并发 prompt（promptBusy）', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    const imagePrompt = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'image', data: 'x' }] } },
    });
    expect(imagePrompt.json<{ error: { code: number } }>().error.code).toBe(-32602);
    const missingSession = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'acp_nope', prompt: 'hi' } },
    });
    expect(missingSession.json<{ error: { code: number } }>().error.code).toBe(-32001);
    const badEnvelope = await call(f.port, 'POST', '/acp', { body: [1] });
    expect(badEnvelope.status).toBe(400);
    // 并发：第一轮未结束就发第二轮 → promptBusy
    void promptSse(f.port, sessionId, 'long running turn').catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const busy = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId, prompt: 'second while busy' } },
    });
    expect(busy.json<{ error: { code: number } }>().error.code).toBe(-32002);
  });

  it('conversation 未注入（旧进程）→ -32004 能力未接入，不降级为单发任务', async () => {
    const f = await startAcp();
    const store = new SessionStore(':memory:');
    const emitter = new Emitter({ sink: () => undefined, ringSize: 64 });
    // 起一个无 conversation 注入的网关
    const plane = await startControlPlane(
      { enabled: true, host: '127.0.0.1', port: 0, requireToken: true, gateway: { enabled: true } },
      {
        emitter,
        registry: new TaskRegistry(),
        store,
        artifacts: { artifactPath: () => undefined, cleanupArtifacts: () => ({ scanned: 0, removed: 0 }) } as unknown as ControlPlaneDeps['artifacts'],
        startTask: () => {
          throw new Error('不应触发单发任务');
        },
        scan: async () => [],
        log: () => undefined,
        capabilities: ['diff'],
        version: '0.0.0-test',
        gatewayAgents: [{ id: 'claude-code', name: 'Claude Code' }],
        verify: OK_VERIFY,
        defaults: { maxConcurrent: 1, maxQueued: 1, diffMaxBytes: 1024, captureDiffByDefault: false },
      },
    );
    (started.planes ??= []).push(plane);
    const sn = await call(plane.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: 'C:/w', _meta: { agentType: 'claude-code' } } },
    });
    const acpSession = sn.json<{ result: { sessionId: string } }>().result.sessionId;
    const prompt = await call(plane.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: acpSession, prompt: 'hi' } },
    });
    expect(prompt.json<{ error: { code: number } }>().error.code).toBe(-32004);
    void f;
  });

  it('prompt 要 task:create scope：只读令牌 403', async () => {
    const readonly: ControlPlaneDeps['verify'] = (_t, scope) => {
      const required = Array.isArray(scope) ? scope : [scope as string];
      return required.includes('task:create') ? { ok: false, reason: 'scope', message: '需要 task:create' } : { ok: true };
    };
    const f = await startAcp({ verify: readonly });
    const res = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'acp_x', prompt: 'hi' } },
    });
    expect(res.status).toBe(403);
  });
});

describe('ACP 网关：交互闭环', () => {
  it('permission：waiting → request 帧（agent→client）→ 客户端应答 → task_interaction_response 同一条路径', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    const sse = promptSse(f.port, sessionId, 'run tests');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const bridgeSessionId = f.conv.runs[0]?.taskId as string;
    const turnId = f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string;
    // 任务进入 waiting_interaction：落一条 pending permission 交互（真实链路是 broker.open；此处直接写 store）
    f.store.openInteraction({
      tenantId: 'default',
      sessionId: bridgeSessionId,
      requestId: 'ir_1',
      kind: 'permission',
      payload: { options: [{ optionId: 'allow-once', kind: 'allow_once' }, { optionId: 'reject-once' }] },
    });
    f.emitter.emit({ type: 'task_status', taskId: bridgeSessionId, turnId, status: 'running', phase: 'waiting_interaction', at: new Date().toISOString() });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const answer = await call(f.port, 'POST', '/acp', {
      body: { jsonrpc: '2.0', id: 'gwir_1', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
    });
    f.conv.settle(bridgeSessionId, turnId, 'success');
    const events = await sse;
    const requestFrames = events.filter((e) => e.event === 'request');
    expect(requestFrames.length).toBeGreaterThanOrEqual(1);
    const frame = requestFrames[0] as { data: { id: string; method: string; params: { options: Array<{ optionId: string }> } } };
    expect(frame.data.method).toBe('session/request_permission');
    expect(frame.data.params.options.map((o) => o.optionId)).toContain('allow-once');
    expect(f.responded.length).toBe(1);
    expect(f.responded[0]).toMatchObject({
      type: 'task_interaction_response',
      taskId: bridgeSessionId,
      requestId: 'ir_1',
      state: 'accepted',
      payload: { optionId: 'allow-once' },
    });
    expect(answer.status).toBe(200);
    const resultFrame = events.find((e) => e.event === 'result') as { data: { result: { stopReason: string } } };
    expect(resultFrame.data.result.stopReason).toBe('end_turn');
  });

  it('form：elicitation/create 帧 + accept(content) 应答', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    const sse = promptSse(f.port, sessionId, 'fill form');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const bridgeSessionId = f.conv.runs[0]?.taskId as string;
    const turnId = f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string;
    f.store.openInteraction({
      tenantId: 'default',
      sessionId: bridgeSessionId,
      requestId: 'ir_form',
      kind: 'form',
      payload: { message: 'fill it', requestedSchema: { type: 'object', properties: { env: { type: 'string' } } } },
    });
    f.emitter.emit({ type: 'task_status', taskId: bridgeSessionId, turnId, status: 'running', phase: 'waiting_interaction', at: new Date().toISOString() });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const answer = await call(f.port, 'POST', '/acp', {
      body: { jsonrpc: '2.0', id: 'gwir_1', result: { action: 'accept', content: { env: 'prod' } } },
    });
    f.conv.settle(bridgeSessionId, turnId, 'success');
    const events = await sse;
    const frame = events.find((e) => e.event === 'request') as { data: { method: string; params: { mode: string; schema: Record<string, unknown> } } };
    expect(frame.data.method).toBe('elicitation/create');
    expect(frame.data.params.mode).toBe('form');
    expect(f.responded[0]).toMatchObject({
      requestId: 'ir_form',
      state: 'accepted',
      payload: { content: { env: 'prod' } },
    });
    expect(answer.status).toBe(200);
  });

  it('未知出站 id / 畸形应答拒绝；permission 应答要 task:approve', async () => {
    const f = await startAcp();
    const unknown = await call(f.port, 'POST', '/acp', {
      body: { jsonrpc: '2.0', id: 'gwir_nope', result: { outcome: { outcome: 'selected', optionId: 'x' } } },
    });
    expect(unknown.status).toBe(404);
    const noToken: ControlPlaneDeps['verify'] = (_t, scope) => {
      const required = Array.isArray(scope) ? scope : [scope as string];
      return required.includes('task:approve') ? { ok: false, reason: 'scope', message: '需要 task:approve' } : { ok: true };
    };
    const g = await startAcp({ verify: noToken });
    const sessionId = await newSession(g.port);
    const sse = promptSse(g.port, sessionId, 'hi');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const bridgeSessionId = g.conv.runs[0]?.taskId as string;
    const turnId = g.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string;
    g.store.openInteraction({
      tenantId: 'default',
      sessionId: bridgeSessionId,
      requestId: 'ir_p',
      kind: 'permission',
      payload: { options: [{ optionId: 'allow-once' }] },
    });
    g.emitter.emit({ type: 'task_status', taskId: bridgeSessionId, turnId, status: 'running', phase: 'waiting_interaction', at: new Date().toISOString() });
    await new Promise<void>((resolve) => setTimeout(resolve, 150));
    const denied = await call(g.port, 'POST', '/acp', {
      body: { jsonrpc: '2.0', id: 'gwir_1', result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } },
    });
    expect(denied.status).toBe(403);
    g.emitter.emit({ type: 'task_status', taskId: bridgeSessionId, turnId, status: 'cancelled', at: new Date().toISOString() });
    await sse;
  });
});

describe('ACP 网关：session/cancel', () => {
  it('取消当前轮次：走 cancel_turn（operationId 幂等键）；无活动轮次静默成功', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    // 无活动轮次
    const idle = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'session/cancel', params: { sessionId } },
    });
    expect(idle.json<{ result: { cancelled: boolean } }>().result.cancelled).toBe(false);
    // 开一轮再取消
    void promptSse(f.port, sessionId, 'long turn').catch(() => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const bridgeSessionId = f.conv.runs[0]?.taskId as string;
    const cancel = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 2, method: 'session/cancel', params: { sessionId } },
    });
    expect(cancel.json<{ result: { cancelled: boolean; taskId: string } }>().result).toMatchObject({ cancelled: true, taskId: bridgeSessionId });
    expect(f.conv.cancels).toHaveLength(1);
    expect(f.conv.cancels[0]?.taskId).toBe(bridgeSessionId);
    expect(typeof f.conv.cancels[0]?.operationId).toBe('string');
  });

  it('未知会话取消 → sessionNotFound', async () => {
    const f = await startAcp();
    const res = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'session/cancel', params: { sessionId: 'acp_nope' } },
    });
    expect(res.json<{ error: { code: number } }>().error.code).toBe(-32001);
  });
});

/**
 * 交互申请（add-interaction-optin）：会话级 `_meta.allowInteractive` 是**唯一**入口。
 * 不声明就不该出现请求帧（否则每次任务都可能卡在等人）。
 */
describe('ACP 网关：会话级交互申请', () => {
  it('session/new 带 _meta.allowInteractive → 首轮 run_task 带上 allowInteractive', async () => {
    const f = await startAcp();
    const created = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: { cwd: 'C:/work', _meta: { agentType: 'claude-code', allowInteractive: true } },
      },
    });
    const sessionId = created.json<{ result: { sessionId: string } }>().result.sessionId;
    const sse = promptSse(f.port, sessionId, 'run the tests');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(f.conv.runs[0]?.allowInteractive).toBe(true);
    const bridgeSessionId = f.conv.runs[0]?.taskId as string;
    f.conv.settle(bridgeSessionId, f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string, 'success');
    await sse;
  });

  it('未声明 → run_task 不带 allowInteractive（按非交互执行）', async () => {
    const f = await startAcp();
    const sessionId = await newSession(f.port);
    const sse = promptSse(f.port, sessionId, 'run the tests');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(f.conv.runs[0]?.allowInteractive).toBeUndefined();
    const bridgeSessionId = f.conv.runs[0]?.taskId as string;
    f.conv.settle(bridgeSessionId, f.store.listTurns(bridgeSessionId, 'default').at(-1)?.turnId as string, 'success');
    await sse;
  });

  it('_meta.allowInteractive 非布尔 → invalidParams（不猜 "true"/1）', async () => {
    const f = await startAcp();
    const res = await call(f.port, 'POST', '/acp', {
      headers: { authorization: 'Bearer abs_x' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'session/new',
        params: { cwd: 'C:/work', _meta: { agentType: 'claude-code', allowInteractive: 'yes' } },
      },
    });
    expect(res.json<{ error: { code: number } }>().error.code).toBe(-32602);
  });
});

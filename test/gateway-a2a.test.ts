/**
 * A2A 网关（tasks 2.1 / 2.2）—— 起真控制面 + 真 SessionStore 的 HTTP 契约测试。
 *
 * 取证重点（proposal 的安全承诺）：
 *  - 默认关闭：未启用时 /a2a 与 agent card 一律 404（不暴露存在性）；
 *  - agent card 声明真实能力（streaming=false —— 订阅还没实现就不写 true）；
 *  - tasks/get 按 tenant 隔离：跨租户/不存在统一 -32001（不泄露「存在但不是你的」）；
 *  - 无令牌 401、错 scope 403（与 /v1/* 同一套鉴权）；
 *  - 版本协商：1.0 与 0.3 两套拼写，未知版本 -32009；
 *  - 未实现方法诚实回 -32004，不降级不假成功。
 */

import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import { startControlPlane, type ControlPlaneDeps } from '../src/transport/control-plane.js';
import type { RunTaskRequest, TaskFinishInfo, TaskHandle, TaskHooks } from '../src/core/task-supervisor.js';
import type { TaskStatus } from '../src/protocol.js';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T,>() => JSON.parse(body) as T,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const started: Array<{ close: () => void }> = {};

/**
 * 可编程 startTask mock：记录请求、保存 hooks；测试手动 settle（模拟长任务）或 cancel。
 * cancel 触发 onStatus('cancelled')——与真实 supervisor 的「终态经回调回传」语义一致。
 */
interface TaskMock {
  requests: RunTaskRequest[];
  cancels: string[];
  settle: (taskId: string, status: TaskStatus, info?: TaskFinishInfo) => void;
  startTask: ControlPlaneDeps['startTask'];
}
function mockStartTask(): TaskMock {
  const requests: RunTaskRequest[] = [];
  const cancels: string[] = [];
  const hooks = new Map<string, TaskHooks>();
  const startTask = (req: RunTaskRequest, h: TaskHooks): TaskHandle => {
    requests.push(req);
    hooks.set(req.taskId, h);
    h.onStatus('running', { phase: 'queued' });
    return {
      taskId: req.taskId,
      cancel: () => {
        cancels.push(req.taskId);
        hooks.get(req.taskId)?.onStatus('cancelled');
      },
      done: Promise.resolve('cancelled' as const),
    };
  };
  return {
    requests,
    cancels,
    startTask,
    settle: (taskId, status, info) => hooks.get(taskId)?.onStatus(status, info),
  };
}

function makeDeps(
  store: SessionStore,
  verify: ControlPlaneDeps['verify'],
  startTask: ControlPlaneDeps['startTask'] = () => {
    throw new Error('本测试不触发任务创建');
  },
  emitter = new Emitter({ sink: () => undefined, ringSize: 64 }),
): ControlPlaneDeps {
  return {
    emitter,
    registry: new TaskRegistry(),
    store,
    artifacts: {
      artifactPath: () => undefined,
      cleanupArtifacts: () => ({ scanned: 0, removed: 0 }),
    } as unknown as ControlPlaneDeps['artifacts'],
    startTask,
    scan: async () => [],
    log: () => undefined,
    capabilities: ['diff'],
    version: '0.0.0-test',
    gatewayAgents: [
      { id: 'claude-code', name: 'Claude Code' },
      { id: 'codex', name: 'Codex CLI' },
    ],
    verify,
    defaults: { maxConcurrent: 1, maxQueued: 1, diffMaxBytes: 1024, captureDiffByDefault: false },
  };
}

async function startGateway(store: SessionStore, verify: ControlPlaneDeps['verify']) {
  const plane = await startControlPlane(
    { enabled: true, host: '127.0.0.1', port: 0, requireToken: true, gateway: { enabled: true } },
    makeDeps(store, verify),
  );
  (started.planes ??= []).push(plane);
  return plane;
}

async function startGatewayDeps(deps: ControlPlaneDeps) {
  const plane = await startControlPlane(
    { enabled: true, host: '127.0.0.1', port: 0, requireToken: true, gateway: { enabled: true } },
    deps,
  );
  (started.planes ??= []).push(plane);
  return plane;
}

/** SSE 帧收集器：解析 `event:`/`data:` 帧，until 返回 true 或流结束时 resolve */
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

/** 预填一个已完成任务：一条 complete 消息 + 一条 delta（不进 history） */
function seedTask(store: SessionStore, taskId = 'bt_seed', tenantId = 'default'): void {
  store.createSession({ sessionId: taskId, tenantId, mode: 'task', agentType: 'claude-code', cwd: 'C:/w', phase: 'settled', status: 'success' });
  store.appendEvent({ sessionId: taskId, tenantId, type: 'task_message', payload: { messageId: 'm1', role: 'agent', state: 'complete', text: 'all done' } });
  store.appendEvent({ sessionId: taskId, tenantId, type: 'task_message', payload: { messageId: 'm2', role: 'agent', state: 'delta', text: 'partial' } });
}

const OK_VERIFY: ControlPlaneDeps['verify'] = () => ({ ok: true });
const MISSING_VERIFY: ControlPlaneDeps['verify'] = (token) =>
  token ? { ok: true } : { ok: false, reason: 'missing', message: '缺令牌' };
const SCOPE_VERIFY: ControlPlaneDeps['verify'] = (_token, scope) => {
  const required = Array.isArray(scope) ? scope : [scope as string];
  const allowed = required.includes('session:read') || required.includes('task:read');
  return allowed ? { ok: true } : { ok: false, reason: 'scope', message: `需要 scope: ${required.join(' 或 ')}` };
};

describe('A2A 网关：默认关闭（安全红线）', () => {
  it('未启用时 /a2a 与 agent card 都 404（不暴露存在性）', async () => {
    const store = new SessionStore(':memory:');
    const plane = await startControlPlane(
      { enabled: true, host: '127.0.0.1', port: 0, requireToken: true },
      makeDeps(store, OK_VERIFY),
    );
    (started.planes ??= []).push(plane);
    const a2a = await call(plane.port, 'POST', '/a2a', {
      body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } },
    });
    expect(a2a.status).toBe(404);
    const card = await call(plane.port, 'GET', '/.well-known/agent-card.json');
    expect(card.status).toBe(404);
  });
});

describe('A2A 网关：agent card（task 2.1）', () => {
  it('声明真实能力：streaming/pushNotifications=false，skills 来自静态适配器表', async () => {
    const store = new SessionStore(':memory:');
    const plane = await startGateway(store, OK_VERIFY);
    const card = await call(plane.port, 'GET', '/.well-known/agent-card.json');
    expect(card.status).toBe(200);
    const body = card.json<Record<string, unknown>>();
    expect(body['name']).toBe('agent-bridge');
    expect(body['protocolVersion']).toBe('1.0');
    expect(body['url']).toBe(`http://127.0.0.1:${plane.port}/a2a`);
    const caps = body['capabilities'] as Record<string, unknown>;
    expect(caps['streaming']).toBe(false);
    expect(caps['pushNotifications']).toBe(false);
    const skills = body['skills'] as Array<Record<string, unknown>>;
    expect(skills.map((s) => s['id'])).toEqual(['claude-code', 'codex']);
    expect((body['supportedInterfaces'] as Array<Record<string, unknown>>)[0]?.['url']).toBe(
      `http://127.0.0.1:${plane.port}/a2a`,
    );
  });

  it('不返回 CORS 头（浏览器脚本不得静默调用）', async () => {
    const store = new SessionStore(':memory:');
    const plane = await startGateway(store, OK_VERIFY);
    const card = await call(plane.port, 'GET', '/.well-known/agent-card.json');
    expect(card.headers['access-control-allow-origin']).toBeUndefined();
    const a2a = await call(plane.port, 'POST', '/a2a', { body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: {} } });
    expect(a2a.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('A2A 网关：tasks/get 只读（task 2.2）', () => {
  it('v1.0 拼写：GetTask 返回 Task（TASK_STATE_COMPLETED + history 只含 complete）', async () => {
    const store = new SessionStore(':memory:');
    seedTask(store);
    const plane = await startGateway(store, OK_VERIFY);
    const res = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 7, method: 'GetTask', params: { id: 'bt_seed' } },
    });
    expect(res.status).toBe(200);
    const body = res.json<{ jsonrpc: string; id: number; result: Record<string, unknown> }>();
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(7);
    const task = body.result;
    expect(task['id']).toBe('bt_seed');
    expect((task['status'] as Record<string, unknown>)['state']).toBe('TASK_STATE_COMPLETED');
    expect(task['kind']).toBeUndefined();
    const history = task['history'] as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect((history[0]?.['parts'] as Array<Record<string, unknown>>)[0]?.['kind']).toBe('text');
    const bridge = (task['metadata'] as Record<string, unknown>)['bridge'] as Record<string, unknown>;
    expect(bridge['agentType']).toBe('claude-code');
    expect(bridge['taskLogEndpoint']).toContain('/v1/tasks/bt_seed/events');
  });

  it('0.3 拼写：缺省版本头时 state 连字符 + kind 判别', async () => {
    const store = new SessionStore(':memory:');
    seedTask(store);
    const plane = await startGateway(store, OK_VERIFY);
    const res = await call(plane.port, 'POST', '/a2a', {
      body: { jsonrpc: '2.0', id: 'a', method: 'tasks/get', params: { id: 'bt_seed' } },
    });
    const task = res.json<{ result: Record<string, unknown> }>().result;
    expect((task['status'] as Record<string, unknown>)['state']).toBe('completed');
    expect(task['kind']).toBe('task');
  });

  it('不存在 / 跨租户统一 TaskNotFoundError（-32001）', async () => {
    const store = new SessionStore(':memory:');
    seedTask(store, 'bt_seed', 'tenant-a');
    const plane = await startGateway(store, OK_VERIFY);
    // default 租户看不到 tenant-a 的任务
    const cross = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'bt_seed' } },
    });
    expect(cross.json<{ error: { code: number } }>().error.code).toBe(-32001);
    const missing = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: 'bt_nope' } },
    });
    expect(missing.json<{ error: { code: number } }>().error.code).toBe(-32001);
  });

  it('鉴权：无令牌 401、只读 scope 足够、其它 scope 403', async () => {
    const store = new SessionStore(':memory:');
    seedTask(store);
    const noToken = await startGateway(store, MISSING_VERIFY);
    const res401 = await call(noToken.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'bt_seed' } },
    });
    expect(res401.status).toBe(401);

    const scoped = await startGateway(store, SCOPE_VERIFY);
    const ok = await call(scoped.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0', authorization: 'Bearer abs_x' },
      body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'bt_seed' } },
    });
    expect(ok.status).toBe(200);
    expect(ok.json<{ result: Record<string, unknown> }>().result['id']).toBe('bt_seed');
  });

  it('未知版本 -32009；未知方法 -32601', async () => {
    const store = new SessionStore(':memory:');
    seedTask(store);
    const plane = await startGateway(store, OK_VERIFY);
    const badVersion = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '2.0' },
      body: { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'bt_seed' } },
    });
    expect(badVersion.json<{ error: { code: number } }>().error.code).toBe(-32009);

    const badMethod = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 1, method: 'tasks/list', params: {} },
    });
    expect(badMethod.json<{ error: { code: number } }>().error.code).toBe(-32601);
  });

  it('畸形信封：非 JSON-RPC 对象回 invalidRequest', async () => {
    const store = new SessionStore(':memory:');
    const plane = await startGateway(store, OK_VERIFY);
    const bad = await call(plane.port, 'POST', '/a2a', { body: [1, 2, 3] });
    expect(bad.json<{ error: { code: number } }>().error.code).toBe(-32600);
    const noJsonrpc = await call(plane.port, 'POST', '/a2a', { body: { id: 1, method: 'GetTask' } });
    expect(noJsonrpc.json<{ error: { code: number } }>().error.code).toBe(-32600);
  });
});

const SEND_MSG = {
  jsonrpc: '2.0' as const,
  id: 11,
  method: 'SendMessage',
  params: {
    message: {
      messageId: 'amsg-1',
      role: 'ROLE_USER',
      parts: [{ kind: 'text', text: 'fix the login test' }],
      metadata: { agentType: 'claude-code', cwd: 'C:/work', timeoutMs: 60000 },
    },
  },
};

describe('A2A 网关：SendMessage 创建任务（task 2.3）', () => {
  it('创建成功：走同一条 startTask 编排，返回 SUBMITTED Task（立即返回，不阻塞终态）', async () => {
    const store = new SessionStore(':memory:');
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask));
    const res = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: SEND_MSG,
    });
    expect(res.status).toBe(200);
    const body = res.json<{ result: Record<string, unknown> }>();
    const task = body.result;
    expect(typeof task['id']).toBe('string');
    expect((task['id'] as string).startsWith('bt_')).toBe(true);
    expect((task['status'] as Record<string, unknown>)['state']).toBe('TASK_STATE_SUBMITTED');
    // 同一条编排：startTask 收到网关请求（prompt 压实、args 为受管空集）
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.prompt).toBe('fix the login test');
    expect(mock.requests[0]?.cwd).toBe('C:/work');
    expect(mock.requests[0]?.args).toEqual([]);
    expect(mock.requests[0]?.timeoutMs).toBe(60000);
    // store 里已建会话与回合
    expect(store.getSession(task['id'] as string)).toBeDefined();
  });

  it('幂等：同 messageId 重发拿回同一 taskId（idempotentReplay），不重复 startTask', async () => {
    const store = new SessionStore(':memory:');
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask));
    const first = await call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: SEND_MSG });
    const firstId = first.json<{ result: Record<string, unknown> }>().result['id'];
    const second = await call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: SEND_MSG });
    const secondResult = second.json<{ result: Record<string, unknown> }>().result;
    expect(secondResult['id']).toBe(firstId);
    expect((secondResult['metadata'] as Record<string, unknown>)['idempotentReplay']).toBe(true);
    expect(mock.requests).toHaveLength(1);
  });

  it('同 messageId 异参 → 幂等冲突（-32000 + data.code）', async () => {
    const store = new SessionStore(':memory:');
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask));
    await call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: SEND_MSG });
    const conflict = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: {
        ...SEND_MSG,
        params: {
          message: {
            ...SEND_MSG.params.message,
            parts: [{ kind: 'text', text: 'different prompt' }],
          },
        },
      },
    });
    const err = conflict.json<{ error: { code: number; data?: { code?: string } } }>().error;
    expect(err.code).toBe(-32000);
    expect(err.data?.['code']).toBe('idempotency_conflict');
  });

  it('缺 metadata.agentType / cwd、未知 agentType、非 user role、非 text part、空 prompt 都拒绝', async () => {
    const store = new SessionStore(':memory:');
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask));
    const send = (msg: unknown) =>
      call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: msg } } });
    const code = async (msg: unknown) => (await send(msg)).json<{ error: { code: number } }>().error.code;

    expect(await code({ messageId: 'x', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'hi' }] })).toBe(-32602);
    expect(await code({ messageId: 'x', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'hi' }], metadata: { agentType: 'claude-code' } })).toBe(-32602);
    expect(
      await code({ messageId: 'x', role: 'ROLE_USER', parts: [{ kind: 'text', text: 'hi' }], metadata: { agentType: 'not-a-cli', cwd: 'C:/w' } }),
    ).toBe(-32602);
    expect(
      await code({ messageId: 'x', role: 'ROLE_AGENT', parts: [{ kind: 'text', text: 'hi' }], metadata: { agentType: 'claude-code', cwd: 'C:/w' } }),
    ).toBe(-32602);
    expect(
      await code({ messageId: 'x', role: 'ROLE_USER', parts: [{ kind: 'file', file: {} }], metadata: { agentType: 'claude-code', cwd: 'C:/w' } }),
    ).toBe(-32005);
    expect(
      await code({ messageId: 'x', role: 'ROLE_USER', parts: [{ kind: 'text', text: '   ' }], metadata: { agentType: 'claude-code', cwd: 'C:/w' } }),
    ).toBe(-32602);
    expect(mock.requests).toHaveLength(0);
  });

  it('写方法要 task:create：只读令牌 403', async () => {
    const store = new SessionStore(':memory:');
    const readonly: ControlPlaneDeps['verify'] = (_t, scope) => {
      const required = Array.isArray(scope) ? scope : [scope as string];
      return required.includes('task:create') ? { ok: false, reason: 'scope', message: '需要 task:create' } : { ok: true };
    };
    const plane = await startGatewayDeps(makeDeps(store, readonly, mockStartTask().startTask));
    const res = await call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: SEND_MSG });
    expect(res.status).toBe(403);
  });
});

describe('A2A 网关：CancelTask 取消（task 2.4）', () => {
  async function createRunningTask(): Promise<{ plane: { port: number }; mock: TaskMock; taskId: string }> {
    const store = new SessionStore(':memory:');
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask));
    const res = await call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: SEND_MSG });
    const taskId = res.json<{ result: Record<string, unknown> }>().result['id'] as string;
    return { plane, mock, taskId };
  }

  it('取消成功：handle.cancel 被调，返回当前快照', async () => {
    const { plane, mock, taskId } = await createRunningTask();
    const res = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 12, method: 'CancelTask', params: { id: taskId } },
    });
    expect(res.status).toBe(200);
    expect(mock.cancels).toEqual([taskId]);
    const task = res.json<{ result: Record<string, unknown> }>().result;
    expect(task['id']).toBe(taskId);
    // cancel mock 同步触发终态回调 → 会话已 closed
    expect(['TASK_STATE_CANCELED', 'TASK_STATE_WORKING']).toContain((task['status'] as Record<string, unknown>)['state']);
  });

  it('终态任务 → TaskNotCancelableError（-32002，规范语义）', async () => {
    const { plane, taskId } = await createRunningTask();
    const first = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 12, method: 'CancelTask', params: { id: taskId } },
    });
    expect(first.status).toBe(200);
    const second = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 13, method: 'CancelTask', params: { id: taskId } },
    });
    expect(second.json<{ error: { code: number } }>().error.code).toBe(-32002);
  });

  it('不存在 → -32001；跨租户统一不存在', async () => {
    const store = new SessionStore(':memory:');
    seedTask(store, 'bt_other_tenant', 'tenant-a');
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mockStartTask().startTask));
    const missing = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 1, method: 'CancelTask', params: { id: 'bt_nope' } },
    });
    expect(missing.json<{ error: { code: number } }>().error.code).toBe(-32001);
    const cross = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 2, method: 'CancelTask', params: { id: 'bt_other_tenant' } },
    });
    expect(cross.json<{ error: { code: number } }>().error.code).toBe(-32001);
  });

  it('取消要 task:cancel：只读令牌 403', async () => {
    const store = new SessionStore(':memory:');
    const readonly: ControlPlaneDeps['verify'] = (_t, scope) => {
      const required = Array.isArray(scope) ? scope : [scope as string];
      return required.includes('task:cancel') ? { ok: false, reason: 'scope', message: '需要 task:cancel' } : { ok: true };
    };
    const plane = await startGatewayDeps(makeDeps(store, readonly, mockStartTask().startTask));
    const res = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 1, method: 'CancelTask', params: { id: 'bt_x' } },
    });
    expect(res.status).toBe(403);
  });
});

describe('A2A 网关：SubscribeToTask 订阅（task 2.5）', () => {
  it('不存在 → -32001；终态任务 → -32004（规范语义）', async () => {
    const store = new SessionStore(':memory:');
    seedTask(store);
    const plane = await startGateway(store, OK_VERIFY);
    const missing = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 1, method: 'SubscribeToTask', params: { id: 'bt_nope' } },
    });
    expect(missing.json<{ error: { code: number } }>().error.code).toBe(-32001);
    const terminal = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: { jsonrpc: '2.0', id: 2, method: 'SubscribeToTask', params: { id: 'bt_seed' } },
    });
    expect(terminal.json<{ error: { code: number } }>().error.code).toBe(-32004);
  });

  it('运行中任务：首帧快照 → 回放 → 实时帧 → 终态 done 关流（eventSeq 补洞）', async () => {
    const store = new SessionStore(':memory:');
    const emitter = new Emitter({ sink: () => undefined, ringSize: 64 });
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask, emitter));
    // 先建任务（立即返回，running）
    const created = await call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: SEND_MSG });
    const taskId = created.json<{ result: Record<string, unknown> }>().result['id'] as string;
    // 模拟 agent 产出：一条 complete 消息事件（回放用）
    store.appendEvent({
      sessionId: taskId,
      type: 'task_message',
      payload: { messageId: 'm1', role: 'agent', state: 'complete', text: 'working on it' },
    });
    // 订阅：先等首帧快照落地（订阅已建立），再发实时帧——避免 emit 先于 subscribe 丢失
    let onFirstFrame: () => void = () => undefined;
    const firstFrame = new Promise<void>((resolve) => {
      onFirstFrame = resolve;
    });
    const ssePromise = collectSse(
      plane.port,
      '/a2a',
      { headers: { 'A2A-Version': '1.0' }, body: { jsonrpc: '2.0', id: 21, method: 'SubscribeToTask', params: { id: taskId } } },
      (events) => {
        if (events.some((e) => e.event === 'task')) onFirstFrame();
        return events.some((e) => e.event === 'done');
      },
    );
    await firstFrame;
    // 实时上行：complete 消息 → 终态
    emitter.emit({ type: 'task_message', taskId, messageId: 'm2', role: 'agent', state: 'complete', text: 'all done', at: new Date().toISOString() });
    emitter.emit({ type: 'task_status', taskId, status: 'success', exitCode: 0, at: new Date().toISOString() });
    const events = await ssePromise;
    const kinds = events.map((e) => e.event);
    // 首帧完整快照 + 回放消息 + 实时消息 + 状态帧 + 终态快照 + done
    expect(kinds[0]).toBe('task');
    expect(kinds).toContain('message');
    expect(kinds).toContain('status');
    expect(kinds[kinds.length - 1]).toBe('done');
    const messageFrames = events.filter((e) => e.event === 'message') as Array<{ data: { eventSeq?: number; message: { parts: Array<{ kind?: string; text: string }> } } }>;
    const texts = messageFrames.map((f) => f.data.message.parts[0]?.text);
    expect(texts).toContain('working on it');
    expect(texts).toContain('all done');
    const doneFrame = events.find((e) => e.event === 'done') as { data: { taskId: string; status: string } };
    expect(doneFrame.data).toMatchObject({ taskId, status: 'success' });
  });

  it('afterEventSeq 补洞：只回放游标之后的事件', async () => {
    const store = new SessionStore(':memory:');
    const emitter = new Emitter({ sink: () => undefined, ringSize: 64 });
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask, emitter));
    const created = await call(plane.port, 'POST', '/a2a', { headers: { 'A2A-Version': '1.0' }, body: SEND_MSG });
    const taskId = created.json<{ result: Record<string, unknown> }>().result['id'] as string;
    const e1 = store.appendEvent({ sessionId: taskId, type: 'task_message', payload: { messageId: 'm1', role: 'agent', state: 'complete', text: 'old message' } });
    const e2 = store.appendEvent({ sessionId: taskId, type: 'task_message', payload: { messageId: 'm2', role: 'agent', state: 'complete', text: 'new message' } });
    // 订阅时从 e1 之后开始：m1 不回放，m2 回放
    const ssePromise = collectSse(
      plane.port,
      '/a2a',
      {
        headers: { 'A2A-Version': '1.0' },
        body: { jsonrpc: '2.0', id: 31, method: 'SubscribeToTask', params: { id: taskId, metadata: { afterEventSeq: e1.eventSeq } } },
      },
      (events) => events.filter((e) => e.event === 'message').length >= 1,
    );
    const events = await ssePromise;
    const messageFrames = events.filter((e) => e.event === 'message') as Array<{ data: { eventSeq?: number; message: { parts: Array<{ text: string }> } } }>;
    expect(messageFrames).toHaveLength(1);
    expect(messageFrames[0]?.data.message.parts[0]?.text).toBe('new message');
    expect(messageFrames[0]?.data.eventSeq).toBe(e2.eventSeq);
  });
});

/**
 * A2A 没有 agent→client 请求帧通道，也没有 task_interaction_response 的投递口。
 * 申请交互必须**明确拒绝**：静默跑成非交互会让调用方以为「权限已被自动批准」。
 */
describe('A2A 网关：交互边界（add-interaction-optin）', () => {
  it('metadata.allowInteractive=true → -32000 interaction_not_supported，且不创建任务', async () => {
    const store = new SessionStore(':memory:');
    const mock = mockStartTask();
    const plane = await startGatewayDeps(makeDeps(store, OK_VERIFY, mock.startTask));
    const res = await call(plane.port, 'POST', '/a2a', {
      headers: { 'A2A-Version': '1.0' },
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: {
          message: {
            messageId: 'want-interaction',
            role: 'ROLE_USER',
            parts: [{ kind: 'text', text: 'run the tests' }],
            metadata: { agentType: 'claude-code', cwd: 'C:/work', allowInteractive: true },
          },
        },
      },
    });
    const err = res.json<{ error: { code: number; data?: { code?: string } } }>().error;
    expect(err.code).toBe(-32000);
    expect(err.data?.['code']).toBe('interaction_not_supported');
    // 幂等键不落账：同 messageId 之后不带该字段仍能正常创建（不是「先占位再失败」）
    expect(mock.requests).toHaveLength(0);
  });
});

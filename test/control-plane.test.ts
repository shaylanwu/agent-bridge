/**
 * 本地回环控制面（扩展能力）
 *
 * 取证重点不是"能起服务"，而是那几条**安全红线**真的生效：
 * 默认关闭、只绑回环、不带令牌 401、scope 不足 403、绝不返回 CORS 头、幂等键不重复跑任务。
 */

import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { ArtifactTransferManager } from '../src/core/artifact-transfer.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import { startControlPlane, type ControlPlaneDeps } from '../src/transport/control-plane.js';
import type { RunTaskRequest, TaskFinishInfo, TaskHandle, TaskHooks } from '../src/core/task-supervisor.js';

interface Res {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
  json: <T = unknown>() => T;
}

function call(port: number, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
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
            headers: res.headers as Record<string, string | undefined>,
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

function makeDeps(overrides: Partial<ControlPlaneDeps> = {}): ControlPlaneDeps {
  const emitter = new Emitter({ sink: () => undefined, ringSize: 64 });
  const store = new SessionStore(':memory:');
  return {
    emitter,
    registry: new TaskRegistry(),
    store,
    artifacts: new ArtifactTransferManager({
      store,
      rootDir: join(tmpdir(), 'agent-bridge-control-plane-artifacts'),
      emit: () => undefined,
    }),
    startTask: (req: RunTaskRequest, hooks: TaskHooks): TaskHandle => {
      // 立即成功：测试关心的是 HTTP 层契约，不是真跑 CLI
      hooks.onStatus('success', { exitCode: 0 } satisfies TaskFinishInfo);
      void req;
      return { taskId: req.taskId, cancel: () => undefined, done: Promise.resolve('success' as const) };
    },
    scan: async () => [],
    log: () => undefined,
    capabilities: ['diff', 'queue'],
    version: '0.0.0-test',
    defaults: { maxConcurrent: 1, maxQueued: 1, diffMaxBytes: 1024, captureDiffByDefault: false },
    ...overrides,
  };
}

const started: Array<{ close: () => void }> = [];

async function start(deps: Partial<ControlPlaneDeps> = {}, port = 0) {
  const plane = await startControlPlane(
    { enabled: true, host: '127.0.0.1', port, requireToken: true },
    makeDeps(deps),
  );
  started.push(plane);
  return plane;
}

describe('本地回环控制面', () => {
  it('默认关闭：enabled=false 直接拒绝启动（不监听任何端口）', async () => {
    await expect(
      startControlPlane({ enabled: false, host: '127.0.0.1', port: 0 }, makeDeps()),
    ).rejects.toThrow(/未启用/);
  });

  it('/v1/health 免鉴权，且不返回任何 CORS 头', async () => {
    const plane = await start();
    const res = await call(plane.port, 'GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
    // 关键红线：浏览器脚本不得静默调用本机端口
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    plane.close();
  });

  it('/v1/metrics 需要鉴权并输出 Prometheus 文本', async () => {
    const plane = await start({
      verify: (token) =>
        token ? { ok: true } : { ok: false, reason: 'missing', message: '需要令牌' },
    });
    const denied = await call(plane.port, 'GET', '/v1/metrics');
    expect(denied.status).toBe(401);
    const res = await call(plane.port, 'GET', '/v1/metrics', {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('agent_bridge_up 1');
    expect(res.body).toContain('agent_bridge_tasks_running');
    expect(res.body).toContain('agent_bridge_sessions_total');
    plane.close();
  });

  it('无令牌访问受保护端点 → 401（RFC 9457 problem+json）', async () => {
    const plane = await start();
    const res = await call(plane.port, 'GET', '/v1/capabilities');
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json<{ code: string }>().code).toBe('unauthorized');
    plane.close();
  });

  it('scope 不足 → 403 insufficient_scope（有 task:read 还不够 task:create）', async () => {
    const plane = await start({ verify: () => ({ ok: false, reason: 'scope', message: '需要 scope: task:create' }) });
    const res = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd() },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(res.status).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('insufficient_scope');
    plane.close();
  });

  it('下发任务 → 201，且 Idempotency-Key 重复提交不重复跑', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const created = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd(), prompt: 'hi' },
      headers: { authorization: 'Bearer abs_x_y', 'idempotency-key': 'same-key' },
    });
    expect(created.status).toBe(201);
    const first = created.json<{ taskId: string; state: string }>();
    expect(first.state).toBe('success');

    const replay = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd(), prompt: 'hi' },
      headers: { authorization: 'Bearer abs_x_y', 'idempotency-key': 'same-key' },
    });
    expect(replay.status).toBe(200);
    const second = replay.json<{ taskId: string; idempotentReplay?: boolean }>();
    expect(second.taskId).toBe(first.taskId);
    expect(second.idempotentReplay).toBe(true);
    plane.close();
  });

  it('GET /sessions 提供免令牌页面壳（数据仍需令牌）', async () => {
    const plane = await start();
    const res = await call(plane.port, 'GET', '/sessions');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Sessions');
    expect(res.body).toContain('/v1/sessions');
    plane.close();
  });

  it('/v1/sessions 可列出持久会话并返回快照', async () => {
    const store = new SessionStore(':memory:');
    store.createSession({ sessionId: 'bt_persisted', mode: 'task', agentType: 'codex', cwd: process.cwd() });
    store.appendEvent({ sessionId: 'bt_persisted', type: 'task_status', payload: { status: 'running' } });
    const plane = await start({ store, verify: () => ({ ok: true }) });

    const list = await call(plane.port, 'GET', '/v1/sessions', {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(list.status).toBe(200);
    expect(list.json<{ sessions: { sessionId: string }[] }>().sessions[0]?.sessionId).toBe('bt_persisted');

    const snapshot = await call(plane.port, 'GET', '/v1/sessions/bt_persisted?afterEventSeq=0', {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.json<{ events: unknown[] }>().events).toHaveLength(1);
    plane.close();
  });

  it('/v1/sessions/{id}/events 超过 1000 条仍能分批回放', async () => {
    const store = new SessionStore(':memory:');
    store.createSession({ sessionId: 'bt_sse_many', mode: 'task', agentType: 'codex', cwd: process.cwd() });
    for (let i = 0; i < 1005; i += 1) {
      store.appendEvent({ sessionId: 'bt_sse_many', type: 'task_log', payload: { i } });
    }
    store.closeSession('bt_sse_many', 'success');
    const plane = await start({ store, verify: () => ({ ok: true }) });
    const res = await call(plane.port, 'GET', '/v1/sessions/bt_sse_many/events?afterEventSeq=0', {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(res.status).toBe(200);
    expect((res.body.match(/event: event/g) ?? []).length).toBe(1005);
    expect(res.body).toContain('"eventSeq":1005');
    expect(res.body).toContain('event: done');

    const resumed = await call(plane.port, 'GET', '/v1/sessions/bt_sse_many/events?afterEventSeq=1000', {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect((resumed.body.match(/event: event/g) ?? []).length).toBe(5);
    expect(resumed.body).not.toContain('"eventSeq":1,');
    plane.close();
  });

  it('GET /v1/sessions/{id}/artifacts/{aid} 未找到返回 404', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const res = await call(plane.port, 'GET', '/v1/sessions/bt_x/artifacts/art_missing', {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(res.status).toBe(404);
    plane.close();
  });

  it('/v1/sessions/{id}/events 回放历史并在终态结束', async () => {
    const store = new SessionStore(':memory:');
    store.createSession({ sessionId: 'bt_sse', mode: 'task', agentType: 'codex', cwd: process.cwd() });
    store.appendEvent({ sessionId: 'bt_sse', type: 'task_message', payload: { text: 'hello' } });
    store.closeSession('bt_sse', 'success');
    const plane = await start({ store, verify: () => ({ ok: true }) });
    const res = await call(plane.port, 'GET', '/v1/sessions/bt_sse/events', {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('event: snapshot');
    expect(res.body).toContain('event: event');
    expect(res.body).toContain('event: done');
    expect(res.body).toContain('"eventSeq":1');
    plane.close();
  });

  it('POST /v1/artifacts:gc 执行 TTL 清理（默认 dryRun 可显式）', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const res = await call(plane.port, 'POST', '/v1/artifacts:gc', {
      body: { ttlDays: 30, dryRun: true },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ ttlDays: 30, dryRun: true, scanned: 0, deleted: 0 });
    plane.close();
  });

  it('缺 agentType/cwd → 400；未知端点 → 404', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const bad = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex' },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(bad.status).toBe(400);
    const missing = await call(plane.port, 'GET', '/v1/nope');
    expect(missing.status).toBe(404);
    plane.close();
  });

  it('任务台账与 diff 端点可查，句柄不进 JSON', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const created = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd() },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    const { taskId } = created.json<{ taskId: string }>();

    const list = await call(plane.port, 'GET', '/v1/tasks', { headers: { authorization: 'Bearer abs_x_y' } });
    expect(list.json<{ tasks: Array<{ taskId: string }> }>().tasks.map((t) => t.taskId)).toContain(taskId);

    const one = await call(plane.port, 'GET', `/v1/tasks/${taskId}`, { headers: { authorization: 'Bearer abs_x_y' } });
    expect(one.status).toBe(200);
    expect(one.body).not.toContain('"handle"');

    const diff = await call(plane.port, 'GET', `/v1/tasks/${taskId}/diff`, { headers: { authorization: 'Bearer abs_x_y' } });
    expect(diff.json<{ changedFiles: string[] }>().changedFiles).toEqual([]);
    plane.close();
  });

  it('已终态再取消 → 200 alreadySettled（幂等，不报错）', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const created = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd() },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    const { taskId } = created.json<{ taskId: string }>();
    const cancel = await call(plane.port, 'POST', `/v1/tasks/${taskId}:cancel`, {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(cancel.status).toBe(200);
    expect(cancel.json<{ alreadySettled?: boolean }>().alreadySettled).toBe(true);
    plane.close();
  });

  it('SSE：订阅后能收到该任务的事件（补发 + 实时）', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const created = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd() },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    const { taskId } = created.json<{ taskId: string }>();

    const chunks = await new Promise<string>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: plane.port, method: 'GET', path: `/v1/tasks/${taskId}/events` },
        (res) => {
          let acc = '';
          res.on('data', (c: Buffer) => {
            acc += c.toString('utf8');
            // 收到终态就够判定了：不在这里死等连接关闭
            if (acc.includes('"status":"success"') || acc.includes('"status": "success"')) {
              req.destroy();
              resolve(acc);
            }
          });
          res.on('end', () => resolve(acc));
        },
      );
      req.on('error', reject);
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve('');
      }, 3000);
    });

    expect(chunks).toContain('event: hello');
    expect(chunks).toContain(taskId);
    plane.close();
  });

  it('Web 面板壳 GET / 免令牌（页面本身不含数据），且内嵌脚本语法合法', async () => {
    const plane = await start();
    const res = await call(plane.port, 'GET', '/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('任务面板');
    // 官网品牌资产与主题色（2026-10-25 用户要求）：同一几何 Logo、同一品牌绿，不再使用 AB 蓝色替代标
    expect(res.body).toContain('<rect x="4" y="10" width="11" height="12" rx="2.5" fill="none" stroke="#1A2029"');
    expect(res.body).toContain('fill="#17A67F"');
    expect(res.body).toContain('--brand:#17A67F');
    expect(res.body).not.toContain('brand-mark">AB');
    // 红线不变：面板壳也不返回 CORS 头
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    // 2026-10-25 白屏事故护栏：模板串转义曾把正则写坏。提取 <script> 做 parse-only 校验
    const m = res.body.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Function(m![1])).not.toThrow();
    plane.close();
  });

  it('/v1/board：无令牌 401；带令牌返回计数 + 容量 + 任务视图（与注册表同源）', async () => {
    const plane = await start({
      verify: (token) => (token ? { ok: true } : { ok: false, reason: 'missing', message: '缺令牌' }),
    });
    const denied = await call(plane.port, 'GET', '/v1/board');
    expect(denied.status).toBe(401);

    const created = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd() },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    const { taskId } = created.json<{ taskId: string }>();

    const board = await call(plane.port, 'GET', '/v1/board', { headers: { authorization: 'Bearer abs_x_y' } });
    expect(board.status).toBe(200);
    const data = board.json<{ counts: { success: number }; capacity: { maxTasks: number }; tasks: Array<{ taskId: string; status: string }> }>();
    expect(data.capacity.maxTasks).toBe(1);
    expect(data.tasks.map((t) => t.taskId)).toContain(taskId);
    expect(data.tasks.find((t) => t.taskId === taskId)?.status).toBe('success');
    expect(data.counts.success).toBe(1);
    plane.close();
  });

  it('?token= 兜底：EventSource 场景可从 query 取令牌（与 Bearer 同口径校验）', async () => {
    const seen: string[] = [];
    const plane = await start({
      verify: (token, _scope) => {
        if (token) seen.push(token);
        return { ok: true };
      },
    });
    const res = await call(plane.port, 'GET', '/v1/board?token=abs_q_uery');
    expect(res.status).toBe(200);
    expect(seen).toContain('abs_q_uery');
    plane.close();
  });

  it('平台任务的 diff 端点从注册表兜底（无控制面 records 也不 404）', async () => {
    const registry = new TaskRegistry();
    const plane = await start({ registry, verify: () => ({ ok: true }) });
    registry.register('platform-task', { agentType: 'claude-code', cwd: process.cwd(), source: 'platform' });
    registry.updateStatus('platform-task', 'success', { diff: 'diff --git a/x b/x', changedFiles: ['x.ts'], diffTruncated: false });
    const res = await call(plane.port, 'GET', '/v1/tasks/platform-task/diff', { headers: { authorization: 'Bearer abs_x_y' } });
    expect(res.status).toBe(200);
    expect(res.json<{ diff: string; changedFiles: string[] }>()).toMatchObject({ diff: 'diff --git a/x b/x', changedFiles: ['x.ts'] });
    plane.close();
  });

  it('步骤时间线端点：未知任务 404；已跟踪任务返回步骤序列', async () => {
    const plane = await start({ verify: () => ({ ok: true }) });
    const missing = await call(plane.port, 'GET', '/v1/tasks/nope/steps', { headers: { authorization: 'Bearer abs_x_y' } });
    expect(missing.status).toBe(404);

    const created = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: process.cwd() },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    const { taskId } = created.json<{ taskId: string }>();
    const steps = await call(plane.port, 'GET', `/v1/tasks/${taskId}/steps`, { headers: { authorization: 'Bearer abs_x_y' } });
    expect(steps.status).toBe(200);
    const data = steps.json<{ taskId: string; status: string; steps: unknown[] }>();
    expect(data.taskId).toBe(taskId);
    expect(data.status).toBe('success');
    expect(Array.isArray(data.steps)).toBe(true);
    plane.close();
  });

  it('文件预览端点：穿越路径 403；存在文件 200 且 content-type 按扩展名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-preview-'));
    writeFileSync(join(dir, 'note.md'), '# 标题\n内容');
    const plane = await start({ verify: () => ({ ok: true }) });
    const created = await call(plane.port, 'POST', '/v1/tasks', {
      body: { agentType: 'codex', cwd: dir },
      headers: { authorization: 'Bearer abs_x_y' },
    });
    const { taskId } = created.json<{ taskId: string }>();

    const escape = await call(plane.port, 'GET', `/v1/tasks/${taskId}/file?path=../../etc/passwd`, {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(escape.status).toBe(403);

    const ok = await call(plane.port, 'GET', `/v1/tasks/${taskId}/file?path=note.md`, {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('text/markdown');
    expect(ok.body).toContain('# 标题');

    const missing = await call(plane.port, 'GET', `/v1/tasks/${taskId}/file?path=nope.txt`, {
      headers: { authorization: 'Bearer abs_x_y' },
    });
    expect(missing.status).toBe(404);
    plane.close();
  });
});

// 收尾：防止有测试漏关导致端口悬挂
process.on('exit', () => {
  for (const p of started) {
    try {
      p.close();
    } catch {
      /* 已关闭 */
    }
  }
});

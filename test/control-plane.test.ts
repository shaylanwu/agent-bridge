/**
 * 本地回环控制面（扩展能力）
 *
 * 取证重点不是"能起服务"，而是那几条**安全红线**真的生效：
 * 默认关闭、只绑回环、不带令牌 401、scope 不足 403、绝不返回 CORS 头、幂等键不重复跑任务。
 */

import { describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { Emitter } from '../src/core/emitter.js';
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
  return {
    emitter,
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

/**
 * `interaction_delivery_unknown` 的语义（spec「响应幂等、限流与审计」/「等待状态、超时与取消」）：
 *
 * 桥接**已经尝试过**把交互响应交给 adapter，但结果无法确认（管道关闭、写入失败、子进程消失）。
 * 这时唯一安全的结论是：**结束回合、禁止重试**。若允许重试，用户可能被重复授权、表单被重复提交。
 *
 * 两层各测一遍：
 *  1. broker 层：`deliver()` 返回 false → 结果码固定为 `interaction_delivery_unknown`，
 *     且后续响应**不得再次交付**（deliver 调用次数不增加）。
 *  2. supervisor 层：`failInteraction()` 必须以该码结算任务，而不是 `agent_error`。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { InteractionBroker } from '../src/core/interaction-broker.js';
import { TaskSupervisor, type TaskFinishInfo, type TaskHandle } from '../src/core/task-supervisor.js';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import type { ClientMessage, InteractionResponseCommand } from '../src/protocol.js';
import type { TaskStatus } from '../src/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 下句柄释放可能滞后；临时目录留给系统清理 */
    }
  });
  return dir;
}

function response(responseId: string, requestId = 'ir_one'): InteractionResponseCommand {
  return {
    type: 'task_interaction_response',
    taskId: 'sess_delivery',
    requestId,
    responseId,
    state: 'accepted',
    payload: { optionId: 'allow' },
  };
}

describe('broker：交付结果不确定', () => {
  function harness(deliver: () => Promise<boolean>) {
    const dir = tempDir('agent-bridge-delivery-');
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => store.close());
    store.createSession({ sessionId: 'sess_delivery', mode: 'task', agentType: 'codebuddy-cli', cwd: dir });
    const sent: ClientMessage[] = [];
    const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
    const deliverMock = vi.fn(deliver);
    const broker = new InteractionBroker();
    broker.bind({ store, emit: (msg) => emitter.emit(msg), deliver: deliverMock });
    broker.open({
      sessionId: 'sess_delivery',
      requestId: 'ir_one',
      kind: 'permission',
      payload: {
        toolCall: { kind: 'execute', title: 'Run' },
        options: [
          { optionId: 'allow', kind: 'allow_once' },
          { optionId: 'deny', kind: 'reject_once' },
        ],
      },
    });
    return { store, broker, deliver: deliverMock, sent };
  }

  it('deliver 返回 false → interaction_delivery_unknown，且不重复交付', async () => {
    const { store, broker, deliver } = harness(async () => false);

    const outcome = await broker.respond(response('rs_1'));
    expect(outcome).toMatchObject({
      ok: false,
      errorCode: 'interaction_delivery_unknown',
      deliveryFailed: true,
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.getInteraction('sess_delivery', 'ir_one')?.state).toBe('failed');

    // 第二次响应（换 responseId）：必须被拒答，绝不重新交付 —— 重复授权比失败更糟
    const again = await broker.respond(response('rs_2'));
    expect(again.deliveryFailed).not.toBe(true);
    expect(again.errorCode).toBeDefined();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('deliver 抛异常按「不确定」处理，不算交付成功', async () => {
    const { broker, deliver } = harness(async () => {
      throw new Error('pipe closed');
    });

    const outcome = await broker.respond(response('rs_throw'));
    expect(outcome).toMatchObject({ errorCode: 'interaction_delivery_unknown', deliveryFailed: true });
    expect(deliver).toHaveBeenCalledTimes(1);
  });
});

describe('supervisor：交付不确定的结算码', () => {
  const FAKE_ACP = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let promptId;
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'native_delivery' } });
  else if (m.method === 'session/prompt') {
    promptId = m.id;
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: 'native_delivery', options: [{ optionId: 'allow', kind: 'allow_once' }],
    }});
  } else if (m.method === 'session/cancel') process.exit(0);
});
`;

  it('failInteraction 以 interaction_delivery_unknown 结算，而不是 agent_error', async () => {
    const dir = tempDir('agent-bridge-delivery-sup-');
    const script = join(dir, 'delivery-acp.cjs');
    writeFileSync(script, FAKE_ACP);

    const def = agentDefOf('codebuddy-cli');
    if (!def) throw new Error('codebuddy-cli 定义缺失');
    const originalBin = def.bin;
    // 安装闸门只认 PATH 上的名字；真正跑的进程由 acpSpec 决定
    def.bin = 'node';

    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => store.close());
    store.createSession({ sessionId: 'task_delivery', mode: 'task', agentType: 'codebuddy-cli', cwd: dir });

    const supervisor = new TaskSupervisor(1);
    const statuses: Array<{ status: TaskStatus; info?: TaskFinishInfo }> = [];
    const flight: InteractionAnswerHolder = {};
    let handle!: TaskHandle;

    supervisor.interactions.bind({
      store,
      emit: () => undefined,
      deliver: (taskId, requestId, answer) => handle.respondInteraction!(requestId, answer),
      onResolved: (taskId, requestId) => supervisor.completeInteraction(taskId, requestId),
      onFailed: (taskId, requestId) => supervisor.failInteraction(taskId, requestId),
    });

    try {
      handle = supervisor.submit(
        {
          taskId: 'task_delivery',
          agentType: 'codebuddy-cli',
          cwd: dir,
          args: [],
          prompt: 'wait for permission',
          interactive: true,
          acp: true,
          acpSpec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
        },
        {
          onLog: () => undefined,
          onStatus: (status, info) => statuses.push({ status, info }),
          onInteraction: (request) => {
            flight.requestId = request.requestId;
            supervisor.interactions.open({
              sessionId: 'task_delivery',
              requestId: request.requestId,
              kind: request.kind,
              payload: request.payload,
              expiresAt: request.expiresAt,
            });
          },
        },
      );

      await vi.waitFor(
        () => {
          if (!flight.requestId) {
            const last = statuses.at(-1);
            throw new Error(`15s 内没有收到 ACP 交互请求；最近状态=${JSON.stringify(last ?? null)}`);
          }
        },
        { timeout: 15_000, interval: 50 },
      );

      // 模拟「已尝试交付但结果无法确认」：直接走 supervisor 的失败结算入口
      supervisor.failInteraction('task_delivery', flight.requestId!);

      await expect(handle.done).resolves.toBe('failed');
      const final = statuses.at(-1);
      expect(final?.status).toBe('failed');
      expect(final?.info?.errorCode).toBe('interaction_delivery_unknown');
      expect(final?.info?.error).toContain('禁止重试');
    } finally {
      def.bin = originalBin;
    }
  }, 40_000);
});

interface InteractionAnswerHolder {
  requestId?: string;
}

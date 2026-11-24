import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { InteractionBroker } from '../src/core/interaction-broker.js';
import { fullResidualPermissionOutcome } from '../src/core/permission-policy.js';
import type { TaskSupervisor, InteractionAnswer } from '../src/core/task-supervisor.js';
import type { ClientMessage, InteractionResponseCommand } from '../src/protocol.js';

/**
 * 交互语义收尾（tasks.md 5.7 / 5.9 / 5.11；spec「等待状态、超时与取消」「响应幂等、限流与审计」）：
 *
 *  - 单次等待到期：options 真实提供 reject_once 才按**原 optionId** 拒绝（回合继续）；
 *    否则以 cancelled outcome 完成请求、结束回合（interaction_timeout）—— 不得伪造 optionId；
 *  - full 残余权限：有 reject_once 选原 optionId；无则 cancelled + 取消回合（interaction_denied）；
 *  - 交互响应审计：记 requestId/responseId/kind/optionId|action/respondedBy/结果，Form content 不落审计。
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

interface Harness {
  store: SessionStore;
  broker: InteractionBroker;
  deliver: ReturnType<typeof vi.fn>;
  onResolved: ReturnType<typeof vi.fn>;
  onFailed: ReturnType<typeof vi.fn>;
  onExpired: ReturnType<typeof vi.fn>;
  sent: ClientMessage[];
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-semantics-'));
  const store = new SessionStore(join(dir, 'state.db'));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  store.createSession({ sessionId: 'sess_sem', mode: 'task', agentType: 'codebuddy-cli', cwd: dir });
  const sent: ClientMessage[] = [];
  const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
  const broker = new InteractionBroker();
  const deliver = vi.fn(async () => true);
  const onResolved = vi.fn();
  const onFailed = vi.fn();
  const onExpired = vi.fn();
  broker.bind({
    store,
    emit: (msg) => emitter.emit(msg),
    deliver: deliver as unknown as (
      taskId: string,
      requestId: string,
      answer?: InteractionAnswer,
    ) => Promise<boolean>,
    onResolved,
    onFailed,
    onExpired,
  });
  return { store, broker, deliver, onResolved, onFailed, onExpired, sent };
}

function openInteraction(
  h: Harness,
  kind: 'permission' | 'form',
  options?: Array<Record<string, unknown>>,
): void {
  h.broker.open({
    sessionId: 'sess_sem',
    requestId: 'ir_sem',
    kind: kind === 'permission' ? 'permission' : 'elicitation',
    payload:
      kind === 'permission'
        ? {
            toolCall: { kind: 'execute', title: 'Run' },
            ...(options ? { options } : {}),
          }
        : { message: '确认吗？', requestedSchema: { type: 'object', properties: {} } },
    expiresAt: new Date(Date.now() + 40).toISOString(),
  });
}

describe('单次交互等待到期（spec：等待状态、超时与取消）', () => {
  it('permission 且 options 提供 reject_once：按原 optionId 拒绝，回合继续（onResolved 恢复）', async () => {
    const h = harness();
    openInteraction(h, 'permission', [
      { optionId: 'allow', kind: 'allow_once', name: '允许' },
      { optionId: 'deny', kind: 'reject_once', name: '拒绝' },
    ]);
    await new Promise((done) => setTimeout(done, 120));
    // 关键断言：deliver 收到的是「选择原 reject_once optionId」，不是 cancel，更不是伪造的选项
    expect(h.deliver).toHaveBeenCalledWith(
      'sess_sem',
      'ir_sem',
      expect.objectContaining({ action: 'accept', optionId: 'deny' }),
    );
    expect(h.store.getInteraction('sess_sem', 'ir_sem')).toMatchObject({ state: 'expired' });
    // 回合继续：expired 后恢复 supervisor Entry，而不是终止
    expect(h.onResolved).toHaveBeenCalledWith('sess_sem', 'ir_sem');
    expect(h.onExpired).not.toHaveBeenCalled();
    expect(h.onFailed).not.toHaveBeenCalled();
  });

  it('permission 无 reject_once：cancelled outcome 完成请求并结束回合（onExpired → interaction_timeout）', async () => {
    const h = harness();
    openInteraction(h, 'permission', [{ optionId: 'allow', kind: 'allow_once', name: '允许' }]);
    await new Promise((done) => setTimeout(done, 120));
    expect(h.deliver).toHaveBeenCalledWith('sess_sem', 'ir_sem', { action: 'cancel' });
    expect(h.onExpired).toHaveBeenCalledWith('sess_sem', 'ir_sem');
    expect(h.onResolved).not.toHaveBeenCalled();
    const result = h.sent.find((m) => m.type === 'task_interaction_result');
    expect(result).toMatchObject({ requestState: 'expired' });
  });

  it('Form 超时映射 cancel：同样结束回合', async () => {
    const h = harness();
    openInteraction(h, 'form');
    await new Promise((done) => setTimeout(done, 120));
    expect(h.deliver).toHaveBeenCalledWith('sess_sem', 'ir_sem', { action: 'cancel' });
    expect(h.onExpired).toHaveBeenCalledWith('sess_sem', 'ir_sem');
  });

  it('超时后迟到响应不恢复（expired 结果稳定重放）', async () => {
    const h = harness();
    openInteraction(h, 'permission', [{ optionId: 'allow', kind: 'allow_once' }]);
    await new Promise((done) => setTimeout(done, 120));
    const late: InteractionResponseCommand = {
      type: 'task_interaction_response',
      taskId: 'sess_sem',
      requestId: 'ir_sem',
      responseId: 'rs_late',
      state: 'accepted',
      payload: { optionId: 'allow' },
    };
    const outcome = await h.broker.respond(late);
    expect(outcome).toMatchObject({ ok: false, errorCode: 'interaction_expired' });
    expect(h.onResolved).not.toHaveBeenCalled();
  });
});

describe('full 残余权限（spec：权限与问题的组合语义）', () => {
  it('options 提供 reject_once：返回其原 optionId（自动拒绝，不转人工）', () => {
    const outcome = fullResidualPermissionOutcome([
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
      { optionId: 'deny', kind: 'reject_once' },
    ]);
    expect(outcome).toEqual({ optionId: 'deny' });
  });

  it('options 不提供 reject_once：fail closed（cancelled + 取消回合），不伪造选项', () => {
    const outcome = fullResidualPermissionOutcome([
      { optionId: 'allow', kind: 'allow_once' },
      { optionId: 'always', kind: 'allow_always' },
    ]);
    expect(outcome).toEqual({ cancel: true });
    expect(outcome).not.toHaveProperty('optionId');
  });

  it('空 options 同样 fail closed', () => {
    expect(fullResidualPermissionOutcome(undefined)).toEqual({ cancel: true });
  });
});

// —— 交互响应审计（5.11）：dispatch 层 ——
const auditMocks = vi.hoisted(() => ({ writeAudit: vi.fn() }));
vi.mock('../src/infra/audit.js', () => ({ writeAudit: auditMocks.writeAudit }));
const runnerMocks = vi.hoisted(() => ({ startTask: vi.fn() }));
vi.mock('../src/runner.js', () => ({ startTask: runnerMocks.startTask }));

describe('交互响应审计（spec：记录 who/what/result，Form content 不落审计）', () => {
  it('permission 响应记录 requestId/responseId/kind/optionId/respondedBy 与结果', async () => {
    const { dispatchInteractionResponse } = await import('../src/app/task-dispatch.js');
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-audit-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    store.createSession({ sessionId: 'sess_audit', mode: 'task', agentType: 'codebuddy-cli', cwd: dir });
    const broker = new InteractionBroker();
    const emitter = new Emitter({ sink: () => undefined });
    broker.bind({
      store,
      emit: (msg) => emitter.emit(msg),
      deliver: async () => true,
    });
    broker.open({
      sessionId: 'sess_audit',
      requestId: 'ir_a1',
      kind: 'permission',
      payload: {
        toolCall: { kind: 'execute', title: 'Run' },
        options: [{ optionId: 'allow', kind: 'allow_once' }],
      },
    });
    auditMocks.writeAudit.mockClear();
    const { TaskRegistry } = await import('../src/app/task-registry.js');
    const outcome = await dispatchInteractionResponse(
      {
        type: 'task_interaction_response',
        taskId: 'sess_audit',
        requestId: 'ir_a1',
        responseId: 'rs_a1',
        state: 'accepted',
        payload: { optionId: 'allow' },
        respondedBy: 'platform-user-1',
      },
      {
        emitter,
        tasks: new Map(),
        registry: new TaskRegistry(),
        maxConcurrent: 5,
        maxQueued: 5,
        diffMaxBytes: 1024,
        captureDiffByDefault: false,
        requireServiceToken: false,
        interactionEnabled: true,
        store,
        interactions: broker,
        log: () => undefined,
      } as Parameters<typeof dispatchInteractionResponse>[1],
    );
    expect(outcome).toMatchObject({ ok: true });
    const entry = auditMocks.writeAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'interaction_response',
      taskId: 'sess_audit',
      requestId: 'ir_a1',
      responseId: 'rs_a1',
      kind: 'permission',
      choice: 'allow',
      requestedBy: 'platform-user-1',
    });
  });

  it('Form 响应只记 action 与字段名，绝不记 content 值', async () => {
    const { dispatchInteractionResponse } = await import('../src/app/task-dispatch.js');
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-audit2-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    store.createSession({ sessionId: 'sess_audit2', mode: 'task', agentType: 'codebuddy-cli', cwd: dir });
    const broker = new InteractionBroker();
    const emitter = new Emitter({ sink: () => undefined });
    broker.bind({ store, emit: (msg) => emitter.emit(msg), deliver: async () => true });
    broker.open({
      sessionId: 'sess_audit2',
      requestId: 'ir_f1',
      kind: 'elicitation',
      payload: {
        message: '要继续吗？',
        requestedSchema: {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
        },
      },
    });
    auditMocks.writeAudit.mockClear();
    const { TaskRegistry } = await import('../src/app/task-registry.js');
    await dispatchInteractionResponse(
      {
        type: 'task_interaction_response',
        taskId: 'sess_audit2',
        requestId: 'ir_f1',
        responseId: 'rs_f1',
        state: 'accepted',
        payload: { content: { note: 'SECRET-FORM-VALUE' } },
        respondedBy: 'local-operator',
      },
      {
        emitter,
        tasks: new Map(),
        registry: new TaskRegistry(),
        maxConcurrent: 5,
        maxQueued: 5,
        diffMaxBytes: 1024,
        captureDiffByDefault: false,
        requireServiceToken: false,
        interactionEnabled: true,
        store,
        interactions: broker,
        log: () => undefined,
      } as Parameters<typeof dispatchInteractionResponse>[1],
    );
    const entry = auditMocks.writeAudit.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(entry).toMatchObject({
      action: 'interaction_response',
      kind: 'elicitation',
      choice: 'accept',
      requestedBy: 'local-operator',
    });
    // 红线：Form content 的值绝不进审计
    const serialized = JSON.stringify(auditMocks.writeAudit.mock.calls.at(-1)?.[0]);
    expect(serialized).not.toContain('SECRET-FORM-VALUE');
  });
});

// TaskSupervisor 类型引用（避免未使用告警的占位导入风格）
export type { TaskSupervisor };

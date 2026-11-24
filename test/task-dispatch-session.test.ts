import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import {
  dispatchCancelTurn,
  dispatchCloseSession,
  dispatchGetTask,
  dispatchInteractionResponse as dispatchInteractionResponseRaw,
  dispatchRunTask,
  type TaskDispatchOptions,
} from '../src/app/task-dispatch.js';
import type { ClientMessage, InteractionResponseCommand } from '../src/protocol.js';
import { TaskSupervisor } from '../src/core/task-supervisor.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function dispatchInteractionResponse(msg: InteractionResponseCommand, options: TaskDispatchOptions) {
  if (!options.interactions) {
    const supervisor = new TaskSupervisor();
    supervisor.interactions.bind({
      store: options.store,
      emit: (msg) => options.emitter.emit(msg),
      deliver: async (taskId, requestId, answer) => {
        const handle = options.tasks.get(taskId);
        return handle?.respondInteraction ? handle.respondInteraction(requestId, answer) : false;
      },
    });
    options.interactions = supervisor.interactions;
  }
  return dispatchInteractionResponseRaw(msg, options);
}

describe('task dispatch → SessionStore', () => {
  it('close_session 鉴权失败不回收常驻进程', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-dispatch-close-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.createSession({
      sessionId: 'bt_close_auth',
      mode: 'conversation',
      agentType: 'claude-code',
      cwd: dir,
      phase: 'waiting_user',
    });
    const sent: ClientMessage[] = [];
    const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
    const close = vi.fn();
    const idleTimer = setTimeout(() => undefined, 10_000);
    const options: TaskDispatchOptions = {
      emitter,
      tasks: new Map(),
      registry: new TaskRegistry(),
      maxConcurrent: 2,
      maxQueued: 2,
      diffMaxBytes: 4096,
      captureDiffByDefault: false,
      requireServiceToken: true,
      store,
      log: () => undefined,
      residentSessions: new Map([['bt_close_auth', { close }]]) as unknown as NonNullable<
        TaskDispatchOptions['residentSessions']
      >,
      idleTimers: new Map([['bt_close_auth', idleTimer]]),
    };

    dispatchCloseSession(
      { type: 'close_session', taskId: 'bt_close_auth', operationId: 'op_no_token' },
      options,
    );
    expect(close).not.toHaveBeenCalled();
    expect(options.idleTimers?.get('bt_close_auth')).toBe(idleTimer);
    expect(store.getSession('bt_close_auth')?.status).toBe('running');

    options.requireServiceToken = false;
    dispatchCloseSession(
      { type: 'close_session', taskId: 'bt_close_auth', operationId: 'op_ok' },
      options,
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(options.idleTimers?.has('bt_close_auth')).toBe(false);
    expect(store.getSession('bt_close_auth')?.status).not.toBe('running');
  });

  it('失败的 run_task 也落 Session/Turn/Event 并关闭会话', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-dispatch-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const sent: ClientMessage[] = [];
    const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
    const options: TaskDispatchOptions = {
      emitter,
      tasks: new Map(),
      registry: new TaskRegistry(),
      maxConcurrent: 2,
      maxQueued: 2,
      diffMaxBytes: 4096,
      captureDiffByDefault: false,
      requireServiceToken: false,
      store,
      log: () => undefined,
    };

    dispatchRunTask(
      {
        type: 'run_task',
        taskId: 'bt_dispatch_failed',
        agentType: 'not-a-real-agent',
        cwd: dir,
        args: [],
      },
      options,
    );

    const snapshot = store.snapshot('bt_dispatch_failed');
    expect(snapshot.session.status).toBe('failed');
    expect(snapshot.session.phase).toBe('settled');
    expect(snapshot.turns[0]?.status).toBe('failed');
    expect(snapshot.events.some((event) => event.type === 'task_status')).toBe(true);
    expect(sent.some((msg) => msg.type === 'task_status' && msg.status === 'failed')).toBe(true);
    expect(store.getTombstone('bt_dispatch_failed')).toBeDefined();

    dispatchGetTask(
      { type: 'get_task', taskId: 'bt_dispatch_failed', requestId: 'req_snapshot' },
      options,
    );
    const snapshotMsg = sent.find((msg) => msg.type === 'task_snapshot');
    expect(snapshotMsg).toMatchObject({
      type: 'task_snapshot',
      taskId: 'bt_dispatch_failed',
      requestId: 'req_snapshot',
      found: true,
    });
    if (snapshotMsg?.type === 'task_snapshot') {
      expect(snapshotMsg.events?.some((event) => event.type === 'task_status')).toBe(true);
      expect(snapshotMsg.latestEventSeq).toBeGreaterThan(0);
    }

    dispatchCloseSession(
      { type: 'close_session', taskId: 'bt_dispatch_failed', operationId: 'op_close' },
      options,
    );
    expect(sent.find((msg) => msg.type === 'session_ack' && msg.action === 'close_session')).toMatchObject({
      ok: true,
      status: 'failed',
    });
  });

  it('交互回复幂等、相同答案 duplicate 并落独立 resultSeq', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-dispatch-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.createSession({ sessionId: 'bt_interaction', mode: 'conversation', agentType: 'codex', cwd: dir });
    store.requestInteraction({
      sessionId: 'bt_interaction',
      requestId: 'ir_1',
      kind: 'permission',
      payload: { title: 'write', options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
    });
    const sent: ClientMessage[] = [];
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) }),
      tasks: new Map(),
      registry: new TaskRegistry(),
      maxConcurrent: 2,
      maxQueued: 2,
      diffMaxBytes: 4096,
      captureDiffByDefault: false,
      requireServiceToken: false,
      store,
      log: () => undefined,
    };
    const respond = vi.fn(() => true);
    options.tasks.set('bt_interaction', {
      taskId: 'bt_interaction',
      cancel: () => undefined,
      done: Promise.resolve('running'),
      respondInteraction: respond,
    });
    const response = {
      type: 'task_interaction_response' as const,
      taskId: 'bt_interaction',
      requestId: 'ir_1',
      responseId: 'resp_1',
      state: 'accepted' as const,
      payload: { optionId: 'allow_once' },
    };

    await dispatchInteractionResponse(response, options);
    expect(store.getInteraction('bt_interaction', 'ir_1')).toMatchObject({
      state: 'resolved',
      responseId: 'resp_1',
    });
    expect(sent.find((msg) => msg.type === 'task_interaction_result')).toMatchObject({
      state: 'accepted',
      resultSeq: expect.any(Number),
    });
    expect(respond).toHaveBeenCalledWith('ir_1', expect.objectContaining({ optionId: 'allow_once' }));

    await dispatchInteractionResponse(response, options);
    expect(sent.filter((msg) => msg.type === 'task_interaction_result')).toHaveLength(2);

    await dispatchInteractionResponse({ ...response, responseId: 'resp_2' }, options);
    expect(sent.at(-1)).toMatchObject({
      type: 'task_interaction_result',
      state: 'accepted',
      requestState: 'resolved',
      responseStatus: 'duplicate',
      resultSeq: 2,
    });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('伪造 optionId 不交付且保留 pending，新 responseId 可修正', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-option-validation-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.createSession({ sessionId: 'bt_option', mode: 'task', agentType: 'codex', cwd: dir });
    store.requestInteraction({
      sessionId: 'bt_option',
      requestId: 'ir_option',
      kind: 'permission',
      payload: { options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
    });
    const sent: ClientMessage[] = [];
    const respond = vi.fn(async () => true);
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) }),
      tasks: new Map([
        ['bt_option', { taskId: 'bt_option', cancel: () => undefined, done: Promise.resolve('running' as const), respondInteraction: respond }],
      ]),
      registry: new TaskRegistry(),
      maxConcurrent: 1,
      maxQueued: 1,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: false,
      store,
      log: () => undefined,
    };
    const response = {
      type: 'task_interaction_response' as const,
      taskId: 'bt_option',
      requestId: 'ir_option',
      responseId: 'resp_invalid_option',
      state: 'accepted' as const,
      payload: { optionId: 'allow_always_not_offered' },
    };
    const invalid = await dispatchInteractionResponse(response, options);
    expect(invalid).toMatchObject({ ok: false, errorCode: 'interaction_invalid_response' });
    expect(respond).not.toHaveBeenCalled();
    expect(store.getInteraction('bt_option', 'ir_option')?.state).toBe('pending');

    const corrected = await dispatchInteractionResponse(
      { ...response, responseId: 'resp_valid_option', payload: { optionId: 'allow_once' } },
      options,
    );
    expect(corrected).toMatchObject({ ok: true, state: 'accepted' });
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('declined/cancelled 即使携带允许选项也绝不交付 optionId', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-no-reverse-approval-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.createSession({ sessionId: 'bt_no_reverse', mode: 'task', agentType: 'codex', cwd: dir });
    for (const state of ['declined', 'cancelled'] as const) {
      store.requestInteraction({
        sessionId: 'bt_no_reverse',
        requestId: `ir_${state}`,
        kind: 'permission',
        payload: { options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
      });
    }
    const respond = vi.fn(async () => true);
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: () => undefined }),
      tasks: new Map([
        ['bt_no_reverse', { taskId: 'bt_no_reverse', cancel: () => undefined, done: Promise.resolve('running' as const), respondInteraction: respond }],
      ]),
      registry: new TaskRegistry(),
      maxConcurrent: 1,
      maxQueued: 1,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: false,
      store,
      log: () => undefined,
    };
    for (const state of ['declined', 'cancelled'] as const) {
      const outcome = await dispatchInteractionResponse(
        {
          type: 'task_interaction_response',
          taskId: 'bt_no_reverse',
          requestId: `ir_${state}`,
          responseId: `resp_${state}`,
          state,
          payload: { optionId: 'allow_once' },
        },
        options,
      );
      expect(outcome).toMatchObject({ ok: true, state });
    }
    expect(respond).toHaveBeenNthCalledWith(
      1,
      'ir_declined',
      expect.objectContaining({ optionId: undefined, action: 'decline' }),
    );
    expect(respond).toHaveBeenNthCalledWith(
      2,
      'ir_cancelled',
      expect.objectContaining({ optionId: undefined, action: 'cancel' }),
    );
  });

  it('adapter 交付失败时禁止 resolved，记录 delivery_unknown 并拒绝后续重试', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-delivery-unknown-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.createSession({ sessionId: 'bt_delivery', mode: 'task', agentType: 'codex', cwd: dir });
    store.requestInteraction({
      sessionId: 'bt_delivery',
      requestId: 'ir_delivery',
      kind: 'permission',
      payload: { options: [{ optionId: 'allow_once', kind: 'allow_once' }] },
    });
    const sent: ClientMessage[] = [];
    const respond = vi.fn(async () => false);
    const cancel = vi.fn();
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) }),
      tasks: new Map([
        ['bt_delivery', { taskId: 'bt_delivery', cancel, done: Promise.resolve('running' as const), respondInteraction: respond }],
      ]),
      registry: new TaskRegistry(),
      maxConcurrent: 1,
      maxQueued: 1,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: false,
      store,
      log: () => undefined,
    };
    const response = {
      type: 'task_interaction_response' as const,
      taskId: 'bt_delivery',
      requestId: 'ir_delivery',
      responseId: 'resp_delivery',
      state: 'accepted' as const,
      payload: { optionId: 'allow_once' },
    };
    const outcome = await dispatchInteractionResponse(response, options);
    expect(outcome).toMatchObject({ ok: false, errorCode: 'interaction_delivery_unknown' });
    expect(store.getInteraction('bt_delivery', 'ir_delivery')).toMatchObject({
      state: 'failed',
      responseId: 'resp_delivery',
      resultSeq: expect.any(Number),
    });
    expect(sent.at(-1)).toMatchObject({
      type: 'task_interaction_result',
      state: 'failed',
      errorCode: 'interaction_delivery_unknown',
    });
    expect(cancel).toHaveBeenCalledTimes(1);

    const retry = await dispatchInteractionResponse(
      { ...response, responseId: 'resp_delivery_retry' },
      options,
    );
    expect(retry).toMatchObject({ ok: false, errorCode: 'interaction_delivery_unknown' });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancel_turn 取消无进程的 active Turn', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-dispatch-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.createSession({ sessionId: 'bt_turn', mode: 'task', agentType: 'codex', cwd: dir });
    const turn = store.createTurn({ sessionId: 'bt_turn', status: 'running' });
    const sent: ClientMessage[] = [];
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) }),
      tasks: new Map(),
      registry: new TaskRegistry(),
      maxConcurrent: 2,
      maxQueued: 2,
      diffMaxBytes: 4096,
      captureDiffByDefault: false,
      requireServiceToken: false,
      store,
      log: () => undefined,
    };

    dispatchCancelTurn(
      {
        type: 'cancel_turn',
        taskId: 'bt_turn',
        turnId: turn.turnId,
        operationId: 'op_cancel_turn',
      },
      options,
    );

    expect(store.getTurn('bt_turn', turn.turnId)?.status).toBe('cancelled');
    expect(sent.find((msg) => msg.type === 'session_ack' && msg.action === 'cancel_turn')).toMatchObject({
      ok: true,
      status: 'cancelled',
    });
  });
});

describe('Form interaction result redaction', () => {
  it('content 只回送任务句柄，不落库/不进入 result 报文', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-form-dispatch-'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const store = new SessionStore(join(dir, 'state.db'));
    store.createSession({ sessionId: 'bt_form', mode: 'task', agentType: 'codebuddy', cwd: dir });
    store.requestInteraction({
      sessionId: 'bt_form',
      requestId: 'ir_form',
      kind: 'form',
      payload: {
        message: 'Pick env',
        requestedSchema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
      },
    });
    const sent: ClientMessage[] = [];
    const respond = vi.fn(() => true);
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) }),
      tasks: new Map([
        [
          'bt_form',
          {
            taskId: 'bt_form',
            cancel: () => undefined,
            done: Promise.resolve('running' as const),
            respondInteraction: respond,
          },
        ],
      ]),
      registry: new TaskRegistry(),
      maxConcurrent: 1,
      maxQueued: 1,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: false,
      store,
      log: () => undefined,
    };
    await dispatchInteractionResponse(
      {
        type: 'task_interaction_response',
        taskId: 'bt_form',
        requestId: 'ir_form',
        responseId: 'resp_form',
        state: 'accepted',
        payload: { content: { env: 'staging' } },
      },
      options,
    );
    expect(respond).toHaveBeenCalledWith(
      'ir_form',
      expect.objectContaining({ action: 'accept', content: { env: 'staging' } }),
    );
    const result = sent.find((msg) => msg.type === 'task_interaction_result') as
      | { resultPayload?: Record<string, unknown> }
      | undefined;
    expect(result?.resultPayload).toEqual({ action: 'accept', fieldNames: ['env'] });
    const stored = store.getInteraction('bt_form', 'ir_form');
    expect(stored?.resultPayload).toEqual({ action: 'accept', fieldNames: ['env'] });

    // 同一 responseId 重放：返回已结算结果，不重复调用任务句柄，也不回显 content
    await dispatchInteractionResponse(
      {
        type: 'task_interaction_response',
        taskId: 'bt_form',
        requestId: 'ir_form',
        responseId: 'resp_form',
        state: 'accepted',
        payload: { content: { env: 'staging' } },
      },
      options,
    );
    expect(respond).toHaveBeenCalledTimes(1);
    const replay = sent
      .filter((msg) => msg.type === 'task_interaction_result')
      .at(-1) as { resultPayload?: Record<string, unknown> } | undefined;
    expect(replay?.resultPayload).toEqual({ action: 'accept', fieldNames: ['env'] });
  });
});

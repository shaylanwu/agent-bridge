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
  dispatchInteractionResponse,
  dispatchRunTask,
  type TaskDispatchOptions,
} from '../src/app/task-dispatch.js';
import type { ClientMessage } from '../src/protocol.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe('task dispatch → SessionStore', () => {
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

  it('交互回复幂等、冲突拒绝并落 resultSeq', () => {
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
      payload: { title: 'write' },
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

    dispatchInteractionResponse(response, options);
    expect(store.getInteraction('bt_interaction', 'ir_1')).toMatchObject({
      state: 'accepted',
      responseId: 'resp_1',
    });
    expect(sent.find((msg) => msg.type === 'task_interaction_result')).toMatchObject({
      state: 'accepted',
      resultSeq: expect.any(Number),
    });
    expect(respond).toHaveBeenCalledWith('ir_1', 'allow_once');

    dispatchInteractionResponse(response, options);
    expect(sent.filter((msg) => msg.type === 'task_interaction_result')).toHaveLength(2);

    dispatchInteractionResponse({ ...response, responseId: 'resp_2' }, options);
    expect(sent.at(-1)).toMatchObject({
      type: 'task_interaction_result',
      state: 'failed',
      errorCode: 'interaction_already_resolved',
    });
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

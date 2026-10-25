import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import {
  dispatchGetTask,
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
  });
});

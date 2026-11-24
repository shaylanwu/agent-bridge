import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import type { TaskDispatchOptions } from '../src/app/task-dispatch.js';
import type { ClientMessage } from '../src/protocol.js';

const runnerMocks = vi.hoisted(() => ({ startTask: vi.fn() }));
vi.mock('../src/runner.js', () => ({ startTask: runnerMocks.startTask }));
const { dispatchRunTask } = await import('../src/app/task-dispatch.js');

const cleanups: Array<() => void> = [];
afterEach(() => {
  runnerMocks.startTask.mockReset();
  for (const fn of cleanups.splice(0)) fn();
});

describe('run_task 权限模式与执行通道选择', () => {
  it('非交互 full 选择 headless；full+交互保留不支持通道供 supervisor 拒绝；default 不改变', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-dispatch-mode-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    runnerMocks.startTask.mockImplementation((req) => ({
      taskId: req.taskId,
      cancel: () => undefined,
      done: Promise.resolve('success' as const),
    }));
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: () => undefined }),
      tasks: new Map(),
      registry: new TaskRegistry(),
      maxConcurrent: 5,
      maxQueued: 5,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: false,
      interactionEnabled: true,
      permissionPolicy: 'allow-full',
      store,
      log: () => undefined,
    };
    const run = (
      taskId: string,
      agentType: string,
      permissionMode: 'default' | 'full' | undefined,
      allowInteractive = false,
    ): void => {
      dispatchRunTask(
        { type: 'run_task', taskId, agentType, cwd: dir, args: [], prompt: 'hi', permissionMode, allowInteractive },
        options,
      );
    };

    run('t_full_acp', 'ds-harness', 'full');
    run('t_full_codex', 'codex', 'full');
    options.permissionPolicy = 'full';
    run('t_policy_full', 'ds-harness', undefined);
    run('t_full_interactive', 'ds-harness', 'full', true);
    options.permissionPolicy = 'allow-full';
    run('t_default_acp', 'ds-harness', 'default');

    const request = (taskId: string): Record<string, unknown> =>
      runnerMocks.startTask.mock.calls.find((call) => call[0].taskId === taskId)?.[0] as Record<string, unknown>;
    expect(request('t_full_acp')['acp']).toBe(false);
    expect(request('t_full_codex')['appServer']).toBe(false);
    expect(request('t_policy_full')['acp']).toBe(false);
    expect(request('t_full_interactive')['acp']).toBe(true);
    expect(request('t_default_acp')['acp']).toBe(true);
  });

  it('同步拒绝以 SQLite 终态为权威：同 ID 改参重发不重新执行，并回放原始终态', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-dispatch-reject-'));
    let store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const sent: ClientMessage[] = [];
    runnerMocks.startTask.mockImplementation((req, hooks) => {
      hooks.onStatus('failed', {
        error: '首次权限拒绝',
        errorCode: 'permission_policy_denied',
      });
      return {
        taskId: req.taskId,
        cancel: () => undefined,
        done: Promise.resolve('failed' as const),
      };
    });
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) }),
      tasks: new Map(),
      registry: new TaskRegistry(),
      maxConcurrent: 5,
      maxQueued: 5,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: false,
      permissionPolicy: 'default',
      store,
      log: () => undefined,
    };
    const first = {
      type: 'run_task' as const,
      taskId: 't_reject_idempotent',
      agentType: 'agy',
      cwd: dir,
      args: [] as string[],
      prompt: 'first',
      permissionMode: 'full' as const,
    };
    dispatchRunTask(first, options);
    dispatchRunTask(
      { ...first, args: ['--changed'], prompt: 'changed', permissionMode: 'default' },
      options,
    );

    expect(runnerMocks.startTask).toHaveBeenCalledTimes(1);
    const terminal = sent.filter(
      (msg): msg is Extract<ClientMessage, { type: 'task_status' }> =>
        msg.type === 'task_status' && msg.taskId === first.taskId && msg.status === 'failed',
    );
    expect(terminal).toHaveLength(2);
    expect(terminal[1]).toMatchObject({
      error: '首次权限拒绝',
      errorCode: 'permission_policy_denied',
      eventSeq: terminal[0]?.eventSeq,
    });

    // 模拟进程重启：清空所有内存句柄和 Emitter，仍须从 SQLite 回放同一拒绝。
    store.close();
    store = new SessionStore(join(dir, 'state.db'));
    const restartedSent: ClientMessage[] = [];
    dispatchRunTask(
      { ...first, args: ['--after-restart'], permissionMode: 'default' },
      {
        ...options,
        emitter: new Emitter({ sink: (msg) => restartedSent.push(msg as ClientMessage) }),
        tasks: new Map(),
        store,
      },
    );
    expect(runnerMocks.startTask).toHaveBeenCalledTimes(1);
    expect(restartedSent).toHaveLength(1);
    expect(restartedSent[0]).toMatchObject({
      type: 'task_status',
      status: 'failed',
      error: '首次权限拒绝',
      errorCode: 'permission_policy_denied',
      eventSeq: terminal[0]?.eventSeq,
    });
    expect(store.getSession(first.taskId)).toMatchObject({ status: 'failed', phase: 'settled' });
  });

  it('queued Turn 恢复使用持久参数，认领后重复恢复不再次执行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-recovery-dispatch-'));
    const store = new SessionStore(join(dir, 'state.db'));
    cleanups.push(() => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    store.createSession({ sessionId: 't_recover', mode: 'task', agentType: 'agy', cwd: dir, phase: 'queued' });
    const turn = store.createTurn({
      sessionId: 't_recover',
      status: 'queued',
      execution: { args: [], prompt: 'from sqlite', timeoutMs: 5000, permissionMode: 'default' },
    });
    runnerMocks.startTask.mockImplementation((req, hooks) => {
      if (!hooks.onBeforeLaunch?.()) throw new Error('launch gate refused');
      hooks.onStatus('running', { phase: 'running' });
      hooks.onStatus('success', { exitCode: 0 });
      return { taskId: req.taskId, cancel: () => undefined, done: Promise.resolve('success' as const) };
    });
    const options: TaskDispatchOptions = {
      emitter: new Emitter({ sink: () => undefined }),
      tasks: new Map(),
      registry: new TaskRegistry(),
      maxConcurrent: 1,
      maxQueued: 1,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: true,
      store,
      log: () => undefined,
    };
    const msg = {
      type: 'run_task' as const,
      taskId: 't_recover',
      agentType: 'agy',
      cwd: dir,
      args: [] as string[],
      prompt: 'from sqlite',
      timeoutMs: 5000,
      permissionMode: 'default' as const,
    };
    dispatchRunTask(msg, options, turn.turnId);
    dispatchRunTask(msg, options, turn.turnId);
    expect(runnerMocks.startTask).toHaveBeenCalledTimes(1);
    expect(runnerMocks.startTask.mock.calls[0]?.[0]).toMatchObject({ prompt: 'from sqlite', timeoutMs: 5000 });
    expect(store.getTurn('t_recover', turn.turnId)?.status).toBe('success');
  });
});

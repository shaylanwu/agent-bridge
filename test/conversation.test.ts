import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import type { ClientMessage } from '../src/protocol.js';

const runnerMocks = vi.hoisted(() => ({ startTask: vi.fn() }));
vi.mock('../src/runner.js', () => ({ startTask: runnerMocks.startTask }));

const { dispatchConversationMessage, dispatchConversationRun } = await import(
  '../src/app/conversation.js'
);

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  runnerMocks.startTask.mockReset();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-conversation-'));
  const store = new SessionStore(join(dir, 'state.db'));
  const sent: ClientMessage[] = [];
  const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  runnerMocks.startTask.mockImplementation((req, hooks) => {
    hooks.onStatus('success', { exitCode: 0, result: `answer:${req.prompt?.split('\n').at(-1) ?? ''}` });
    return {
      taskId: req.taskId,
      cancel: () => undefined,
      done: Promise.resolve('success' as const),
    };
  });
  return {
    store,
    emitter,
    sent,
    deps: {
      emitter,
      tasks: new Map(),
      registry: new TaskRegistry(),
      store,
      maxConcurrent: 2,
      maxQueued: 2,
      diffMaxBytes: 1024,
      captureDiffByDefault: false,
      requireServiceToken: false,
      log: () => undefined,
    },
  };
}

describe('conversation turns', () => {
  it('创建 conversation 后 Turn 成功回到 waiting_user', () => {
    const { store, sent, deps } = setup();
    dispatchConversationRun(
      {
        type: 'run_task',
        taskId: 'bt_conv_run',
        agentType: 'codex',
        cwd: '/tmp/work',
        args: [],
        prompt: 'hello',
        sessionMode: 'conversation',
      },
      deps,
    );

    expect(store.getSession('bt_conv_run')).toMatchObject({
      mode: 'conversation',
      status: 'running',
      phase: 'waiting_user',
    });
    expect(store.listMessages('bt_conv_run').map((m) => m.role)).toEqual(['user', 'agent']);
    expect(sent.some((m) => m.type === 'task_status' && m.phase === 'waiting_user')).toBe(true);
  });

  it('send_message 持久化 user message、回 ack，并启动下一 Turn', () => {
    const { store, sent, deps } = setup();
    store.createSession({
      sessionId: 'bt_conv_msg',
      mode: 'conversation',
      agentType: 'codex',
      cwd: '/tmp/work',
      phase: 'waiting_user',
    });

    dispatchConversationMessage(
      {
        type: 'send_message',
        taskId: 'bt_conv_msg',
        messageId: 'msg_1',
        parts: [{ kind: 'text', text: 'second turn' }],
      },
      deps,
    );

    expect(sent.find((m) => m.type === 'message_ack')).toMatchObject({
      messageId: 'msg_1',
      delivery: 'queued',
    });
    expect(store.listMessages('bt_conv_msg').map((m) => m.role)).toEqual(['user', 'agent']);
    expect(store.getSession('bt_conv_msg')?.phase).toBe('waiting_user');
    expect(runnerMocks.startTask).toHaveBeenCalledTimes(1);
  });

  it('同 messageId 重发回 duplicate，不重复起 Turn', () => {
    const { store, sent, deps } = setup();
    store.createSession({
      sessionId: 'bt_conv_dup',
      mode: 'conversation',
      agentType: 'codex',
      cwd: '/tmp/work',
      phase: 'waiting_user',
    });
    const msg = {
      type: 'send_message' as const,
      taskId: 'bt_conv_dup',
      messageId: 'msg_dup',
      parts: [{ kind: 'text' as const, text: 'only once' }],
    };

    dispatchConversationMessage(msg, deps);
    // Turn 已进入 waiting_user 后可重发同一 messageId；这里模拟客户端重试。
    dispatchConversationMessage(msg, deps);

    const acks = sent.filter((m) => m.type === 'message_ack');
    expect(acks.at(-1)).toMatchObject({ delivery: 'duplicate', messageId: 'msg_dup' });
    expect(runnerMocks.startTask).toHaveBeenCalledTimes(1);

    dispatchConversationMessage(
      { ...msg, parts: [{ kind: 'text', text: 'different' }] },
      deps,
    );
    expect(sent.at(-1)).toMatchObject({
      type: 'message_ack',
      delivery: 'rejected',
      errorCode: 'message_conflict',
    });
    expect(runnerMocks.startTask).toHaveBeenCalledTimes(1);
  });
});

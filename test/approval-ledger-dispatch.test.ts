/**
 * 持久授权账本的**接线**测试（不是纯函数测试）。
 *
 * 纯函数测的是「规则对不对」，这里测的是「规则真的接在链路上」：
 * 人工响应 → 落库 → 后续同指纹请求自动命中 → 撤销后不再命中。
 * 这条链断在哪一环，用户都会看到「明明点过永久允许，下次还问」或者更糟的
 * 「点过拒绝，下次却自己批准了」。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskRegistry } from '../src/app/task-registry.js';
import {
  dispatchInteractionResponse,
  resolveApproval,
  type TaskDispatchOptions,
} from '../src/app/task-dispatch.js';
import type { ClientMessage } from '../src/protocol.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const TASK = 'bt_approval_1';
const REQUEST = 'ir_approval_1';

/** ACP 权限请求的典型形状：工具类别 + 命令首词 */
const TOOL_CALL = { kind: 'execute', title: '跑测试', rawInput: { command: 'npm test' } };
const OPTIONS = [
  { optionId: 'once', kind: 'allow_once', name: '允许一次' },
  { optionId: 'always', kind: 'allow_always', name: '总是允许' },
  { optionId: 'no', kind: 'reject_once', name: '拒绝' },
];

function setup(overrides: Partial<TaskDispatchOptions> = {}): {
  store: SessionStore;
  o: TaskDispatchOptions;
  responded: Array<{ requestId: string; answer?: unknown }>;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-approval-'));
  const store = new SessionStore(join(dir, 'state.db'));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.createSession({ sessionId: TASK, mode: 'task', agentType: 'codebuddy-cli', cwd: dir });
  store.requestInteraction({
    sessionId: TASK,
    requestId: REQUEST,
    kind: 'permission',
    payload: { toolCall: TOOL_CALL, options: OPTIONS },
  });

  const responded: Array<{ requestId: string; answer?: unknown }> = [];
  const tasks = new Map([
    [
      TASK,
      {
        taskId: TASK,
        respondInteraction: (requestId: string, answer?: unknown) => {
          responded.push({ requestId, answer });
          return true;
        },
      },
    ],
  ]) as unknown as TaskDispatchOptions['tasks'];

  const o: TaskDispatchOptions = {
    emitter: new Emitter({ sink: (msg) => void (msg as ClientMessage) }),
    tasks,
    registry: new TaskRegistry(),
    maxConcurrent: 2,
    maxQueued: 2,
    diffMaxBytes: 4096,
    captureDiffByDefault: false,
    requireServiceToken: false,
    store,
    log: () => undefined,
    // 单测里跳过令牌校验：真实路径要求 approval:persist，这里单独用一个用例验证它确实拦得住
    approvalLedger: { enabled: true, tenantId: 'default', ttlMs: 60_000, requirePersistScope: false },
    ...overrides,
  };
  return { store, o, responded, dir };
}

function answer(o: TaskDispatchOptions, optionId: string): void {
  dispatchInteractionResponse(
    {
      type: 'task_interaction_response',
      taskId: TASK,
      requestId: REQUEST,
      responseId: 'rs_1',
      state: 'accepted',
      payload: { optionId },
    },
    o,
  );
}

describe('持久授权：写入链路', () => {
  it('选 allow_always 才落库，并把原始 optionId 回给适配器', () => {
    const { store, o, responded } = setup();
    answer(o, 'always');
    const rows = store.listApprovals('default');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agentType).toBe('codebuddy-cli');
    expect(rows[0]?.tool).toBe('execute');
    expect(rows[0]?.scope).toBe('allow_always');
    expect(rows[0]?.expiresAt).toBeDefined();
    // 适配器拿到的仍是它自己提供的 optionId，不能是编出来的
    expect(responded[0]?.answer).toMatchObject({ optionId: 'always' });
  });

  it('选 allow_once 不落库（不得把一次性同意升级成永久）', () => {
    const { store, o } = setup();
    answer(o, 'once');
    expect(store.listApprovals('default')).toHaveLength(0);
  });

  it('拒绝不落库', () => {
    const { store, o } = setup();
    dispatchInteractionResponse(
      {
        type: 'task_interaction_response',
        taskId: TASK,
        requestId: REQUEST,
        responseId: 'rs_2',
        state: 'declined',
      },
      o,
    );
    expect(store.listApprovals('default')).toHaveLength(0);
  });

  it('账本关闭时不落库', () => {
    const { store, o } = setup({
      approvalLedger: { enabled: false, tenantId: 'default', ttlMs: 60_000, requirePersistScope: false },
    });
    answer(o, 'always');
    expect(store.listApprovals('default')).toHaveLength(0);
  });

  it('要求 approval:persist 且响应方没有令牌时，不落库（未鉴权不能授权未来）', () => {
    const { store, o } = setup({
      approvalLedger: { enabled: true, tenantId: 'default', ttlMs: 60_000, requirePersistScope: true },
    });
    answer(o, 'always');
    expect(store.listApprovals('default')).toHaveLength(0);
  });
});

describe('持久授权：命中链路', () => {
  it('同一 toolCall 在 default 模式下自动批准', () => {
    const { o, dir } = setup();
    answer(o, 'always');
    const hit = resolveApproval(
      o,
      {
        agentType: 'codebuddy-cli',
        cwd: dir,
        permissionMode: 'default',
        toolCall: TOOL_CALL,
        options: OPTIONS,
      },
      TASK,
    );
    expect(hit?.optionId).toBe('always');
    expect(hit?.approvalId).toMatch(/^ap_/);
  });

  it('full 模式永不命中', () => {
    const { o, dir } = setup();
    answer(o, 'always');
    const hit = resolveApproval(
      o,
      {
        agentType: 'codebuddy-cli',
        cwd: dir,
        permissionMode: 'full',
        toolCall: TOOL_CALL,
        options: OPTIONS,
      },
      TASK,
    );
    expect(hit).toBeUndefined();
  });

  it('请求只提供 allow_once 时不命中（不能构造不存在的持久选项）', () => {
    const { o, dir } = setup();
    answer(o, 'always');
    const hit = resolveApproval(
      o,
      {
        agentType: 'codebuddy-cli',
        cwd: dir,
        permissionMode: 'default',
        toolCall: TOOL_CALL,
        options: [{ optionId: 'once', kind: 'allow_once', name: '允许一次' }],
      },
      TASK,
    );
    expect(hit).toBeUndefined();
  });

  it('资源不同则不命中（同工具不同命令不共享授权）', () => {
    const { o, dir } = setup();
    answer(o, 'always');
    const hit = resolveApproval(
      o,
      {
        agentType: 'codebuddy-cli',
        cwd: dir,
        permissionMode: 'default',
        toolCall: { kind: 'execute', rawInput: { command: 'rm -rf build' } },
        options: OPTIONS,
      },
      TASK,
    );
    expect(hit).toBeUndefined();
  });

  it('撤销后立即失效', () => {
    const { store, o, dir } = setup();
    answer(o, 'always');
    const [row] = store.listApprovals('default');
    expect(row).toBeDefined();
    store.revokeApproval('default', row!.approvalId);
    const hit = resolveApproval(
      o,
      {
        agentType: 'codebuddy-cli',
        cwd: dir,
        permissionMode: 'default',
        toolCall: TOOL_CALL,
        options: OPTIONS,
      },
      TASK,
    );
    expect(hit).toBeUndefined();
  });

  it('账本关闭时不查（即使表里有记录）', () => {
    const { store, o, dir } = setup();
    answer(o, 'always');
    expect(store.listApprovals('default')).toHaveLength(1);
    const hit = resolveApproval(
      { ...o, approvalLedger: { enabled: false, tenantId: 'default', ttlMs: 60_000 } },
      {
        agentType: 'codebuddy-cli',
        cwd: dir,
        permissionMode: 'default',
        toolCall: TOOL_CALL,
        options: OPTIONS,
      },
      TASK,
    );
    expect(hit).toBeUndefined();
  });
});

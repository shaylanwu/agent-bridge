import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import type { TaskFinishInfo } from '../src/core/task-supervisor.js';
import type { TaskStatus } from '../src/protocol.js';

/**
 * 结算层的 `context_exhausted` 改判（tasks.md 2.2 / 2.3）。
 *
 * 判定口径：`settle()` 是各通道唯一的终态漏斗，只有 `failed + agent_error` 才会被改判，
 * 且必须命中 CLI 自己给出的超限文本（`info.error` 或输出尾部）。
 *
 * 为什么用 fake child：要构造「headless 退出码 1 + stderr 带超限文案」这个组合，
 * 真进程做不到（真有这个报错得真把模型上下文塞爆）。fake child 只模拟
 * supervisor 用到的表面：stdout/stderr 的 data 订阅、error/close、kill。
 */
const cpMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: cpMocks.spawn as unknown as typeof actual.spawn };
});

const { TaskSupervisor } = await import('../src/core/task-supervisor.js');

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

const restores: Array<() => void> = [];
afterEach(() => {
  for (const fn of restores.splice(0)) fn();
  cpMocks.spawn.mockReset();
});

/** kimi-code 的 bin 改成 node（spawn 已 mock，argv 只是占位） */
function stubAgent(): void {
  const def = agentDefOf('kimi-code');
  if (!def) throw new Error('kimi-code 定义缺失');
  const before = { bin: def.bin, taskArgs: def.taskArgs, steps: def.steps, authGuard: def.authGuard };
  def.bin = 'node';
  def.taskArgs = ['--fake'];
  def.steps = undefined;
  (def as { authGuard?: unknown }).authGuard = undefined;
  restores.push(() => {
    def.bin = before.bin;
    def.taskArgs = before.taskArgs;
    def.steps = before.steps;
    (def as { authGuard?: unknown }).authGuard = before.authGuard;
  });
}

function nextChild(): FakeChild {
  const child = new FakeChild();
  cpMocks.spawn.mockReturnValueOnce(child as never);
  return child;
}

interface Recorder {
  infos: TaskFinishInfo[];
  handle: { done: Promise<TaskStatus> };
}

function submit(sv: TaskSupervisor, taskId: string): Recorder {
  const rec: Recorder = {
    infos: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: undefined as any,
  };
  const handle = sv.submit(
    { taskId, agentType: 'kimi-code', cwd: join(tmpdir()), args: [] },
    {
      onLog: () => undefined,
      onStatus: (_status, info) => {
        if (info) rec.infos.push(info);
      },
    },
  );
  rec.handle = { done: handle.done };
  return rec;
}

describe('settle：上下文超限改判为 context_exhausted', () => {
  it('stderr 带超限文案 + 退出码 1 → failed + context_exhausted，error 保留 CLI 原文', async () => {
    stubAgent();
    const sv = new TaskSupervisor();
    const child = nextChild();
    const rec = submit(sv, 't_ctx_overflow');

    child.stderr.emit(
      'data',
      Buffer.from(
        'API Error: 400 {"error":{"message":"prompt is too long: 213456 tokens > 200000 maximum"}}\n',
      ),
    );
    child.emit('close', 1);

    await expect(rec.handle.done).resolves.toBe('failed');
    const info = rec.infos.at(-1);
    expect(info?.errorCode).toBe('context_exhausted');
    // 人类可读文案不被覆盖：用户要看到 CLI 原话才知道到底装了多少 token
    expect(info?.error).toBe('CLI 退出码 1');
  });

  it('tail 只保留最后 2 KiB：早期噪音里的 context 不会污染判定', async () => {
    stubAgent();
    const sv = new TaskSupervisor();
    const child = nextChild();
    const rec = submit(sv, 't_ctx_tail_trim');

    // 早期一行是无关的 gRPC 超时（含 context 字样），随后被大量输出挤出尾部
    child.stderr.emit('data', Buffer.from('rpc error: context deadline exceeded\n'));
    child.stderr.emit('data', Buffer.from('x'.repeat(4096) + '\n'));
    child.emit('close', 1);

    await expect(rec.handle.done).resolves.toBe('failed');
    expect(rec.infos.at(-1)?.errorCode).toBe('agent_error');
  });
});

describe('settle：必须维持 agent_error 的失败', () => {
  it('认证失败不误判', async () => {
    stubAgent();
    const sv = new TaskSupervisor();
    const child = nextChild();
    const rec = submit(sv, 't_ctx_auth');

    child.stderr.emit('data', Buffer.from('401 Unauthorized: invalid api key\n'));
    child.emit('close', 1);

    await expect(rec.handle.done).resolves.toBe('failed');
    expect(rec.infos.at(-1)?.errorCode).toBe('agent_error');
  });

  it('额度用尽不误判', async () => {
    stubAgent();
    const sv = new TaskSupervisor();
    const child = nextChild();
    const rec = submit(sv, 't_ctx_quota');

    child.stderr.emit('data', Buffer.from('You exceeded your current quota, please check your plan\n'));
    child.emit('close', 1);

    await expect(rec.handle.done).resolves.toBe('failed');
    expect(rec.infos.at(-1)?.errorCode).toBe('agent_error');
  });

  it('成功路径不被分类器影响', async () => {
    stubAgent();
    const sv = new TaskSupervisor();
    const child = nextChild();
    const rec = submit(sv, 't_ctx_success');

    // 即便日志里出现超限字样，退出码 0 仍然是 success（分类器只在 failed 分支生效）
    child.stderr.emit('data', Buffer.from('prompt is too long: 213456 tokens\n'));
    child.emit('close', 0);

    await expect(rec.handle.done).resolves.toBe('success');
    expect(rec.infos.at(-1)?.errorCode).toBeUndefined();
  });
});

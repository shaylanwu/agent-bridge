import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import type { TaskStatus } from '../src/protocol.js';

/**
 * 终态后的调度器行为（tasks.md 3.3 / 3.4 的回归层）：
 *
 *  1. **源头断绝**：settle 之后子进程的残余输出（stderr 噪音、迟到 stdout JSON）
 *     不得再经 hooks.onLog / onStep / onSession 上行 ——「拒绝终态后 log/step」
 *     的第一道闸门在调度器，Emitter.settled 只是纵深防御。
 *  2. **SQLite 唯一权威**：终态在 hooks.onStatus 同步落库（生产 = SQLite）后，
 *     内存跟踪条目立即回收 —— 内存只保留活跃任务，不再有 MAX_TRACKED 静默淘汰；
 *     同 taskId 重发的幂等由调度入口的 SQLite 前置检查负责。
 *
 * 为什么 mock spawn：要构造「settle **之后**子进程仍有输出」的窗口。
 * 真实进程在 Windows 上 kill 即同步终止、close 前的输出本就合法 —— 竞态窗口
 * 只在 authGuard 命中（kill 与 settle 同步连发、kill 生效前残余 data 已入队）这类
 * 路径上真实存在，却无法用真进程稳定复现。fake child 把 data 回调的时序变成 100% 确定。
 */
const cpMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: cpMocks.spawn as unknown as typeof actual.spawn };
});

const { TaskSupervisor } = await import('../src/core/task-supervisor.js');

/** 只实现 supervisor 用到的表面：stdout/stderr 的 data 订阅、error/close、kill */
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

interface StubDef {
  authGuard?: { patterns: RegExp[]; hint: string };
  steps?: string;
}

/** kimi-code 的 bin 指向 node、argv 交给假参数；spawn 本身已被 mock，argv 只是占位 */
function stubAgent(extra: StubDef = {}): void {
  const def = agentDefOf('kimi-code');
  if (!def) throw new Error('kimi-code 定义缺失');
  const before = {
    bin: def.bin,
    taskArgs: def.taskArgs,
    steps: def.steps,
    authGuard: def.authGuard,
  } as const;
  def.bin = 'node';
  def.taskArgs = ['--fake'];
  def.steps = (extra.steps as typeof def.steps) ?? undefined;
  if (extra.authGuard) {
    (def as { authGuard?: unknown }).authGuard = extra.authGuard;
  } else {
    (def as { authGuard?: unknown }).authGuard = undefined;
  }
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
  logs: string[];
  steps: Array<{ action: string; state: string }>;
  statuses: TaskStatus[];
  handle: { done: Promise<TaskStatus>; cancel: () => void };
}

function submit(sv: TaskSupervisor, taskId: string): Recorder {
  const rec: Recorder = {
    logs: [],
    steps: [],
    statuses: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: undefined as any,
  };
  const handle = sv.submit(
    { taskId, agentType: 'kimi-code', cwd: join(tmpdir()), args: [] },
    {
      onLog: (_stream, data) => rec.logs.push(data),
      onStep: (step) => rec.steps.push({ action: step.action, state: step.state }),
      onStatus: (status) => rec.statuses.push(status),
    },
  );
  rec.handle = { done: handle.done, cancel: () => handle.cancel() };
  return rec;
}

describe('终态后的调度器（源头断绝 + SQLite 唯一权威）', () => {
  it('authGuard 命中同步 settle 后，迟到 stderr/stdout 不再上行 log/step/session', async () => {
    stubAgent({
      steps: 'claude-json',
      authGuard: { patterns: [/AUTH NOW/], hint: '未登录' },
    });
    const sv = new TaskSupervisor();
    const child = nextChild();
    const rec = submit(sv, 't_guard_late_output');

    // 1) 首条 stderr：authGuard 命中前必须正常上行（守卫不能误伤终态前的输出）
    child.stderr.emit('data', Buffer.from('AUTH NOW: please login\n'));
    expect(rec.logs.some((line) => line.includes('AUTH NOW'))).toBe(true);

    // 此刻任务应已同步结算为 tool_no_credentials
    await expect(rec.handle.done).resolves.toBe('failed');
    expect(rec.statuses.at(-1)).toBe('failed');

    const logsAfterSettle = rec.logs.length;
    const stepsAfterSettle = rec.steps.length;

    // 2) settle 之后的残余输出（kill 生效前已入队的数据）—— 不得再上行
    child.stderr.emit('data', Buffer.from('late stderr noise\n'));
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'tool_use', id: 'tool_late', name: 'Bash', input: {} }] },
        }) + '\n',
      ),
    );

    expect(rec.logs.length).toBe(logsAfterSettle);
    expect(rec.steps.length).toBe(stepsAfterSettle);

    // 3) close 迟到也不产生二次终态
    child.emit('close', 1);
    const terminalCount = rec.statuses.filter((s) => s !== 'running').length;
    expect(terminalCount).toBe(1);
  });

  it('终态条目在落库回调返回后即回收：内存只跟踪活跃任务（无 MAX_TRACKED 淘汰）', async () => {
    stubAgent();
    const sv = new TaskSupervisor();
    // 容量内的并行上限：maxConcurrent 默认即可；逐个跑完即可
    for (let i = 0; i < 12; i += 1) {
      const child = nextChild();
      const rec = submit(sv, `t_recycle_${i}`);
      child.emit('close', 0);
      await expect(rec.handle.done).resolves.toBe('success');
    }
    // 全部终态且落库回调已返回：内存跟踪数必须回落到 0，
    // 否则就是「终态条目靠容量上限静默淘汰」的旧路径。
    expect(sv.trackedTaskCount).toBe(0);

    // 活跃任务照常被跟踪（容量 = 活跃 + 瞬态，天然有界）
    nextChild();
    const rec = submit(sv, 't_recycle_alive');
    expect(sv.trackedTaskCount).toBe(1);
    rec.handle.cancel();
  });

  it('调度器直连层同 ID 重发是一次新执行：幂等由调度入口的 SQLite 前置负责（生产语义分工）', async () => {
    stubAgent();
    const sv = new TaskSupervisor();
    const first = nextChild();
    const rec1 = submit(sv, 't_resubmit_semantics');
    first.emit('close', 0);
    await expect(rec1.handle.done).resolves.toBe('success');
    expect(sv.trackedTaskCount).toBe(0);

    // 同 ID 重发（无 SQLite 前置的直连调用）：supervisor 是无状态调度器，重新执行。
    // WS/HTTP/网关的幂等拦截都在 dispatch 层（getSession 终态回放 / runIdempotent），
    // 已由 test/task-dispatch-permission.test.ts 覆盖。
    const second = nextChild();
    const rec2 = submit(sv, 't_resubmit_semantics');
    expect(cpMocks.spawn).toHaveBeenCalledTimes(2);
    expect(sv.trackedTaskCount).toBe(1);
    second.emit('close', 0);
    await expect(rec2.handle.done).resolves.toBe('success');
  });
});

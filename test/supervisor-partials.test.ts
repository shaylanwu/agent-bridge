import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { TaskSupervisor } from '../src/core/task-supervisor.js';
import type { TaskStatus } from '../src/protocol.js';

/**
 * 半截消息在**调度器实例**上的生命周期。
 *
 * 三条流式通道（ACP / codex app-server / claude stream）的文本提取各有单测，
 * 这里验证另一半：累积器挂在实例上、能被读取、且随终态清空 —— 否则
 * 「接了通道」就只是一句声明。
 */
const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-partials-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** 用一条必然 pre-spawn 失败的任务把实例推到终态（不真的拉起 CLI） */
function rejectBeforeSpawn(sv: TaskSupervisor, taskId: string): TaskStatus | undefined {
  let status: TaskStatus | undefined;
  sv.submit(
    {
      taskId,
      agentType: 'not-a-real-agent',
      cwd: tmp(),
      args: [],
    },
    {
      onLog: () => undefined,
      onStatus: (s) => {
        status = s;
      },
    },
  );
  return status;
}

describe('调度器侧的半截消息', () => {
  it('新实例没有半截文本', () => {
    expect(new TaskSupervisor().listPartialMessages('tk_x')).toEqual([]);
  });

  it('累积后能按 taskId 读出，未涉及的任务为空', () => {
    const sv = new TaskSupervisor();
    sv.recordPartialText('tk_1', '前半段');
    sv.recordPartialText('tk_1', '后半段');
    expect(sv.listPartialMessages('tk_1')[0]).toMatchObject({
      messageId: 'pm_tk_1',
      role: 'agent',
      text: '前半段后半段',
    });
    expect(sv.listPartialMessages('tk_other')).toEqual([]);
  });

  it('两个调度器实例互不影响（状态在实例字段上，不是模块级变量）', () => {
    const a = new TaskSupervisor();
    const b = new TaskSupervisor();
    a.recordPartialText('tk_1', 'A 的文本');
    expect(a.listPartialMessages('tk_1')).toHaveLength(1);
    expect(b.listPartialMessages('tk_1')).toEqual([]);
  });

  it('同 taskId 重试从干净桶开始：不会带上一次的半截文本', () => {
    const sv = new TaskSupervisor();
    sv.recordPartialText('tk_retry', '上一次没说完的半句');
    expect(sv.listPartialMessages('tk_retry')).toHaveLength(1);

    const status = rejectBeforeSpawn(sv, 'tk_retry');
    expect(status).toBe('failed');
    expect(sv.listPartialMessages('tk_retry')).toEqual([]);
  });

  it('清空只针对该 taskId，不误伤其它任务', () => {
    const sv = new TaskSupervisor();
    sv.recordPartialText('tk_keep', '正在写的另一个任务');
    sv.recordPartialText('tk_reset', '将被重置');
    rejectBeforeSpawn(sv, 'tk_reset');
    expect(sv.listPartialMessages('tk_reset')).toEqual([]);
    expect(sv.listPartialMessages('tk_keep')).toHaveLength(1);
  });
});

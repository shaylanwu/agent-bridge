/**
 * 任务注册表（C 批次）单测：聚合视图是双面板（终端/Web）的唯一数据源，
 * 这里的语义错了，两个面板会一起错。
 */

import { describe, expect, it } from 'vitest';
import { TaskRegistry } from '../src/app/task-registry';

describe('任务注册表 TaskRegistry', () => {
  it('注册 → 状态迁移 → 计数正确（queued 与 running 分开计）', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: '/a/b', source: 'platform' });
    reg.register('t2', { agentType: 'gemini', cwd: '/a/c', source: 'control-plane' });
    // 默认 queued
    expect(reg.counts()).toMatchObject({ running: 0, queued: 2, success: 0, failed: 0 });
    reg.updateStatus('t1', 'running', { phase: 'running' });
    expect(reg.counts()).toMatchObject({ running: 1, queued: 1 });
    reg.updateStatus('t1', 'success', {});
    reg.updateStatus('t2', 'failed', { error: 'boom' });
    expect(reg.counts()).toMatchObject({ running: 0, queued: 0, success: 1, failed: 1 });
  });

  it('重复注册幂等（WS 重发不覆盖 source/时间）', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: '/a', source: 'platform' });
    reg.updateStatus('t1', 'running', { phase: 'running' });
    reg.register('t1', { agentType: 'codex', cwd: '/a', source: 'control-plane' });
    const v = reg.list()[0]!;
    expect(v.source).toBe('platform');
    expect(v.phase).toBe('running');
  });

  it('步骤流：进行中的步骤优先，seq 取最大', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: '/a', source: 'platform' });
    reg.updateStep('t1', { seq: 1, action: 'Read', state: 'started' });
    reg.updateStep('t1', { seq: 1, action: 'Read', state: 'finished' });
    reg.updateStep('t1', { seq: 2, action: 'Bash', label: 'ls', state: 'started' });
    const v = reg.list()[0]!;
    expect(v.stepCount).toBe(2);
    expect(v.currentStep).toMatchObject({ seq: 2, action: 'Bash', label: 'ls' });
  });

  it('步骤历史：同 seq 合并迁移 started→finished，finishedAt 回填', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: '/a', source: 'platform' });
    reg.updateStep('t1', { seq: 1, action: 'Read', label: 'a.ts', state: 'started' });
    reg.updateStep('t1', { seq: 1, action: 'Read', state: 'finished', ok: true });
    reg.updateStep('t1', { seq: 2, action: 'Bash', label: 'ls', state: 'started' });
    const v = reg.get('t1')!;
    expect(v.steps).toHaveLength(2);
    expect(v.steps[0]).toMatchObject({ seq: 1, state: 'finished', ok: true, label: 'a.ts' });
    expect(v.steps[0]!.finishedAt).toBeTypeOf('number');
    expect(v.steps[1]).toMatchObject({ seq: 2, state: 'started' });
  });

  it('终态存最终回答与 diff 产物；cwdOf 出全路径但视图不外泄', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: '/a/b', source: 'platform' });
    reg.updateStatus('t1', 'success', { result: '# 完成', diff: 'diff --git …', changedFiles: ['x.ts'] });
    const v = reg.get('t1')!;
    expect(v.finalText).toBe('# 完成');
    expect(v.changedFiles).toEqual(['x.ts']);
    expect(reg.cwdOf('t1')).toBe('/a/b');
    expect(JSON.stringify(v)).not.toContain('/a/b');
  });

  it('步骤历史：同 seq 合并迁移 started→finished，finishedAt 回填，action 不被 tool_result 覆盖', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: '/a', source: 'platform' });
    reg.updateStep('t1', { seq: 1, action: 'Bash', label: 'ls', state: 'started' });
    reg.updateStep('t1', { seq: 1, action: 'tool_result', state: 'finished', ok: true });
    const v = reg.get('t1')!;
    expect(v.steps).toHaveLength(1);
    expect(v.steps[0]).toMatchObject({ seq: 1, action: 'Bash', state: 'finished', ok: true });
    expect(v.steps[0]!.finishedAt).toBeTypeOf('number');
  });

  it('待办计划快照：updatePlan 覆盖并进入视图', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: '/a', source: 'platform' });
    reg.updatePlan('t1', [
      { text: '读代码', state: 'completed' },
      { text: '改实现', state: 'in_progress' },
      { text: '跑测试', state: 'pending' },
    ]);
    expect(reg.get('t1')!.plan).toHaveLength(3);
    expect(reg.get('t1')!.plan![2]).toMatchObject({ text: '跑测试', state: 'pending' });
  });

  it('cwd 只留 basename（面板不暴露全路径）', () => {
    const reg = new TaskRegistry();
    reg.register('t1', { agentType: 'codex', cwd: 'C:\\Users\\me\\secret-project', source: 'platform' });
    expect(reg.list()[0]!.cwdShort).toBe('secret-project');
  });

  it('subscribe 通知；观察者抛错不影响注册表', () => {
    const reg = new TaskRegistry();
    let n = 0;
    reg.subscribe(() => {
      n += 1;
      throw new Error('渲染炸了');
    });
    reg.register('t1', { agentType: 'codex', cwd: '/a', source: 'platform' });
    expect(n).toBe(1);
    expect(reg.list()).toHaveLength(1);
  });
});

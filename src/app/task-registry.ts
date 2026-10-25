/**
 * 任务注册表（应用编排层）：双通道任务的统一视图
 *
 * 背景：平台通道（task-dispatch）与控制面通道（control-plane）各自维护任务状态，
 * 终端面板与 Web 面板都需要一个「这台设备上有哪些任务、各在哪一步」的聚合视图 ——
 * 不能各查各的（那样两个面板会对同一批任务给出两个答案）。
 *
 * 写入方：dispatchRunTask / 控制面 createTask（注册 + onStatus/onStep 更新）。
 * 读取方：终端面板（cli/panel）、控制面 Web 面板、测试。
 * 实例由 bootstrap 创建并沿 session / dispatch / control-plane 传递（不用模块级单例）。
 */

import type { TaskStatus } from '../protocol.js';
import type { PlanItem } from '../adapters/step-parsers.js';

export type TaskSource = 'platform' | 'control-plane';

/** 时间线步骤条目（同 seq 的 started/finished 合并为一条，state 迁移） */
export interface TaskStepEntry {
  seq: number;
  action: string;
  label?: string;
  state: 'started' | 'finished';
  ok?: boolean;
  /** 步骤开始时刻（epoch ms） */
  at: number;
  /** finished 时回填 */
  finishedAt?: number;
}

export interface TaskView {
  taskId: string;
  agentType: string;
  /** 展示用短路径（basename；全路径不出面板） */
  cwdShort: string;
  source: TaskSource;
  status: TaskStatus;
  phase?: 'queued' | 'running';
  queuePosition?: number;
  error?: string;
  /** 当前/最近步骤（started 未 finished 优先，否则最近一个 finished） */
  currentStep?: { seq: number; action: string; label?: string };
  stepCount: number;
  /** 完整步骤序列（时间线用；有界 MAX_STEPS_PER_TASK，超出丢最旧） */
  steps: TaskStepEntry[];
  /** 待办计划快照（TodoWrite 类工具；存在时表示该 Agent 有计划能力） */
  plan?: PlanItem[];
  /** 终态产物的最终回答文本（解析器从事件流提取） */
  finalText?: string;
  /** 终态 diff 产物（captureDiff 开启时） */
  diff?: string;
  changedFiles?: string[];
  diffTruncated?: boolean;
  createdAt: number;
  startedAt?: number;
  settledAt?: number;
}

export interface TaskCounts {
  running: number;
  queued: number;
  success: number;
  failed: number;
}

/** 面板只展示最近 N 条已终态任务（活跃任务永远全显示） */
const MAX_SETTLED_VIEWS = 50;
/** 单任务步骤历史上界（防爆内存；AI 长任务步骤可能很多） */
const MAX_STEPS_PER_TASK = 200;

export class TaskRegistry {
  private readonly views = new Map<string, TaskView>();
  /** 全路径只用于服务端文件预览端点，绝不序列化进视图（board 不外泄路径） */
  private readonly cwdFull = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  /** 提交时登记（重复 taskId 幂等：已存在则不覆盖 source/时间） */
  register(taskId: string, init: { agentType: string; cwd: string; source: TaskSource }): void {
    if (this.views.has(taskId)) return;
    const base = init.cwd.replace(/[\\/]+$/, '');
    const short = base.split(/[\\/]/).pop() || init.cwd;
    this.cwdFull.set(taskId, init.cwd);
    this.views.set(taskId, {
      taskId,
      agentType: init.agentType,
      cwdShort: short,
      source: init.source,
      status: 'running',
      phase: 'queued',
      stepCount: 0,
      steps: [],
      createdAt: Date.now(),
    });
    this.notify();
  }

  updateStatus(
    taskId: string,
    status: TaskStatus,
    info?: {
      phase?: 'queued' | 'running';
      queuePosition?: number;
      error?: string;
      result?: string;
      diff?: string;
      changedFiles?: string[];
      diffTruncated?: boolean;
    },
  ): void {
    const v = this.views.get(taskId);
    if (!v) return;
    v.status = status;
    v.phase = info?.phase ?? (status === 'running' ? 'running' : undefined);
    v.queuePosition = info?.queuePosition;
    v.error = info?.error;
    if (info?.result !== undefined) v.finalText = info.result;
    if (info?.diff !== undefined) v.diff = info.diff;
    if (info?.changedFiles !== undefined) v.changedFiles = info.changedFiles;
    if (info?.diffTruncated !== undefined) v.diffTruncated = info.diffTruncated;
    if (status === 'running' && v.phase === 'running' && v.startedAt === undefined) v.startedAt = Date.now();
    if (status !== 'running') {
      v.settledAt ??= Date.now();
      v.startedAt ??= v.settledAt;
      this.trimSettled();
    }
    this.notify();
  }

  updateStep(taskId: string, step: { seq: number; action: string; label?: string; state: 'started' | 'finished'; ok?: boolean }): void {
    const v = this.views.get(taskId);
    if (!v) return;
    v.stepCount = Math.max(v.stepCount, step.seq);
    // 同 seq 合并为一条（started → finished 迁移）；action 以 started 的工具名为准，
    // 不让 tool_result 覆盖（那会把「Bash」变成「tool_result」）；label 以信息更全者为准
    const existing = v.steps.find((s) => s.seq === step.seq);
    if (existing) {
      existing.state = step.state;
      if (step.ok !== undefined) existing.ok = step.ok;
      if (step.label) existing.label = step.label;
      if (step.state === 'finished') existing.finishedAt = Date.now();
    } else {
      v.steps.push({
        seq: step.seq,
        action: step.action,
        label: step.label,
        state: step.state,
        ok: step.ok,
        at: Date.now(),
        finishedAt: step.state === 'finished' ? Date.now() : undefined,
      });
      if (v.steps.length > MAX_STEPS_PER_TASK) v.steps.shift();
    }
    // 进行中的步骤优先展示；全 finished 时展示最后完成的一步
    if (step.state === 'started' || v.currentStep === undefined || v.currentStep.seq <= step.seq) {
      v.currentStep = { seq: step.seq, action: step.action, label: step.label };
    }
    this.notify();
  }

  /** 待办计划快照（覆盖式；空数组表示无计划） */
  updatePlan(taskId: string, items: PlanItem[]): void {
    const v = this.views.get(taskId);
    if (!v) return;
    v.plan = items;
    this.notify();
  }

  list(): TaskView[] {
    return [...this.views.values()];
  }

  /** 面板/端点用单任务视图 */
  get(taskId: string): TaskView | undefined {
    return this.views.get(taskId);
  }

  /** 服务端内部用：任务的真实 cwd（文件预览端点）；不出现在任何序列化视图里 */
  cwdOf(taskId: string): string | undefined {
    return this.cwdFull.get(taskId);
  }

  counts(): TaskCounts {
    const c: TaskCounts = { running: 0, queued: 0, success: 0, failed: 0 };
    for (const v of this.views.values()) {
      if (v.status === 'running' && v.phase === 'queued') c.queued += 1;
      else if (v.status === 'running') c.running += 1;
      else if (v.status === 'success') c.success += 1;
      else c.failed += 1;
    }
    return c;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* 面板渲染异常绝不反过来影响任务 */
      }
    }
  }

  /** 终态视图有界：淘汰最旧的 settled（插入序近似终态序） */
  private trimSettled(): void {
    if (this.views.size <= MAX_SETTLED_VIEWS) return;
    for (const [id, v] of this.views) {
      if (v.status !== 'running') {
        this.views.delete(id);
        this.cwdFull.delete(id);
        if (this.views.size <= MAX_SETTLED_VIEWS) return;
      }
    }
  }
}

/**
 * runner.ts —— **兼容包装层**（架构第二期）
 *
 * 调度逻辑已搬到 `src/core/task-supervisor.ts` 的 `TaskSupervisor`：可实例化、可单测、
 * 状态机显式（queued → running → settled）。本文件只保留 v1 的导出签名，
 * 让既有调用方（含测试）零改动：
 *
 *   import { startTask, isUnder } from './runner.js'
 *
 * 目录分层（2026-10-23）：core / transport / adapters / infra 四层。
 * 根目录只留 `cli.ts`（入口）、`protocol.ts`（wire 契约唯一真源）与本文件（v1 兼容包装）。
 *
 * 新代码请直接引 `./core/task-supervisor.js`，不要再往这里加东西。
 * 并发上限（maxConcurrent）与队列上限（maxQueued）现在由 TaskSupervisor 实例持有，
 * 不再是模块级全局 —— 这是"两个用例互相污染"的根因修复。
 *
 * 安全边界（仍在 core/task-supervisor.ts 中强制，未因重构放宽）：
 *  - agentType 必须在白名单（AGENTS 表）内
 *  - 只拼「白名单二进制 + 参数数组」，不经 shell（Windows .cmd 垫片是唯一例外）
 *  - 子进程环境恒为 bridge 自身 process.env，平台不能注入
 *  - cwd 必须存在且是目录，并在 allowed_cwd 之内
 *  - 每个任务强制 timeout，取消走 SIGTERM → 2s → SIGKILL
 */

import {
  defaultSupervisor,
  describeTask,
  isUnder,
  TaskSupervisor,
  type RunTaskRequest,
  type TaskHandle,
  type TaskHooks,
} from './core/task-supervisor.js';

export { TaskSupervisor, defaultSupervisor, isUnder, describeTask };
export type { RunTaskRequest, TaskHandle, TaskHooks, TaskState, TaskFinishInfo } from './core/task-supervisor.js';
export {
  DEFAULT_MAX_QUEUED,
  DEFAULT_MAX_TASKS,
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
} from './core/task-supervisor.js';

/** v1 签名：提交到默认调度域 */
export function startTask(req: RunTaskRequest, hooks: TaskHooks): TaskHandle {
  return defaultSupervisor.submit(req, hooks);
}

/** 仅用于测试与诊断 */
export function runningTaskCount(): number {
  return defaultSupervisor.runningCount;
}
export function queuedTaskCount(): number {
  return defaultSupervisor.queuedCount;
}

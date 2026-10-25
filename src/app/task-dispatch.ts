/**
 * 任务指令编排（应用编排层）
 *
 * 把「平台下发 run_task / cancel_task」到「本地起进程 + 回传状态」这一段从入口文件里搬出来。
 * 这里**不碰终端**：所有输出走注入的 `log`，所以控制面板复用同一段逻辑时不会污染 stdout。
 *
 * 上行一律经 `Emitter.emit()`（终态幂等 / 日志脱敏 / 审计 / 信封收口都在这条路上）。
 */

import type { Emitter } from '../core/emitter.js';
import { startTask, type TaskHandle } from '../runner.js';
import type { ServerMessage } from '../protocol.js';
import { authorizeService } from './service-gate.js';
import type { SessionLog } from './session-log.js';
import type { TaskRegistry } from './task-registry.js';

export type RunTaskMessage = Extract<ServerMessage, { type: 'run_task' }>;
export type CancelTaskMessage = Extract<ServerMessage, { type: 'cancel_task' }>;

export interface TaskDispatchOptions {
  /** 唯一上行出口 */
  emitter: Emitter;
  /** 在跑/排队的任务句柄（取消用；终态后由 session 摘除） */
  tasks: Map<string, TaskHandle>;
  /** 任务注册表（终端面板 / Web 面板的共享视图） */
  registry: TaskRegistry;
  allowedCwd?: string[];
  maxConcurrent: number;
  maxQueued: number;
  diffMaxBytes: number;
  /** 平台没带 captureDiff 时，是否按本地配置的 diff_default 开启 */
  captureDiffByDefault: boolean;
  requireServiceToken: boolean;
  log: SessionLog;
}

/** 取消同样要鉴权：拿到 task:create 的令牌不等于能杀别人的任务 */
export function dispatchCancelTask(msg: CancelTaskMessage, o: TaskDispatchOptions): void {
  const gate = authorizeService(msg, 'cancel_task', msg.taskId, 'task:cancel', o.requireServiceToken);
  if (!gate.ok) {
    o.log('error', `[agent-bridge] 拒绝取消 ${msg.taskId}：${gate.message}`);
    return;
  }
  o.tasks.get(msg.taskId)?.cancel();
}

export function dispatchRunTask(msg: RunTaskMessage, o: TaskDispatchOptions): void {
  const gate = authorizeService(msg, 'run_task', msg.taskId, 'task:create', o.requireServiceToken);
  if (!gate.ok) {
    o.log('error', `[agent-bridge] 拒绝执行 ${msg.taskId}：${gate.message}`);
    o.emitter.emit({
      type: 'task_status',
      taskId: msg.taskId,
      status: 'failed',
      error: `服务身份校验失败：${gate.message}`,
      errorCode: gate.code,
      requestedBy: msg.requestedBy,
    });
    return;
  }

  const who = msg.requestedBy ? `（${msg.requestedBy}${msg.purpose ? ` / ${msg.purpose}` : ''}）` : '';
  o.log('info', `\n▶ 执行任务 ${msg.taskId}：${msg.agentType}${who}`);

  o.registry.register(msg.taskId, { agentType: msg.agentType, cwd: msg.cwd, source: 'platform' });

  const handle = startTask(
    {
      taskId: msg.taskId,
      agentType: msg.agentType,
      cwd: msg.cwd,
      args: msg.args,
      prompt: msg.prompt,
      timeoutMs: msg.timeoutMs,
      allowedCwd: o.allowedCwd,
      maxConcurrent: o.maxConcurrent,
      maxQueued: o.maxQueued,
      captureDiff: msg.captureDiff === true || o.captureDiffByDefault,
      diffMaxBytes: o.diffMaxBytes,
    },
    {
      onLog: (stream, data) => {
        const text = data.replace(/\x1b\[[0-9;]*m/g, '');
        if (text.trim()) o.log('info', `[${stream}] ${text.trimEnd()}`);
        o.emitter.emit({ type: 'task_log', taskId: msg.taskId, stream, data, isAnsi: true });
      },
      // 步骤流（B 批次）：仅 steps:true 的工具会触发；label 的截断与脱敏在 Emitter 收口
      onStep: (step) => {
        o.registry.updateStep(msg.taskId, step);
        o.emitter.emit({ type: 'task_step', taskId: msg.taskId, ...step, at: new Date().toISOString() });
      },
      onPlan: (items) => {
        o.registry.updatePlan(msg.taskId, items);
      },
      onStatus: (status, info) => {
        o.registry.updateStatus(msg.taskId, status, info);
        if (info?.changedFiles?.length) {
          o.log(
            'info',
            `[agent-bridge] 变更 ${info.changedFiles.length} 个文件：${info.changedFiles.slice(0, 8).join(', ')}`,
          );
        }
        o.emitter.emit({
          type: 'task_status',
          taskId: msg.taskId,
          status,
          exitCode: info?.exitCode,
          error: info?.error,
          // 受控错误码：给平台做程序化分支（error 仍是可直接展示的人类可读串）
          errorCode: info?.errorCode,
          // 排队语义：status 恒为 running，phase/queuePosition 供新平台区分（v1 兼容）
          phase: info?.phase,
          queuePosition: info?.queuePosition,
          // P0-6：终态带 diff（未开启 captureDiff 时这些字段都是 undefined，不会出现在 JSON 里）
          diff: info?.diff,
          changedFiles: info?.changedFiles,
          diffTruncated: info?.diffTruncated,
          // P0-8：回显服务身份，供平台落 requested_by 审计
          requestedBy: msg.requestedBy,
        });
      },
    },
  );

  o.tasks.set(msg.taskId, handle);
  void handle.done.then(() => o.tasks.delete(msg.taskId));
}

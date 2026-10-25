/**
 * 平台会话（应用编排层）
 *
 * 职责：一条出站长连接的生命周期 —— 上报初值、路由平台指令、维护在跑任务表。
 * 它**不知道**自己在 CLI 里还是被控制面板驱动：输出全走注入的 `log`，上行全走 `Emitter`。
 *
 * 指令路由只做分发，具体动作在 `task-dispatch.ts`；扫描/取消这类短逻辑就地处理（不值得再开文件）。
 */

import { Emitter } from '../core/emitter.js';
import { scanAgents } from '../core/scan.js';
import { defaultSupervisor } from '../core/task-supervisor.js';
import type { TaskRegistry } from './task-registry.js';
import { assertServerMessage, ProtocolError, type ClientMessage } from '../protocol.js';
import type { TaskHandle } from '../runner.js';
import { createBridgeClient } from '../transport/bridge-client.js';
import type { SessionLog } from './session-log.js';
import {
  dispatchCancelTask,
  dispatchCancelTurn,
  dispatchCloseSession,
  dispatchGetTask,
  dispatchInteractionResponse,
  dispatchRunTask,
} from './task-dispatch.js';
import { dispatchConversationMessage } from './conversation.js';
import { authorizeService } from './service-gate.js';
import type { SessionStore } from '../core/session-store.js';
import { ArtifactTransferManager } from '../core/artifact-transfer.js';

export interface SessionOptions {
  platformUrl: string;
  deviceToken: string;
  deviceId: string;
  cliVersion: string;
  hostname: string;
  allowedCwd?: string[];
  maxConcurrent: number;
  maxQueued: number;
  diffMaxBytes: number;
  /** 平台未指定 captureDiff 时的本地默认（config.toml 的 diff_default） */
  captureDiffByDefault: boolean;
  requireServiceToken: boolean;
  /** 任务注册表（面板/台账共用视图；由 bootstrap 创建） */
  registry: TaskRegistry;
  /** 持久 Session/Turn/Event 权威源；由 bootstrap 创建并在 close 时关闭 */
  store: SessionStore;
  /** 入站附件 CAS 根目录 */
  artifactRootDir: string;
  log: SessionLog;
}

export interface BridgeSession {
  close: () => void;
  isConnected: () => boolean;
  /** 唯一上行出口（本地控制面订阅它看全部任务事件，不另开出口） */
  readonly emitter: Emitter;
  /** 任务注册表（终端面板 / 控制面台账的共享视图） */
  readonly registry: TaskRegistry;
  /** 持久 Session/Turn/Event 权威源（控制面只读查询用） */
  readonly store: SessionStore;
  /** 附件传输与 TTL 管理（控制面管理接口用） */
  readonly artifacts: ArtifactTransferManager;
  /** 在跑/排队的任务数（状态展示与控制面用） */
  activeTasks: () => number;
  /** 取消指定任务（无此任务返回 false） */
  cancelTask: (taskId: string) => boolean;
}

export function createSession(opts: SessionOptions): BridgeSession {
  const tasks = new Map<string, TaskHandle>();
  // client 的 onOpen/onMessage 里要用到 emitter，而 emitter 又要用到 client.send ——
  // 互相依赖只能在"连接建立后才会回调"这个前提下用后赋值解决（与实现顺序无关，回调天然晚于同步构造）
  let emitter: Emitter | undefined;
  const artifacts = new ArtifactTransferManager({
    store: opts.store,
    emit: (msg) => emitter?.emit(msg),
    rootDir: opts.artifactRootDir,
  });
  try {
    const stale = artifacts.cleanupStaleTransfers();
    if (stale > 0) opts.log('info', `[agent-bridge] 已回收 ${stale} 个超时未完成的附件上传`);
  } catch (error) {
    opts.log('error', `[agent-bridge] 附件上传 GC 失败：${(error as Error).message}`);
  }

  const now = (): string => new Date().toISOString();

  const client = createBridgeClient({
    platformUrl: opts.platformUrl,
    deviceToken: opts.deviceToken,
    deviceId: opts.deviceId,
    cliVersion: opts.cliVersion,
    hostname: opts.hostname,
    capacity: { maxTasks: opts.maxConcurrent, maxQueued: opts.maxQueued },
    log: (line) => opts.log('info', line),
    onOpen: async () => {
      // 流式上报：每完成一个工具就推一条 scan_progress，平台可以边收边亮卡片
      const items = await scanAgents({
        fresh: true,
        onItem: (item) =>
          emitter?.emit({ type: 'scan_progress', items: [item], scannedAt: now(), done: false }),
      });
      emitter?.emit({ type: 'scan_progress', items: [], scannedAt: now(), done: true });
      emitter?.emit({ type: 'agent_list', agents: items, scannedAt: now() });
      opts.log('info', `[agent-bridge] 已上报 ${items.length} 个工具状态，等待平台任务…`);
    },
    onMessage: (raw) => {
      let msg;
      try {
        msg = assertServerMessage(raw);
      } catch (e) {
        if (e instanceof ProtocolError) {
          opts.log('error', `[agent-bridge] 指令非法：${e.message}`);
          return;
        }
        throw e;
      }
      if (!emitter) return;

      const dispatchOpts = {
        emitter,
        tasks,
        registry: opts.registry,
        allowedCwd: opts.allowedCwd,
        maxConcurrent: opts.maxConcurrent,
        maxQueued: opts.maxQueued,
        diffMaxBytes: opts.diffMaxBytes,
        captureDiffByDefault: opts.captureDiffByDefault,
        requireServiceToken: opts.requireServiceToken,
        store: opts.store,
        log: opts.log,
      };

      if (msg.type === 'ping') {
        emitter.emit({ type: 'pong', at: Date.now() });
        return;
      }
      if (msg.type === 'get_task') {
        dispatchGetTask(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'close_session') {
        dispatchCloseSession(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'cancel_turn') {
        dispatchCancelTurn(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'send_message') {
        dispatchConversationMessage(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'task_interaction_response') {
        dispatchInteractionResponse(msg, dispatchOpts);
        return;
      }
      if (msg.type === 'artifact_upload_start') {
        const gate = authorizeService(
          msg,
          'run_task',
          msg.taskId,
          'task:create',
          opts.requireServiceToken,
        );
        if (!gate.ok) {
          opts.log('error', `[agent-bridge] 拒绝附件上传 ${msg.taskId}：${gate.message}`);
          return;
        }
        try {
          const ready = artifacts.startUpload({
            sessionId: msg.taskId,
            operationId: msg.operationId,
            name: msg.name,
            mimeType: msg.mimeType,
            size: msg.size,
            sha256: msg.sha256,
            chunkSize: msg.chunkSize,
          });
          emitter.emit({ type: 'artifact_upload_ready', ...ready });
        } catch (error) {
          opts.log('error', `[agent-bridge] 附件上传启动失败：${(error as Error).message}`);
        }
        return;
      }
      if (msg.type === 'artifact_upload_chunk') {
        try {
          const ack = artifacts.writeChunk(msg);
          emitter.emit({ type: 'artifact_upload_chunk_ack', transferId: msg.transferId, ...ack });
        } catch (error) {
          emitter.emit({
            type: 'artifact_upload_result',
            transferId: msg.transferId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_upload_failed',
          });
        }
        return;
      }
      if (msg.type === 'artifact_download_start') {
        const gate = authorizeService(
          msg,
          'get_task',
          msg.taskId,
          'task:read',
          opts.requireServiceToken,
        );
        if (!gate.ok) {
          opts.log('error', `[agent-bridge] 拒绝附件下载 ${msg.taskId}：${gate.message}`);
          return;
        }
        try {
          artifacts.startDownload({
            sessionId: msg.taskId,
            artifactId: msg.artifactId,
            operationId: msg.operationId,
          });
        } catch (error) {
          emitter.emit({
            type: 'artifact_download_result',
            transferId: msg.operationId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_download_failed',
          });
        }
        return;
      }
      if (msg.type === 'artifact_download_chunk_ack') {
        try {
          artifacts.ackDownload(msg);
        } catch (error) {
          emitter.emit({
            type: 'artifact_download_result',
            transferId: msg.transferId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_download_failed',
          });
        }
        return;
      }
      if (msg.type === 'artifact_upload_complete') {
        try {
          const result = artifacts.completeUpload(msg);
          emitter.emit({
            type: 'artifact_upload_result',
            transferId: msg.transferId,
            status: 'committed',
            artifactId: result.artifactId,
            sha256: msg.sha256,
            eventSeq: result.eventSeq,
          });
        } catch (error) {
          emitter.emit({
            type: 'artifact_upload_result',
            transferId: msg.transferId,
            status: 'failed',
            errorCode: (error as { code?: string }).code ?? 'artifact_upload_failed',
          });
        }
        return;
      }
      if (msg.type === 'scan') {
        const requestId = msg.requestId;
        void scanAgents({
          fresh: true,
          onItem: (item) =>
            emitter?.emit({
              type: 'scan_progress',
              requestId,
              items: [item],
              scannedAt: new Date().toISOString(),
              done: false,
            }),
        }).then((agents) => {
          const scannedAt = new Date().toISOString();
          emitter?.emit({ type: 'scan_progress', requestId, items: [], scannedAt, done: true });
          emitter?.emit({ type: 'scan_result', requestId, agents, scannedAt });
        });
        return;
      }
      if (msg.type === 'cancel_task') return dispatchCancelTask(msg, dispatchOpts);
      dispatchRunTask(msg, dispatchOpts);
    },
  });

  emitter = new Emitter({
    // 信封暂不由本地单方开启：平台在 hello 协商到 cloud-events 后再启用，默认保持 v1 扁平报文
    sink: (msg) => client.send(msg as ClientMessage),
  });

  // 容量水位（A2）：每次调度状态变化广播一条 capacity_update。
  // 平台与控制面任务共用 defaultSupervisor（都经 runner.startTask），一处订阅覆盖双通道。
  defaultSupervisor.subscribeCapacity((s) => {
    emitter?.emit({ type: 'capacity_update', ...s });
  });

  return {
    // 循环依赖的解法：client 的回调只在连接建立后触发，此时 emitter 必然已赋值
    emitter,
    registry: opts.registry,
    store: opts.store,
    artifacts,
    close: () => {
      client.close();
      opts.store.close();
    },
    isConnected: () => client.isOpen(),
    activeTasks: () => tasks.size,
    cancelTask: (taskId: string) => {
      const h = tasks.get(taskId);
      if (!h) return false;
      h.cancel();
      return true;
    },
  };
}

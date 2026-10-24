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
import { assertServerMessage, ProtocolError, type ClientMessage } from '../protocol.js';
import type { TaskHandle } from '../runner.js';
import { createBridgeClient } from '../transport/bridge-client.js';
import type { SessionLog } from './session-log.js';
import { dispatchCancelTask, dispatchRunTask } from './task-dispatch.js';

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
  log: SessionLog;
}

export interface BridgeSession {
  close: () => void;
  isConnected: () => boolean;
  /** 唯一上行出口（本地控制面订阅它看全部任务事件，不另开出口） */
  readonly emitter: Emitter;
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

  const now = (): string => new Date().toISOString();

  const client = createBridgeClient({
    platformUrl: opts.platformUrl,
    deviceToken: opts.deviceToken,
    deviceId: opts.deviceId,
    cliVersion: opts.cliVersion,
    hostname: opts.hostname,
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

      if (msg.type === 'ping') {
        emitter.emit({ type: 'pong', at: Date.now() });
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

      const dispatchOpts = {
        emitter,
        tasks,
        allowedCwd: opts.allowedCwd,
        maxConcurrent: opts.maxConcurrent,
        maxQueued: opts.maxQueued,
        diffMaxBytes: opts.diffMaxBytes,
        captureDiffByDefault: opts.captureDiffByDefault,
        requireServiceToken: opts.requireServiceToken,
        log: opts.log,
      };
      if (msg.type === 'cancel_task') return dispatchCancelTask(msg, dispatchOpts);
      dispatchRunTask(msg, dispatchOpts);
    },
  });

  emitter = new Emitter({
    // 信封暂不由本地单方开启：平台在 hello 协商到 cloud-events 后再启用，默认保持 v1 扁平报文
    sink: (msg) => client.send(msg as ClientMessage),
  });

  return {
    // 循环依赖的解法：client 的回调只在连接建立后触发，此时 emitter 必然已赋值
    emitter,
    close: () => client.close(),
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

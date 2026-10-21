/**
 * WebSocket 客户端：出站长连接 + 心跳 + 指数退避重连 + 断线补发
 *
 * 平台不主动打入内网：bridge 主动连出去，平台只在这条连接上下发指令。
 * 鉴权：握手 `Authorization: Bearer <device_token>`。
 */

import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from './protocol.js';

export interface BridgeClientOptions {
  platformUrl: string;
  deviceToken: string;
  deviceId: string;
  cliVersion: string;
  hostname: string;
  onMessage: (msg: ServerMessage) => void;
  onOpen?: () => void;
  onClose?: (reason: string) => void;
  log?: (line: string) => void;
}

export interface BridgeClient {
  send: (msg: ClientMessage) => void;
  close: () => void;
  isOpen: () => boolean;
}

const HEARTBEAT_MS = 15_000;
const MAX_QUEUE = 500;
const MAX_BACKOFF_MS = 30_000;

function wsUrlOf(platformUrl: string, deviceId: string): string {
  const u = new URL(platformUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/bridge/ws';
  u.search = `?deviceId=${encodeURIComponent(deviceId)}`;
  return u.toString();
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  const log = opts.log ?? ((l: string) => console.log(l));
  const url = wsUrlOf(opts.platformUrl, opts.deviceId);
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let backoff = 1000;
  /** 断线期间待发消息：只保留最新的 agent_list，日志类直接丢（避免内存膨胀） */
  const queue: ClientMessage[] = [];
  let hbTimer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (queue.length) {
      const msg = queue.shift();
      if (msg) ws.send(JSON.stringify(msg));
    }
  };

  const send = (msg: ClientMessage): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    // 断线补发：状态类消息保留，日志类丢弃
    if (msg.type === 'task_log') return;
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(msg);
  };

  const connect = (): void => {
    if (closedByUs) return;
    log(`[agent-bridge] 连接 ${url}`);
    ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${opts.deviceToken}` },
      handshakeTimeout: 10_000,
    });

    ws.on('open', () => {
      backoff = 1000;
      log('[agent-bridge] 已连接平台');
      send({
        type: 'hello',
        protocolVersion: 1,
        deviceId: opts.deviceId,
        cliVersion: opts.cliVersion,
        platform: process.platform,
        hostname: opts.hostname,
      });
      flush();
      opts.onOpen?.();
      hbTimer = setInterval(() => {
        try {
          ws?.ping();
        } catch {
          /* 下一轮重连兜底 */
        }
      }, HEARTBEAT_MS);
    });

    ws.on('message', (data) => {
      try {
        const raw = JSON.parse(String(data)) as unknown;
        opts.onMessage(raw as ServerMessage);
      } catch {
        log('[agent-bridge] 收到非 JSON 帧，已忽略');
      }
    });

    ws.on('pong', () => {
      /* 心跳存活 */
    });

    ws.on('close', (code, reason) => {
      if (hbTimer) clearInterval(hbTimer);
      const why = `${code} ${reason?.toString() ?? ''}`.trim();
      opts.onClose?.(why);
      if (closedByUs) return;
      // 401/403 说明 token 失效或被吊销：不要无脑重连，交给上层提示重新绑定
      if (code === 4401 || code === 4403) {
        log('[agent-bridge] 设备凭证被撤销，请重新执行 agent-bridge connect');
        return;
      }
      const wait = backoff;
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      log(`[agent-bridge] 连接断开（${why}），${Math.round(wait / 1000)}s 后重连`);
      setTimeout(connect, wait);
    });

    ws.on('error', (e) => {
      log(`[agent-bridge] 连接错误：${(e as Error).message}`);
    });
  };

  connect();

  return {
    send,
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    close: () => {
      closedByUs = true;
      if (hbTimer) clearInterval(hbTimer);
      ws?.close(1000, 'bye');
    },
  };
}

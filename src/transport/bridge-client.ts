/**
 * WebSocket 客户端：出站长连接 + 心跳 + 指数退避重连 + 断线补发
 *
 * 平台不主动打入内网：bridge 主动连出去，平台只在这条连接上下发指令。
 * 鉴权：握手 `Authorization: Bearer <device_token>`。
 */

import { WebSocket } from 'ws';
import { Outbox } from './outbox.js';
import { assertDeviceId } from '../core/device-identity.js';
import { PROTOCOL_CAPABILITIES, PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '../protocol.js';

export interface BridgeClientOptions {
  platformUrl: string;
  deviceToken: string;
  deviceId: string;
  cliVersion: string;
  hostname: string;
  /** 本次会话生效的调度额度（随 hello 上报；平台据此做有水位线的派发） */
  capacity?: { maxTasks: number; maxQueued: number };
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
const MAX_BACKOFF_MS = 30_000;

/** WS 与 hello 共用同一个经过校验的稳定身份，不再允许空 ID 降级。 */
export function wsUrlOf(platformUrl: string, deviceId: string): string {
  const stableDeviceId = assertDeviceId(deviceId);
  const u = new URL(platformUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/api/bridge/ws';
  u.search = `?deviceId=${encodeURIComponent(stableDeviceId)}`;
  return u.toString();
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  const log = opts.log ?? ((l: string) => console.log(l));
  const url = wsUrlOf(opts.platformUrl, opts.deviceId);
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let backoff = 1000;
  /** 断线期间待发消息：控制类按条数、日志按字节各自有界（见 outbox.ts） */
  const outbox = new Outbox();
  let hbTimer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const droppedBytes = outbox.dropped;
    const pending = outbox.drain();
    if (droppedBytes > 0) {
      log(`[agent-bridge] 断线期间日志超出缓冲上限，丢弃约 ${Math.round(droppedBytes / 1024)} KB`);
    }
    for (const msg of pending) ws.send(JSON.stringify(msg));
  };

  const send = (msg: ClientMessage): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return;
    }
    // 断线补发：控制类与日志都进缓冲（日志有界、超限带截断提示），不再静默丢弃
    outbox.push(msg);
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
        protocolVersion: PROTOCOL_VERSION,
        deviceId: opts.deviceId,
        cliVersion: opts.cliVersion,
        platform: process.platform,
        hostname: opts.hostname,
        // 能力协商：让任意第三方平台自己判断能用哪些可选能力，而不是猜 CLI 版本号
        capabilities: [...PROTOCOL_CAPABILITIES],
        // 容量水位（A2）：握手即知上限，不必等 device_busy 试错
        ...(opts.capacity ? { capacity: opts.capacity } : {}),
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
        log('[agent-bridge] 设备凭证失效或被撤销，请先执行 agent-bridge logout，再重新 connect；设备身份保持不变');
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

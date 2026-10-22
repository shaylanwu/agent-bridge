/**
 * Outbox：断线期间的有界发送缓冲。
 *
 * 为什么要单独一块：控制类消息（状态/扫描结果）和日志是两种东西 ——
 *  - 控制消息丢掉会让平台状态错乱（比如漏了 task_status: success），必须尽量保；
 *  - 日志丢了只是看不到中间过程，但**一条不留**会让排障无从下手（原先就是直接 return 丢掉）。
 * 两类用不同的上限：控制按条数（200），日志按字节（默认 256 KB），日志满了丢最旧 ——
 * 排障时"最近的上下文"比"最早的开头"更有用。
 *
 * 丢弃不静默：`drain()` 会在日志前插一条说明性 task_log，平台能看出中间有缺口。
 */

import type { ClientMessage } from './protocol.js';

const MAX_CONTROLS = 200;
const DEFAULT_MAX_LOG_BYTES = 256 * 1024;

type LogMessage = Extract<ClientMessage, { type: 'task_log' }>;

function isLog(msg: ClientMessage): msg is LogMessage {
  return msg.type === 'task_log';
}

function byteSize(msg: ClientMessage): number {
  return Buffer.byteLength(JSON.stringify(msg), 'utf8');
}

export interface OutboxOptions {
  maxControls?: number;
  maxLogBytes?: number;
}

export class Outbox {
  private readonly controls: ClientMessage[] = [];
  private readonly logs: LogMessage[] = [];
  private logBytes = 0;
  private droppedLogs = 0;
  private droppedBytes = 0;
  private readonly maxControls: number;
  private readonly maxLogBytes: number;

  constructor(opts: OutboxOptions = {}) {
    this.maxControls = opts.maxControls && opts.maxControls > 0 ? Math.floor(opts.maxControls) : MAX_CONTROLS;
    this.maxLogBytes =
      opts.maxLogBytes && opts.maxLogBytes > 0 ? Math.floor(opts.maxLogBytes) : DEFAULT_MAX_LOG_BYTES;
  }

  push(msg: ClientMessage): void {
    if (isLog(msg)) {
      const size = byteSize(msg);
      this.logs.push(msg);
      this.logBytes += size;
      // 丢最旧：保留最近的上下文
      while (this.logBytes > this.maxLogBytes && this.logs.length > 1) {
        const dropped = this.logs.shift();
        if (!dropped) break;
        const dropSize = byteSize(dropped);
        this.logBytes -= dropSize;
        this.droppedLogs += 1;
        this.droppedBytes += dropSize;
      }
      return;
    }
    this.controls.push(msg);
    while (this.controls.length > this.maxControls) this.controls.shift();
  }

  /** 待发列表：先控制（状态优先），后日志（含超限提示）；取完即清空 */
  drain(): ClientMessage[] {
    const out: ClientMessage[] = [...this.controls, ...this.logs];
    const notice = this.notice();
    if (notice) out.splice(this.controls.length, 0, notice);
    this.controls.length = 0;
    this.logs.length = 0;
    this.logBytes = 0;
    this.droppedLogs = 0;
    this.droppedBytes = 0;
    return out;
  }

  get pending(): number {
    return this.controls.length + this.logs.length;
  }

  /** 累计丢弃的日志字节数（诊断用） */
  get dropped(): number {
    return this.droppedBytes;
  }

  private notice(): LogMessage | null {
    if (this.droppedLogs === 0) return null;
    const anchor = this.logs[0] ?? this.firstLogInControls();
    if (!anchor) return null;
    const kb = Math.max(1, Math.round(this.droppedBytes / 1024));
    return {
      type: 'task_log',
      taskId: anchor.taskId,
      stream: 'stderr',
      data: `[agent-bridge] 断线期间日志超出缓冲上限（${kb} KB），已丢弃较早部分\n`,
      isAnsi: false,
    };
  }

  private firstLogInControls(): LogMessage | null {
    for (const msg of this.controls) if (isLog(msg)) return msg;
    return null;
  }
}

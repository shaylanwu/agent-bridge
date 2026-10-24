/**
 * 唯一上行出口（架构第一期）
 *
 * 背景：之前每加一个能力（diff / step / heartbeat）都要在 cli.ts 里再插一段"发消息"的代码，
 * 于是"终态后不再发日志""日志脱敏""审计""顺序保证"这些横切需求会**各写一遍** —— 这是重复代码的根因。
 *
 * 现在所有上行报文只有一条路：`Emitter.emit()`。四类横切逻辑在这里收口一次：
 *
 *  1. **幂等**：任务进入终态后，该 task 的后续 log / status 一律丢弃（P1-1）；
 *  2. **脱敏**：`task_log` 的正文做家目录与长串折叠（P1-2），diff 等产物**不动**；
 *  3. **审计旁路**：可用 `onAudit` 观察每一条上行（写失败不影响发送）；
 *  4. **信封**：可选 CloudEvents 1.0 包装（由 `hello.capabilities` 协商）。
 *
 * 缓冲（断线补发）不在这里 —— 那是传输层 `Outbox` 的职责，Emitter 只决定"该不该发、发什么"。
 */

import { homedir } from 'node:os';
import { redact } from './redact.js';
import {
  toCloudEvent,
  type ClientMessage,
  type CloudEvent,
  type TaskStatus,
} from '../protocol.js';

/** 终态：进入这几个状态的 task 不再产生任何上行事件 */
export const TERMINAL_STATUSES = ['success', 'failed', 'cancelled', 'timeout'] as const;

export function isTerminal(status: TaskStatus): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type Upstream = ClientMessage | CloudEvent;
export type Sink = (msg: Upstream) => void;

export interface EmitterOptions {
  /** 真正的出口（bridge-client 的 send，内部自带断线缓冲） */
  sink: Sink;
  /** 是否脱敏 task_log 正文（默认 true） */
  redactLogs?: boolean;
  /** 脱敏用的家目录（默认 os.homedir()） */
  home?: string;
  /** 启用 CloudEvents 1.0 信封；source 形如 `urn:agent-bridge:device:<id>` */
  envelope?: { source: string };
  /** 审计旁路（绝不因它失败而阻断发送） */
  onAudit?: (msg: Upstream) => void;
  /** 记住多少个已终态 taskId（有界，防长跑进程内存无上限增长） */
  maxSettled?: number;
  /**
   * 环形缓冲条数：**只服务本地控制面**（晚订阅的 SSE 客户端能补发近期事件）。
   * 默认 256（单条 ≤4KB，约 1MB 上界）；不需要事件流时设 0 即完全不占内存。
   */
  ringSize?: number;
}

/** 上行观察者（控制面的 SSE 用它订阅全部事件，不另开一条出口） */
export type EmitObserver = (msg: Upstream) => void;

export class Emitter {
  private readonly sink: Sink;
  private readonly redactLogs: boolean;
  private readonly home: string;
  private readonly envelope: { source: string } | undefined;
  private readonly onAudit: ((msg: Upstream) => void) | undefined;
  private readonly maxSettled: number;
  /** 已终态的 taskId（插入顺序 = 淘汰顺序，最旧的先忘） */
  private readonly settled = new Set<string>();
  private seq = 0;
  private readonly observers = new Set<EmitObserver>();
  private readonly ring: Upstream[] = [];
  private readonly ringSize: number;

  constructor(opts: EmitterOptions) {
    this.sink = opts.sink;
    this.redactLogs = opts.redactLogs !== false;
    this.home = opts.home ?? homedir();
    this.envelope = opts.envelope;
    this.onAudit = opts.onAudit;
    this.maxSettled = opts.maxSettled && opts.maxSettled > 0 ? Math.floor(opts.maxSettled) : 1000;
    this.ringSize = opts.ringSize !== undefined && opts.ringSize >= 0 ? Math.floor(opts.ringSize) : 256;
  }

  /** 订阅上行（返回退订函数）。观察者抛异常绝不影响发送，也不影响其它观察者 */
  subscribe(fn: EmitObserver): () => void {
    this.observers.add(fn);
    return () => this.observers.delete(fn);
  }

  /** 最近 N 条上行（环形缓冲）：给晚订阅的客户端补发。ringSize=0 时永远返回空 */
  recent(limit = this.ringSize): Upstream[] {
    const n = Math.max(0, Math.min(Math.floor(limit), this.ring.length));
    return n === 0 ? [] : this.ring.slice(this.ring.length - n);
  }

  /** 该 task 是否已终态（终态后再来的一律丢弃） */
  isSettled(taskId: string): boolean {
    return this.settled.has(taskId);
  }

  /** 当前单调序号（CloudEvents 信封用） */
  get sequence(): number {
    return this.seq;
  }

  emit(msg: ClientMessage): void {
    // —— 1. 幂等 ——
    if ('taskId' in msg && this.settled.has(msg.taskId)) return;

    let out: ClientMessage = msg;
    if (msg.type === 'task_log') {
      // —— 2. 脱敏（只动日志正文，不动 diff 这类产物）——
      if (this.redactLogs) out = { ...msg, data: redact(msg.data, { home: this.home }) };
    }

    // 终态登记放在**发送之后**的必要之前：先记住，再发，避免重入导致重复终态
    if (out.type === 'task_status' && isTerminal(out.status)) this.remember(out.taskId);

    // —— 4. 信封 ——
    const payload: Upstream = this.envelope
      ? toCloudEvent(out, this.envelope.source, (this.seq += 1))
      : out;
    if (!this.envelope) this.seq += 1;

    // —— 3. 审计旁路 ——
    if (this.onAudit) {
      try {
        this.onAudit(payload);
      } catch {
        /* 审计绝不阻断发送 */
      }
    }

    // —— 5. 环形缓冲 + 观察者（本地控制面的事件源）——
    if (this.ringSize > 0) {
      this.ring.push(payload);
      while (this.ring.length > this.ringSize) this.ring.shift();
    }
    for (const fn of this.observers) {
      try {
        fn(payload);
      } catch {
        /* 观察者（SSE 断线等）绝不阻断发送 */
      }
    }

    this.sink(payload);
  }

  private remember(taskId: string): void {
    if (this.settled.has(taskId)) return;
    this.settled.add(taskId);
    while (this.settled.size > this.maxSettled) {
      const oldest = this.settled.values().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
    }
  }
}

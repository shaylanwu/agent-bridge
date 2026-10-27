/**
 * 半截消息累积器（1.0 的 `partialMessages`）
 *
 * 为什么要有它：任务跑到一半时平台刷新页面 / 重连，`get_task` 只能给出已落库的事件，
 * 而助手的文本通常在回合结束才作为一条 `complete` 落库 —— 于是重连后屏幕上「什么都没有」，
 * 用户以为任务卡住了。这份累积器让快照能带上「已经吐出来但还没定稿的那半段」。
 *
 * 三条设计取舍（都是刻意的）：
 *  1. **只在内存里**，不写 SQLite。流式 chunk 是 token 级的，落库会让 events 表被文本淹掉，
 *     retention 也会被 delta 挤爆；而它本来就**不是可恢复状态** —— 进程重启后平台重连拿尾部窗口即可。
 *  2. **一个任务一个桶**（而非一条消息一个桶）。ACP 的 chunk 不带稳定 messageId，硬造 ID 会让平台
 *     误以为是可拼接的多条消息；同一回合内的多段文本直接拼接，语义诚实：这是「本回合累积中的文本」。
 *  3. **有上限**，超了就截断并置 `truncated`。累积器是旁路，不能因为某个模型话痨把内存吃掉。
 *
 * 生命周期：任务终态时由 supervisor 清空 —— 终态之后平台该看事件里的 `complete`，而不是半截文本。
 */

import type { SnapshotPartialMessage } from '../protocol.js';

/** 单任务半截文本上限（32 KiB）：够覆盖绝大多数回合，又不至于把内存吃穿 */
export const PARTIAL_TEXT_LIMIT = 32 * 1024;

export class PartialMessageTracker {
  private readonly byTask = new Map<string, SnapshotPartialMessage>();

  /**
   * 追加一段流式文本。
   * @returns 追加后是否仍保留该桶（false = 已达上限被截断，后续块直接丢弃）
   */
  append(taskId: string, chunk: string, opts: { role?: 'user' | 'agent' | 'system'; at?: string } = {}): boolean {
    if (!chunk) return this.byTask.has(taskId);
    const existing = this.byTask.get(taskId);
    if (existing?.truncated) return false;
    const at = opts.at ?? new Date().toISOString();
    if (!existing) {
      const text = chunk.length > PARTIAL_TEXT_LIMIT ? chunk.slice(0, PARTIAL_TEXT_LIMIT) : chunk;
      this.byTask.set(taskId, {
        messageId: partialMessageId(taskId),
        role: opts.role ?? 'agent',
        text,
        updatedAt: at,
        ...(text.length < chunk.length ? { truncated: true } : {}),
      });
      return text.length === chunk.length;
    }
    const room = PARTIAL_TEXT_LIMIT - existing.text.length;
    if (room <= 0) {
      this.byTask.set(taskId, { ...existing, truncated: true, updatedAt: at });
      return false;
    }
    const piece = chunk.length > room ? chunk.slice(0, room) : chunk;
    this.byTask.set(taskId, {
      ...existing,
      text: existing.text + piece,
      updatedAt: at,
      ...(piece.length < chunk.length ? { truncated: true } : {}),
    });
    return piece.length === chunk.length;
  }

  list(taskId: string): SnapshotPartialMessage[] {
    const one = this.byTask.get(taskId);
    return one ? [{ ...one }] : [];
  }

  /** 任务终态 / 会话关闭时调用：半截文本不该活过它所属的回合 */
  clear(taskId: string): void {
    this.byTask.delete(taskId);
  }

  /** 当前持有的任务数（面板与测试用；不是 wire 字段） */
  get size(): number {
    return this.byTask.size;
  }
}

/**
 * 半截消息的稳定 ID。
 *
 * 刻意**不**模拟真实 messageId（`msg_<task>_final` 那种）—— 那是落库消息的幂等键，
 * 半截文本随时可能被 complete 顶替，给它一个同构 ID 会诱导平台拿它去重。
 */
export function partialMessageId(taskId: string): string {
  return `pm_${taskId}`;
}

/**
 * 从 ACP `session/update` 的 update 里取助手文本增量。
 * 只认 `agent_message_chunk` + `content.type === 'text'`；其余（tool_call / plan / thought）不是助手正文。
 */
export function acpChunkText(update: Record<string, unknown>): string | undefined {
  if (update['sessionUpdate'] !== 'agent_message_chunk') return undefined;
  const content = update['content'] as Record<string, unknown> | undefined;
  return content?.['type'] === 'text' && typeof content['text'] === 'string' ? content['text'] : undefined;
}

/** 从 codex app-server 通知里取助手文本增量（`item/agentMessage/delta`） */
export function codexDeltaText(notification: Record<string, unknown>): string | undefined {
  if (notification['method'] !== 'item/agentMessage/delta') return undefined;
  const params = (notification['params'] ?? {}) as Record<string, unknown>;
  return typeof params['delta'] === 'string' ? params['delta'] : undefined;
}

/** 从 claude stream-json 的 content block 里取助手文本（整条消息，不是 token 增量） */
export function claudeBlockText(block: Record<string, unknown>): string | undefined {
  return block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : undefined;
}

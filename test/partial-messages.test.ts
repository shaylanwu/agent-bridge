import { describe, expect, it } from 'vitest';
import {
  PARTIAL_TEXT_LIMIT,
  PartialMessageTracker,
  acpChunkText,
  claudeBlockText,
  codexDeltaText,
  partialMessageId,
} from '../src/core/partial-messages.js';

describe('半截文本累积器', () => {
  it('按任务累积多次 chunk，messageId 稳定且与落库消息不同构', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_1', '正在读');
    tracker.append('tk_1', '文件…');
    const [partial] = tracker.list('tk_1');
    expect(partial).toMatchObject({ messageId: 'pm_tk_1', role: 'agent', text: '正在读文件…' });
    expect(partial?.truncated).toBeUndefined();
    // 刻意不是 msg_* —— 半截文本会被 complete 顶替，不能诱导平台拿它去重
    expect(partialMessageId('tk_1')).toBe('pm_tk_1');
    expect(partial?.messageId.startsWith('msg_')).toBe(false);
  });

  it('不同任务互不串味', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_a', 'A');
    tracker.append('tk_b', 'B');
    expect(tracker.list('tk_a')[0]?.text).toBe('A');
    expect(tracker.list('tk_b')[0]?.text).toBe('B');
    expect(tracker.size).toBe(2);
  });

  it('没有累积过就返回空数组（不是 undefined，平台不必判空两遍）', () => {
    const tracker = new PartialMessageTracker();
    expect(tracker.list('tk_none')).toEqual([]);
  });

  it('空 chunk 不创建空桶（否则快照里会多一条空消息）', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_1', '');
    expect(tracker.list('tk_1')).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  it('到上限截断并置 truncated，之后的增量直接丢弃（不无限吃内存）', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_1', 'x'.repeat(PARTIAL_TEXT_LIMIT));
    expect(tracker.list('tk_1')[0]?.truncated).toBeUndefined();
    const kept = tracker.append('tk_1', 'tail');
    expect(kept).toBe(false);
    expect(tracker.list('tk_1')[0]?.truncated).toBe(true);
    expect(tracker.list('tk_1')[0]?.text).toHaveLength(PARTIAL_TEXT_LIMIT);
  });

  it('单个超大 chunk 也是一次截断，不留半截长度溢出', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_1', 'y'.repeat(PARTIAL_TEXT_LIMIT + 5000));
    const [partial] = tracker.list('tk_1');
    expect(partial?.text).toHaveLength(PARTIAL_TEXT_LIMIT);
    expect(partial?.truncated).toBe(true);
  });

  it('clear 之后读不到，等同于回合已结算', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_1', '半截');
    tracker.clear('tk_1');
    expect(tracker.list('tk_1')).toEqual([]);
    expect(tracker.size).toBe(0);
  });

  it('list 返回副本，调用方改不动内部状态', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_1', '原文');
    const [partial] = tracker.list('tk_1');
    if (partial) partial.text = '被篡改';
    expect(tracker.list('tk_1')[0]?.text).toBe('原文');
  });

  it('updatedAt 随每次追加推进', () => {
    const tracker = new PartialMessageTracker();
    tracker.append('tk_1', 'a', { at: '2026-10-27T00:00:00.000Z' });
    expect(tracker.list('tk_1')[0]?.updatedAt).toBe('2026-10-27T00:00:00.000Z');
    tracker.append('tk_1', 'b', { at: '2026-10-27T00:00:01.000Z' });
    expect(tracker.list('tk_1')[0]?.updatedAt).toBe('2026-10-27T00:00:01.000Z');
  });
});

describe('三条流式通道的文本提取', () => {
  it('ACP：只认 agent_message_chunk 里的 text 内容', () => {
    expect(
      acpChunkText({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '你好' },
      }),
    ).toBe('你好');
    // tool_call / plan 不是助手正文
    expect(acpChunkText({ sessionUpdate: 'tool_call', content: { type: 'text', text: 'x' } })).toBeUndefined();
    // 非 text 内容（如图片）不当作正文
    expect(
      acpChunkText({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }),
    ).toBeUndefined();
    expect(acpChunkText({ sessionUpdate: 'agent_message_chunk' })).toBeUndefined();
  });

  it('codex：只认 item/agentMessage/delta 的 delta 字段', () => {
    expect(codexDeltaText({ method: 'item/agentMessage/delta', params: { delta: 'chunk' } })).toBe('chunk');
    expect(codexDeltaText({ method: 'item/started', params: { delta: 'chunk' } })).toBeUndefined();
    expect(codexDeltaText({ method: 'item/agentMessage/delta', params: {} })).toBeUndefined();
    expect(codexDeltaText({ method: 'item/agentMessage/delta', params: { delta: 42 } })).toBeUndefined();
  });

  it('claude：只认 text block', () => {
    expect(claudeBlockText({ type: 'text', text: 'answer' })).toBe('answer');
    expect(claudeBlockText({ type: 'tool_use', name: 'Bash' })).toBeUndefined();
    expect(claudeBlockText({ type: 'text' })).toBeUndefined();
  });
});

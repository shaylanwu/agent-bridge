import { describe, expect, it } from 'vitest';
import { createBoundedLineReader, ACP_MAX_LINE_BYTES } from '../src/adapters/acp-codebuddy.js';

/**
 * ACP stdio client 的帧上限（tasks.md 5.2；design「ACP 帧做同等级有界解析防 DoS」）：
 *
 * readline 没有行长上限 —— 恶意/异常 agent 发一条永不换行的超长流会把内部缓冲撑到无界。
 * 有界行读取器：跨 chunk 半行重组（分片 JSONL）+ 单行字节上限 —— 超限行整帧丢弃并计数
 * （后续新行不受影响），进程绝不因单帧而内存无界。
 */
describe('ACP 有界行读取器', () => {
  it('跨 chunk 半行重组（分片 JSONL）：7 字节一片与整串结果一致', () => {
    const text = '{"a":1}\n{"b":2}\n{"c":"跨片"}\n';
    const whole = createBoundedLineReader();
    expect(whole.feed(text)).toEqual(['{"a":1}', '{"b":2}', '{"c":"跨片"}']);
    const chunked = createBoundedLineReader();
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += 7) lines.push(...chunked.feed(text.slice(i, i + 7)));
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":"跨片"}']);
  });

  it('超长行整帧丢弃并计数；后续正常行不受影响', () => {
    const reader = createBoundedLineReader();
    const huge = 'x'.repeat(ACP_MAX_LINE_BYTES + 1024);
    // 先灌超长行的前半（无换行），再补尾部 + 换行 —— 整帧丢弃
    expect(reader.feed(huge.slice(0, ACP_MAX_LINE_BYTES - 10))).toEqual([]);
    const after = reader.feed(`${huge.slice(ACP_MAX_LINE_BYTES - 10)}\n{"ok":1}\n`);
    // 超长行丢弃；随后紧跟的换行产生一个空行（无害，调用方按非 JSON 跳过）；正常行继续
    expect(after).toEqual(['{"ok":1}']);
    expect(reader.droppedFrames()).toBe(1);
  });

  it('上限内的最大合法行完整通过', () => {
    const reader = createBoundedLineReader();
    const line = 'y'.repeat(ACP_MAX_LINE_BYTES);
    const out = reader.feed(`${line}\n`);
    expect(out).toEqual([line]);
    expect(reader.droppedFrames()).toBe(0);
  });

  it('flush 交出未换行的尾部（EOF 场景）', () => {
    const reader = createBoundedLineReader();
    reader.feed('{"partial":');
    expect(reader.flush()).toEqual(['{"partial":']);
    expect(reader.flush()).toEqual([]);
  });
});

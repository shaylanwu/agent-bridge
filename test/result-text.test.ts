import { describe, expect, it } from 'vitest';
import { RESULT_TEXT_LIMIT, capResultText } from '../src/core/result-text.js';

/**
 * `task_status.result` 的起草口径：协议字段表写明「≤16KB」，
 * 所以上行前必须截断。边界取 16384 / 16385，避免「差一个字符」这类口径漂移。
 */
describe('终态最终回答的截断口径', () => {
  it('未超限原样返回（不做任何改写，换行与末尾空白都保留）', () => {
    expect(capResultText('APPROVED_OK')).toBe('APPROVED_OK');
    expect(capResultText('line1\nline2\n')).toBe('line1\nline2\n');
  });

  it('恰好 16384 字符不截断', () => {
    const exact = 'a'.repeat(RESULT_TEXT_LIMIT);
    const capped = capResultText(exact);
    expect(capped).toBe(exact);
    expect(capped).not.toContain('…');
  });

  it('16385 字符截断到 16384 并补省略号', () => {
    const capped = capResultText('a'.repeat(RESULT_TEXT_LIMIT + 1));
    expect(capped).toHaveLength(RESULT_TEXT_LIMIT + 1); // 16384 个 a + 一个省略号
    expect(capped?.endsWith('…')).toBe(true);
    expect(capped?.slice(0, -1)).toBe('a'.repeat(RESULT_TEXT_LIMIT));
  });

  it('空值 / 空串 / 纯空白 → undefined（宁可不带字段，也不发空串）', () => {
    expect(capResultText(undefined)).toBeUndefined();
    expect(capResultText(null)).toBeUndefined();
    expect(capResultText('')).toBeUndefined();
    expect(capResultText('   \n\t ')).toBeUndefined();
  });
});

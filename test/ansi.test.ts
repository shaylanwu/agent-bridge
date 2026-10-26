import { describe, expect, it } from 'vitest';
import { hasAnsi } from '../src/core/ansi.js';

describe('hasAnsi', () => {
  it('识别颜色/光标转义', () => {
    expect(hasAnsi('\u001b[31mred\u001b[0m')).toBe(true);
    expect(hasAnsi('\u001b[2Kcleared')).toBe(true);
  });

  it('纯文本与普通方括号不误判', () => {
    expect(hasAnsi('plain text')).toBe(false);
    expect(hasAnsi('[INFO] done')).toBe(false);
  });
});

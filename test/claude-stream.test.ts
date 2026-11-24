import { describe, expect, it } from 'vitest';
import { claudeResultError, claudeStreamArgs } from '../src/adapters/claude-stream.js';

describe('Claude stream-json adapter', () => {
  it('使用双向 stream-json，权限保持 acceptEdits', () => {
    const args = claudeStreamArgs();
    expect(args).toEqual(
      expect.arrayContaining([
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--permission-mode',
        'acceptEdits',
      ]),
    );
    expect(args).not.toContain('--resume');
  });

  it('有 native session 时追加 --resume', () => {
    expect(claudeStreamArgs('sess_1')).toEqual(expect.arrayContaining(['--resume', 'sess_1']));
  });

  it('result 的 is_error/非 success subtype 必须转成错误，正常 success 不报错', () => {
    expect(
      claudeResultError({ type: 'result', subtype: 'error_during_execution', is_error: true, error: 'no model' })
        ?.message,
    ).toContain('no model');
    expect(claudeResultError({ type: 'result', subtype: 'success', is_error: false })).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { claudeStreamArgs } from '../src/adapters/claude-stream.js';

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
});

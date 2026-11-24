import { describe, expect, it } from 'vitest';
import { codexAppServerArgs, codexTurnError } from '../src/adapters/codex-app-server.js';

describe('Codex App Server adapter', () => {
  it('使用已验证的 app-server stdio 入口', () => {
    expect(codexAppServerArgs()).toEqual(['app-server', '--stdio']);
  });

  it('只有明确的 completed 算成功；failed/interrupted/未知状态均保留失败语义', () => {
    expect(codexTurnError('completed')).toBeUndefined();
    expect(codexTurnError('failed', { message: 'boom' })?.message).toContain('boom');
    expect(codexTurnError('interrupted')?.message).toContain('interrupted');
    expect(codexTurnError('unknown')?.message).toContain('unknown');
  });
});

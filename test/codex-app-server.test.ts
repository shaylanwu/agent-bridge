import { describe, expect, it } from 'vitest';
import { codexAppServerArgs } from '../src/adapters/codex-app-server.js';

describe('Codex App Server adapter', () => {
  it('使用已验证的 app-server stdio 入口', () => {
    expect(codexAppServerArgs()).toEqual(['app-server', '--stdio']);
  });
});

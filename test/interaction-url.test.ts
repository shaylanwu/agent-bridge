import { describe, expect, it } from 'vitest';
import { InteractionUrlVault } from '../src/core/interaction-url.js';

describe('InteractionUrlVault', () => {
  it('保存短期 URL 并按 session/request 读取', () => {
    const vault = new InteractionUrlVault();
    const entry = vault.register('bt_1', 'ir_1', 'https://example.test/auth?x=1', 1000, 1000);
    expect(entry.expiresAt).toBe(new Date(2000).toISOString());
    expect(vault.get('bt_1', 'ir_1', 1500)?.url).toBe('https://example.test/auth?x=1');
    expect(vault.get('bt_2', 'ir_1', 1500)).toBeUndefined();
  });

  it('lookup 区分不存在与已过期', () => {
    const vault = new InteractionUrlVault();
    vault.register('bt_1', 'ir_1', 'https://a', 100, 1000);
    expect(vault.lookup('bt_1', 'ir_1', 1050)).toMatchObject({ expired: false });
    expect(vault.lookup('bt_1', 'ir_1', 1200)).toEqual({ expired: true });
    expect(vault.lookup('bt_1', 'missing', 1200)).toEqual({ expired: false });
  });

  it('register 机会式清理过期项', () => {
    const vault = new InteractionUrlVault();
    vault.register('bt_1', 'old', 'https://old', 10, 1000);
    vault.register('bt_1', 'new', 'https://new', 1000, 1100);
    expect(vault.cleanup(1100)).toBe(0);
    expect(vault.get('bt_1', 'old', 1100)).toBeUndefined();
    expect(vault.get('bt_1', 'new', 1100)?.url).toBe('https://new');
  });

  it('过期与 revoke 都返回 undefined，cleanup 计数', () => {
    const vault = new InteractionUrlVault();
    vault.register('bt_1', 'ir_1', 'https://a', 100, 1000);
    vault.register('bt_1', 'ir_2', 'https://b', 5000, 1000);
    expect(vault.get('bt_1', 'ir_1', 1200)).toBeUndefined();
    expect(vault.cleanup(1200)).toBe(0);
    vault.revoke('bt_1', 'ir_2');
    expect(vault.get('bt_1', 'ir_2', 1200)).toBeUndefined();
  });
});

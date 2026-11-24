import { describe, expect, it } from 'vitest';
import { isHostInjectedEnv, withoutHostEnv } from '../src/adapters/host-env.js';

/**
 * 宿主注入变量的清理。
 *
 * 这条覆盖一个实测过的硬故障：bridge 跑在 WorkBuddy/CodeBuddy 宿主里时，
 * codebuddy 子进程继承 `CODEBUDDY_SESSION_ID` 等变量后会去抢宿主端口，
 * 直接 `listen EADDRINUSE 127.0.0.1:57193` 失败；清掉后立刻正常。
 */
describe('withoutHostEnv', () => {
  it('清掉 CODEBUDDY_* 前缀（含宿主 MCP 配置与会话 id）', () => {
    const env = withoutHostEnv({
      PATH: '/usr/bin',
      CODEBUDDY_SESSION_ID: 'abc',
      CODEBUDDY_MCP_CONFIG: '{"mcpServers":{}}',
      CODEBUDDY_CONVERSATION_MESSAGE_ID: 'm1',
      CODEBUDDY_DISABLE_IDE: '1',
    });
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('保留 CODEBUDDY_AUTH_TOKEN（子进程认证要用）', () => {
    const env = withoutHostEnv({ CODEBUDDY_AUTH_TOKEN: 'tok_123', CODEBUDDY_SESSION_ID: 'abc' });
    expect(env['CODEBUDDY_AUTH_TOKEN']).toBe('tok_123');
    expect(env['CODEBUDDY_SESSION_ID']).toBeUndefined();
  });

  it('清掉 SERVER__PORT 与 CLAUDE_SESSION_ID（端口冲突与串会话的来源）', () => {
    const env = withoutHostEnv({ SERVER__PORT: '57193', CLAUDE_SESSION_ID: 'x', HOME: '/home/u' });
    expect(env).toEqual({ HOME: '/home/u' });
  });

  it('不动无关变量（含其他产品的同名风格变量）', () => {
    const env = withoutHostEnv({ PATH: '/p', CLAUDE_PLUGIN_ROOT: '/plugin', KIMI_API_KEY: 'k' });
    expect(env).toEqual({ PATH: '/p', CLAUDE_PLUGIN_ROOT: '/plugin', KIMI_API_KEY: 'k' });
  });

  it('返回副本，不改入参', () => {
    const source = { CODEBUDDY_SESSION_ID: 'abc', PATH: '/p' };
    withoutHostEnv(source);
    expect(source.CODEBUDDY_SESSION_ID).toBe('abc');
  });

  it('isHostInjectedEnv 与清理结果一致', () => {
    expect(isHostInjectedEnv('CODEBUDDY_X')).toBe(true);
    expect(isHostInjectedEnv('CODEBUDDY_AUTH_TOKEN')).toBe(false);
    expect(isHostInjectedEnv('PATH')).toBe(false);
  });
});

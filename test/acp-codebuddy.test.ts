import { describe, expect, it } from 'vitest';
import {
  AcpAuthRequiredError,
  codebuddyAcpArgs,
  codebuddyAcpEnv,
  hasCodebuddyAcpAuth,
  runCodeBuddyAcpPrompt,
} from '../src/adapters/acp-codebuddy.js';

describe('CodeBuddy ACP adapter', () => {
  it('启动参数使用已验证的 --serve --acp --port 0', () => {
    expect(codebuddyAcpArgs()).toEqual(['--serve', '--acp', '--port', '0']);
  });

  it('清理 WorkBuddy 继承的端口/会话变量，保留显式 auth token', () => {
    const env = codebuddyAcpEnv({
      SERVER__PORT: '61899',
      CODEBUDDY_SESSION_ID: 'sess',
      CLAUDE_SESSION_ID: 'claude',
      CODEBUDDY_TOOL_CALL_ID: 'call',
      CODEBUDDY_ARTIFACTS: 'artifacts',
      CODEBUDDY_ROOT_REQUEST_ID: 'root',
      CODEBUDDY_CONVERSATION_REQUEST_ID: 'req',
      CODEBUDDY_CONVERSATION_MESSAGE_ID: 'msg',
      CODEBUDDY_AUTH_TOKEN: 'explicit-token',
      PATH: '/bin',
    });
    expect(env['SERVER__PORT']).toBeUndefined();
    expect(env['CODEBUDDY_SESSION_ID']).toBeUndefined();
    expect(env['CODEBUDDY_AUTH_TOKEN']).toBe('explicit-token');
    expect(env['PATH']).toBe('/bin');
  });

  it('没有显式 token 时拒绝启动，避免无认证 ACP 子进程', async () => {
    expect(hasCodebuddyAcpAuth({})).toBe(false);
    await expect(
      runCodeBuddyAcpPrompt({ cwd: process.cwd(), prompt: 'hi', env: {} }),
    ).rejects.toBeInstanceOf(AcpAuthRequiredError);
  });
});

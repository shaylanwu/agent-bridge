import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveCodeBuddyAuthToken } from '../src/adapters/acp-auth.js';
import {
  CODEBUDDY_ACP_SPEC,
  canRunAcp,
  codebuddyAcpEnv,
  hasCodebuddyAcpAuth,
} from '../src/adapters/acp-codebuddy.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function authDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-acp-auth-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), JSON.stringify(body));
  }
  return dir;
}

describe('CodeBuddy ACP auth', () => {
  it('选择未过期的明文 token，跳过加密信封', () => {
    const dir = authDir({
      'workbuddy-desktop.info': {
        auth: { accessToken: { $wbEncrypted: 1, envelope: 'x' }, expiresAt: Date.now() + 1000 },
      },
      'Tencent-Cloud.coding-copilot.info': {
        auth: { accessToken: 'jwt-token-with-enough-length-123', expiresAt: Date.now() + 1000 },
      },
    });
    expect(resolveCodeBuddyAuthToken(dir)).toBe('jwt-token-with-enough-length-123');
  });

  it('ACP 环境自动注入明文 token，并清理端口/会话变量', () => {
    const dir = authDir({
      'Tencent-Cloud.coding-copilot.info': {
        auth: { accessToken: 'jwt-token-with-enough-length-123', expiresAt: Date.now() + 1000 },
      },
    });
    const previous = process.env['CODEBUDDY_AUTH_DIR'];
    process.env['CODEBUDDY_AUTH_DIR'] = dir;
    try {
      const env = codebuddyAcpEnv({ SERVER__PORT: '61899', KEEP: '1' });
      expect(env['SERVER__PORT']).toBeUndefined();
      expect(env['KEEP']).toBe('1');
      expect(env['CODEBUDDY_AUTH_TOKEN']).toBe('jwt-token-with-enough-length-123');
      expect(hasCodebuddyAcpAuth({})).toBe(true);
      expect(canRunAcp(CODEBUDDY_ACP_SPEC, {})).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['CODEBUDDY_AUTH_DIR'];
      else process.env['CODEBUDDY_AUTH_DIR'] = previous;
    }
  });

  it('过期 token 不返回', () => {
    const dir = authDir({
      'x.info': { auth: { accessToken: 'expired-token-with-enough-length', expiresAt: 1 } },
    });
    expect(resolveCodeBuddyAuthToken(dir, 2)).toBeUndefined();
  });

});

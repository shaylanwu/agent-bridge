/**
 * CodeBuddy ACP 认证继承。
 *
 * WorkBuddy 桌面把 CodeBuddy 的登录态放在 CodeBuddyExtension 的 auth/*.info：
 *  - workbuddy-desktop.info 的 token 是 WorkBuddy 加密信封（本进程无法解密）
 *  - Tencent-Cloud.coding-copilot.info 是明文 JWT，可直接作为 CODEBUDDY_AUTH_TOKEN
 *
 * ACP 子进程必须显式拿到 CODEBUDDY_AUTH_TOKEN；仅继承父进程环境不足（桌面进程的
 * token 不落在可读环境里）。这里只负责“找到可用明文 token”，环境清理在适配器里做。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function codeBuddyAuthDir(): string {
  if (process.env['CODEBUDDY_AUTH_DIR']) return process.env['CODEBUDDY_AUTH_DIR'];
  if (process.platform === 'win32') {
    return join(
      process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
      'CodeBuddyExtension',
      'Data',
      'Public',
      'auth',
    );
  }
  if (process.platform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'CodeBuddyExtension',
      'Data',
      'Public',
      'auth',
    );
  }
  return join(
    homedir(),
    '.local',
    'share',
    'CodeBuddyExtension',
    'Data',
    'Public',
    'auth',
  );
}

interface AuthFile {
  auth?: {
    accessToken?: unknown;
    expiresAt?: unknown;
  };
}

/**
 * 找可用明文 token。只接受字符串 token；加密信封（$wbEncrypted）直接跳过。
 * 不读日志、不返回文件内容。
 */
export function resolveCodeBuddyAuthToken(
  dir = codeBuddyAuthDir(),
  now = Date.now(),
): string | undefined {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.info'))
    .sort((a, b) =>
      a.includes('coding-copilot') ? -1 : b.includes('coding-copilot') ? 1 : 0,
    );
  for (const name of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as AuthFile;
      const token = parsed.auth?.accessToken;
      if (typeof token !== 'string' || token.length < 20) continue;
      const expiresAt = parsed.auth?.expiresAt;
      if (typeof expiresAt === 'number' && expiresAt <= now) continue;
      return token;
    } catch {
      /* 跳过损坏/非 JSON 文件 */
    }
  }
  return undefined;
}

/**
 * 包元信息（CLI 支撑件）
 *
 * 从 package.json 读版本，而不是在代码里硬编码 —— 避免发版忘了改。
 * 读不到（例如被单包打包）时回落 0.0.0，绝不因此崩溃。
 */

import { readFileSync } from 'node:fs';

export function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

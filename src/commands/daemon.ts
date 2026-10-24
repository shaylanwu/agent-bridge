/**
 * `agent-bridge daemon` —— 后台常驻（Phase 3，**尚未实现**）
 *
 * 保留 stub 而不是删命令：README 与 `doc:check` 都声明了它，
 * 且用户按习惯敲 `daemon start` 时应该得到明确说明而不是「未知命令」。
 */

import { posFlag, type Flags } from '../cli/flags.js';
import { out } from '../cli/render.js';

export function cmdDaemon(flags: Flags): void {
  const sub = posFlag(flags, 1) || 'status';
  out.warn(`[agent-bridge] daemon ${sub} 尚未实现（Phase 3：systemd/launchd/Windows 服务）`);
  out.info('当前请用前台模式：agent-bridge connect <platformUrl>');
}

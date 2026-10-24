/**
 * `agent-bridge status` —— 扫描并打印本机工具状态
 *
 * 命令层只做：取参数 → 调能力 → 打印。业务逻辑不在这一层。
 */

import { boolFlag, type Flags } from '../cli/flags.js';
import { printAgents } from '../cli/render.js';
import { scanAgents } from '../core/scan.js';

export async function cmdStatus(flags: Flags): Promise<void> {
  const items = await scanAgents({ fresh: boolFlag(flags, 'fresh') });
  if (boolFlag(flags, 'json')) {
    console.log(JSON.stringify({ agents: items, scannedAt: new Date().toISOString() }, null, 2));
    return;
  }
  printAgents(items);
}

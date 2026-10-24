/**
 * `agent-bridge connect` —— 绑定设备并保持出站长连接
 *
 * 命令层只做两件事：把凭证与配置交给 `app/bootstrap.ts` 起会话，然后注册退出信号并保活。
 * 「连上平台之后干什么」在 `app/session.ts`，与 `serve` 共用同一份（不复制一份授权流程）。
 */

import type { SessionLog } from '../app/session-log.js';
import { startBridge } from '../app/bootstrap.js';
import type { Flags } from '../cli/flags.js';
import { hold } from '../cli/hold.js';
import { C, out } from '../cli/render.js';

export async function cmdConnect(flags: Flags): Promise<void> {
  const log: SessionLog = (level, line) => {
    if (level === 'info') console.log(C.dim(line));
    else console.error(level === 'error' ? C.red(line) : C.yellow(line));
  };

  const { session } = await startBridge(flags, log);
  out.info('[agent-bridge] 已就绪（Ctrl+C 退出）');
  await hold(() => session.close());
}

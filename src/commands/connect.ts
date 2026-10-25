/**
 * `agent-bridge connect` —— 绑定设备并保持出站长连接
 *
 * 命令层只做两件事：把凭证与配置交给 `app/bootstrap.ts` 起会话，然后注册退出信号并保活。
 * 「连上平台之后干什么」在 `app/session.ts`，与 `serve` 共用同一份（不复制一份授权流程）。
 *
 * TTY 下挂常驻任务面板（C 批次）：主窗口只留状态表，任务日志不滚动
 * （上行走 task_log，本机查看走 Web 面板）。非 TTY 退化为逐行日志。
 */

import { hostname } from 'node:os';
import type { SessionLog } from '../app/session-log.js';
import { startBridge } from '../app/bootstrap.js';
import type { Flags } from '../cli/flags.js';
import { hold } from '../cli/hold.js';
import { panelLog, startPanel } from '../cli/panel.js';
import { C, out } from '../cli/render.js';
import { defaultSupervisor } from '../core/task-supervisor.js';

export async function cmdConnect(flags: Flags): Promise<void> {
  // 两阶段：授权/建连期逐行日志；会话起来后（TTY）切面板模式
  let log: SessionLog = (level, line) => {
    if (level === 'info') console.log(C.dim(line));
    else console.error(level === 'error' ? C.red(line) : C.yellow(line));
  };

  const { session, config } = await startBridge(flags, (level, line) => log(level, line));

  const panel = startPanel({
    registry: session.registry,
    capacity: () => defaultSupervisor.capacitySnapshot(),
    platformUrl: config?.platformUrl ?? '',
    deviceName: config?.label ?? hostname(),
  });
  if (panel) log = panelLog(panel);

  out.info('[agent-bridge] 已就绪（Ctrl+C 退出）');
  await hold(() => {
    panel?.stop();
    session.close();
  });
}

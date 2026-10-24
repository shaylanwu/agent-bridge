/**
 * `agent-bridge serve` —— 在**已有主流程之上**附加一个本地回环控制面
 *
 * 分主次：主流程仍然是「连平台、收指令、跑任务、回传」，控制面是**附加物**——
 *   · 不配置就完全不启用（默认关闭），`connect` 的行为一个字节都不变；
 *   · 控制面下发的任务同样走 `TaskSupervisor`（并发上限与队列对两条通道同时生效）；
 *   · 上行同样只经 `Emitter`（平台侧视图不出现"半边失踪"）。
 *
 * 它服务的是**本机上的其它程序**（IDE 插件、脚本、MCP server、CI runner），
 * 不是远程平台 —— 远程平台永远走那条出站 WebSocket。
 */

import { startBridge } from '../app/bootstrap.js';
import type { SessionLog } from '../app/session-log.js';
import { numFlag, type Flags } from '../cli/flags.js';
import { hold } from '../cli/hold.js';
import { C, out } from '../cli/render.js';
import { scanAgents } from '../core/scan.js';
import { resolveControlPlane, resolveDiffMaxBytes, resolveMaxQueued, resolveMaxTasks } from '../infra/config.js';
import { PROTOCOL_CAPABILITIES } from '../protocol.js';
import { version } from '../cli/meta.js';
import { startTask } from '../runner.js';
import { startControlPlane } from '../transport/control-plane.js';

export async function cmdServe(flags: Flags): Promise<void> {
  const log: SessionLog = (level, line) => {
    if (level === 'info') console.log(C.dim(line));
    else console.error(level === 'error' ? C.red(line) : C.yellow(line));
  };

  const { session, config } = await startBridge(flags, log);

  const settings = resolveControlPlane(config?.controlPlane);
  const portFlag = numFlag(flags, 'port', -1);
  const port = portFlag > 0 ? portFlag : settings.port;

  // 默认关闭是红线：没显式开启就一个端口都不监听，此时 serve 完全退化成 connect
  if (!settings.enabled && portFlag <= 0) {
    out.warn('[agent-bridge] 控制面默认关闭，本次未启动 —— 主流程行为与 connect 一致');
    out.info('启用：`[control_plane] enabled = true` 写入配置，或本次带 --port=8787');
    await hold(() => session.close());
    return;
  }

  const plane = await startControlPlane(
    { enabled: true, host: settings.host, port, requireToken: settings.requireToken },
    {
      emitter: session.emitter,
      // 与平台下发的任务共用同一个 supervisor：并发上限不会因多开一条通道而翻倍
      startTask: (req, hooks) => startTask(req, hooks),
      scan: (opts) => scanAgents(opts),
      log,
      capabilities: PROTOCOL_CAPABILITIES,
      version: version(),
      defaults: {
        allowedCwd: config?.allowedCwd,
        maxConcurrent: resolveMaxTasks(config?.maxTasks),
        maxQueued: resolveMaxQueued(config?.maxQueued),
        diffMaxBytes: resolveDiffMaxBytes(config?.diffMaxBytes),
        captureDiffByDefault: config?.diffDefault === true,
      },
    },
  );

  out.ok(`✅ 控制面已就绪 ${plane.url}/v1/health（只绑回环，不出网）`);
  out.info(`   能力清单 ${plane.url}/v1/capabilities ；任务事件 ${plane.url}/v1/tasks/{id}/events`);
  if (settings.requireToken) {
    out.info('   调用需带 scoped 令牌：`agent-bridge services issue --scopes=task:create,task:read`');
  }

  await hold(() => {
    plane.close();
    session.close();
  });
}

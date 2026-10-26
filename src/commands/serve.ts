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

import { hostname } from 'node:os';
import { startBridge } from '../app/bootstrap.js';
import type { SessionLog } from '../app/session-log.js';
import { numFlag, numFlagMin, type Flags } from '../cli/flags.js';
import { hold } from '../cli/hold.js';
import { panelLog, startPanel } from '../cli/panel.js';
import { C, out } from '../cli/render.js';
import { scanAgents } from '../core/scan.js';
import { defaultSupervisor } from '../core/task-supervisor.js';
import { resolveControlPlane, resolveDiffMaxBytes, resolveMaxQueued, resolveMaxTasks } from '../infra/config.js';
import { verifyServiceToken, type ServiceScope } from '../infra/service-token.js';
import { JwtVerifier } from '../infra/jwt.js';
import { PROTOCOL_CAPABILITIES } from '../protocol.js';
import { randomBytes } from 'node:crypto';
import { version } from '../cli/meta.js';
import { startTask } from '../runner.js';
import { startControlPlane } from '../transport/control-plane.js';

export async function cmdServe(flags: Flags): Promise<void> {
  // 两阶段：授权/建连期逐行日志；会话起来后（TTY）切面板模式
  let log: SessionLog = (level, line) => {
    if (level === 'info') console.log(C.dim(line));
    else console.error(level === 'error' ? C.red(line) : C.yellow(line));
  };

  const { session, config } = await startBridge(flags, (level, line) => log(level, line));

  const settings = resolveControlPlane(config?.controlPlane);
  const portFlag = numFlag(flags, 'port', -1);
  const port = portFlag > 0 ? portFlag : settings.port;

  // 默认关闭是红线：没显式开启就一个端口都不监听，此时 serve 完全退化成 connect
  if (!settings.enabled && portFlag <= 0) {
    out.warn('[agent-bridge] 控制面默认关闭，本次未启动 —— 主流程行为与 connect 一致');
    out.info('启用：`[control_plane] enabled = true` 写入配置，或本次带 --port=8787');
    const panel = startPanel({
      registry: session.registry,
      capacity: () => defaultSupervisor.capacitySnapshot(),
      platformUrl: config?.platformUrl ?? '',
      deviceName: config?.label ?? hostname(),
    });
    if (panel) log = panelLog(panel);
    await hold(() => {
      panel?.stop();
      session.close();
    });
    return;
  }
  // Web 面板的只读内存令牌（2026-10-25 用户拍板）：进程内生成、不落盘、随进程退出失效，
  // scope 只放行 task:read / device:read —— 面板 URL 直接拼上它，点开即用；
  // 需要写操作（下发/取消任务）的调用方仍走 `services issue` 签发的落盘令牌。
  const uiToken = `abs_ui_${randomBytes(16).toString('hex')}`;
  const verifyWithUi = (token: string | undefined, scope: ServiceScope): ReturnType<typeof verifyServiceToken> => {
    if (token === uiToken && (scope === 'task:read' || scope === 'device:read')) return { ok: true };
    return verifyServiceToken(token, scope);
  };

  const plane = await startControlPlane(
    { enabled: true, host: settings.host, port, requireToken: settings.requireToken },
    {
      emitter: session.emitter,
      registry: session.registry,
      store: session.store,
      artifacts: session.artifacts,
      artifactsForTenant: (tenantId) => session.artifactsForTenant(tenantId),
      // 与平台下发的任务共用同一个 supervisor：并发上限不会因多开一条通道而翻倍
      startTask: (req, hooks) => startTask(req, hooks),
      scan: (opts) => scanAgents(opts),
      log,
      verify: verifyWithUi,
      ...(config?.jwt
        ? {
            jwt: new JwtVerifier({
              jwks: config.jwt.jwksUrl,
              issuer: config.jwt.issuer,
              audience: config.jwt.audience,
              tenantClaim: config.jwt.tenantClaim,
              cacheMs: config.jwt.cacheMs,
            }),
          }
        : {}),
      capabilities: PROTOCOL_CAPABILITIES,
      version: version(),
      defaults: {
        allowedCwd: config?.allowedCwd,
        // 与主流程同一优先级链：--max-tasks/--max-queue > 环境变量 > config > 默认
        maxConcurrent: resolveMaxTasks(config?.maxTasks, numFlagMin(flags, 'max-tasks', 1)),
        maxQueued: resolveMaxQueued(config?.maxQueued, numFlagMin(flags, 'max-queue', 0)),
        diffMaxBytes: resolveDiffMaxBytes(config?.diffMaxBytes),
        captureDiffByDefault: config?.diffDefault === true,
      },
    },
  );

  const boardUrl = `${plane.url}/?token=${uiToken}`;

  // 面板盒已承载这些信息；仅非 TTY（无面板）才逐行打印（2026-10-25 用户指出重复）
  if (!process.stdout.isTTY) {
    out.ok(`✅ 控制面已就绪 ${plane.url}/v1/health（只绑回环，不出网）`);
    out.ok(`📊 Web 任务面板 ${boardUrl}`);
    out.info('   ↑ 点开即用（内嵌只读令牌，本进程有效）；写操作仍需 `services issue` 签发的令牌');
  }

  const panel = startPanel({
    registry: session.registry,
    capacity: () => defaultSupervisor.capacitySnapshot(),
    platformUrl: config?.platformUrl ?? '',
    deviceName: config?.label ?? hostname(),
    webUrl: boardUrl,
  });
  if (panel) log = panelLog(panel);

  await hold(() => {
    panel?.stop();
    plane.close();
    session.close();
  });
}

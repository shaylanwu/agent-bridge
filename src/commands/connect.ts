/**
 * `agent-bridge connect` —— 绑定设备并保持出站长连接
 *
 * 命令层只做两件事：把凭证与配置交给 `app/bootstrap.ts` 起会话，然后注册退出信号并保活。
 * 「连上平台之后干什么」在 `app/session.ts`，与 `serve` 共用同一份（不复制一份授权流程）。
 *
 * TTY 下挂常驻任务面板（C 批次）：主窗口只留状态表，任务日志不滚动
 * （上行走 task_log，本机查看走 Web 面板）。非 TTY 退化为逐行日志。
 */

import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { SessionLog } from '../app/session-log.js';
import { startBridge } from '../app/bootstrap.js';
import { numFlagMin, type Flags } from '../cli/flags.js';
import { hold } from '../cli/hold.js';
import { version } from '../cli/meta.js';
import { panelLog, startPanel } from '../cli/panel.js';
import { C, out } from '../cli/render.js';
import { withPortFallback } from '../core/port-fallback.js';
import { scanAgents } from '../core/scan.js';
import { defaultSupervisor } from '../core/task-supervisor.js';
import {
  resolveControlPlane,
  resolveDiffMaxBytes,
  resolveMaxQueued,
  resolveMaxTasks,
} from '../infra/config.js';
import { JwtVerifier } from '../infra/jwt.js';
import { acquireBridgeRuntimeLock } from '../infra/profile-lock.js';
import { stateDir } from '../infra/config.js';
import { verifyServiceToken, type ServiceScope } from '../infra/service-token.js';
import { PROTOCOL_CAPABILITIES } from '../protocol.js';
import { startTask } from '../runner.js';
import { startControlPlane } from '../transport/control-plane.js';


export async function cmdConnect(flags: Flags): Promise<void> {
  const runtime = await acquireBridgeRuntimeLock(stateDir());
  try {
    await runConnect(flags);
  } finally {
    await runtime.release().catch(() => undefined);
  }
}

async function runConnect(flags: Flags): Promise<void> {
  // 两阶段：授权/建连期逐行日志；会话起来后（TTY）切面板模式
  let log: SessionLog = (level, line) => {
    if (level === 'info') console.log(C.dim(line));
    else console.error(level === 'error' ? C.red(line) : C.yellow(line));
  };

  const { session, config } = await startBridge(flags, (level, line) => log(level, line));

  // connect 默认自带本机 Web 面板：不进 serve、不额外加参数，也能直接打开看任务。
  // 只绑回环、必须带令牌；端口占用时从 8787 起顺延，全部失败才降级为无 Web 面板。
  const settings = resolveControlPlane(config?.controlPlane);
  const uiToken = `abs_ui_${randomBytes(16).toString('hex')}`;
  const verifyWithUi = (token: string | undefined, scope: ServiceScope): ReturnType<typeof verifyServiceToken> => {
    if (token === uiToken && (scope === 'task:read' || scope === 'device:read')) return { ok: true };
    return verifyServiceToken(token, scope);
  };
  let plane: Awaited<ReturnType<typeof startControlPlane>> | undefined;
  let webUrl: string | undefined;
  const basePort = settings.port > 0 ? settings.port : 8787;
  try {
    plane = await withPortFallback(basePort, 20, (port) =>
      startControlPlane(
        { enabled: true, host: settings.host, port, requireToken: settings.requireToken },
        {
          emitter: session.emitter,
          registry: session.registry,
          store: session.store,
          artifacts: session.artifacts,
          artifactsForTenant: (tenantId) => session.artifactsForTenant(tenantId),
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
            maxConcurrent: resolveMaxTasks(config?.maxTasks, numFlagMin(flags, 'max-tasks', 1)),
            maxQueued: resolveMaxQueued(config?.maxQueued, numFlagMin(flags, 'max-queue', 0)),
            diffMaxBytes: resolveDiffMaxBytes(config?.diffMaxBytes),
            captureDiffByDefault: config?.diffDefault === true,
          },
        },
      ),
    );
    if (plane) webUrl = `${plane.url}/?token=${uiToken}`;
  } catch (error) {
    log('warn', `[agent-bridge] 本机 Web 面板启动失败：${(error as Error).message}`);
  }
  if (!plane) {
    log('warn', `[agent-bridge] ${basePort} 起连续 20 个端口均不可用，本次不提供 Web 面板`);
  }

  if (!process.stdout.isTTY && webUrl) {
    out.ok(`📊 Web 任务面板 ${webUrl}`);
  }

  const panel = startPanel({
    registry: session.registry,
    capacity: () => defaultSupervisor.capacitySnapshot(),
    platformUrl: config?.platformUrl ?? '',
    deviceName: config?.label ?? hostname(),
    ...(webUrl ? { webUrl } : {}),
  });
  if (panel) log = panelLog(panel);

  log('info', '[agent-bridge] 已就绪（Ctrl+C 退出）');
  await hold(() => {
    panel?.stop();
    plane?.close();
    session.close();
  });
}

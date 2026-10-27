/**
 * 会话启动（应用编排层）
 *
 * `connect` 与 `serve` 共用同一段"取凭证 → 建会话"的流程：
 * 抽出来是为了不复制一份授权交互（复制品的必然结局是两边慢慢不一致）。
 *
 * 这里只负责**把会话建起来**，不负责"建完之后要一直活着还是顺便开个控制面"—— 那是命令层的事。
 */

import { hostname } from 'node:os';
import { join } from 'node:path';
import { version } from '../cli/meta.js';
import type { Flags } from '../cli/flags.js';
import { boolFlag, numFlagMin, posFlag, strFlag } from '../cli/flags.js';
import type { SessionLog } from './session-log.js';
import { createSession, type BridgeSession } from './session.js';
import { TaskRegistry } from './task-registry.js';
import {
  AuthError,
  authorizeWithBrowser,
  authorizeWithDeviceCode,
  refreshDeviceToken,
} from '../infra/auth.js';
import {
  configPath,
  loadConfig,
  resolveDiffMaxBytes,
  resolveExternalSandbox,
  resolveInteractionEnabled,
  resolveInteractionTimeoutMs,
  resolveMaxInteractionsPerTask,
  resolveApprovalLedgerEnabled,
  resolveApprovalTtlMs,
  resolveMaxQueued,
  resolveMaxTasks,
  resolvePermissionPolicy,
  resolveSessionIdleMs,
  saveConfig,
  stateDbPath,
  stateDir,
  tokenTail,
  type BridgeConfig,
} from '../infra/config.js';
import { SessionStore } from '../core/session-store.js';
import { ensureDeviceIdentity } from '../infra/device-identity-store.js';
import { withProfileLock } from '../infra/profile-lock.js';

export interface BridgeBootstrap {
  session: BridgeSession;
  /** 最新生效配置；显式 token 仅存在于内存配置中，不写入磁盘 */
  config: BridgeConfig | null;
}

export async function startBridge(flags: Flags, log: SessionLog): Promise<BridgeBootstrap> {
  const platformArg = posFlag(flags, 1);
  if (!platformArg) {
    log('error', '用法：agent-bridge connect <platformUrl> [--token=xxx] [--no-browser]');
    process.exit(2);
  }
  const targetUrl = platformArg.replace(/\/+$/, '');
  const explicitToken = strFlag(flags, 'token');

  // 身份、授权和凭证写在同一 profile 锁内；WS 会话不持锁。
  const prepared = await withProfileLock(stateDir(), async () => {
    const saved = loadConfig();
    const reusable = !explicitToken && saved?.platformUrl === targetUrl && saved.deviceToken;
    const identity = await ensureDeviceIdentity({
      identityPath: join(stateDir(), 'identity.toml'),
      legacyDeviceId: saved?.deviceId,
      explicitDeviceId: strFlag(flags, 'device-id'),
      envDeviceId: process.env['AGENT_BRIDGE_DEVICE_ID'],
      allowCreate: !explicitToken && !reusable,
      hasReusableCredential: Boolean(explicitToken || reusable),
    });
    const deviceId = identity.deviceId;
    log('info', `[agent-bridge] 设备身份 ${identity.source}（${deviceId}）`);

    if (explicitToken) {
      const config: BridgeConfig & { deviceToken: string } = {
        ...saved,
        platformUrl: targetUrl,
        deviceId,
        deviceToken: explicitToken,
      };
      // 显式 token 不继承旧凭证的刷新令牌或绑定时间，也不写入磁盘。
      delete config.refreshToken;
      delete config.boundAt;
      return { deviceId, deviceToken: explicitToken, config };
    }

    if (reusable) {
      if (!saved?.deviceToken) throw new Error('可复用配置缺少设备凭证，请重新授权。');
      const deviceToken = saved.deviceToken;
      log('info', `复用已保存的设备凭证（${deviceId}，token ${tokenTail(deviceToken)}）`);
      return { deviceId, deviceToken, config: saved };
    }

    log('info', '[agent-bridge] 开始设备授权…');
    const context = {
      platformUrl: targetUrl,
      deviceId,
      hostname: hostname(),
      platform: process.platform,
      cliVersion: version(),
    };
    try {
      const res = !boolFlag(flags, 'no-browser')
        ? await authorizeWithBrowser(context, {
            onPrompt: (url) =>
              log('info', `[agent-bridge] 已打开浏览器，若无反应请手动访问：\n  ${url}`),
          })
        : await authorizeWithDeviceCode(context, {
            onPrompt: (uri, code) =>
              log('info', `[agent-bridge] 请在浏览器打开 ${uri} 并输入验证码：${code}`),
          });
      const config = {
        ...saved,
        platformUrl: targetUrl,
        deviceId,
        deviceToken: res.deviceToken,
        refreshToken: res.refreshToken,
        label: strFlag(flags, 'label') ?? saved?.label ?? hostname(),
        boundAt: new Date().toISOString(),
      };
      await saveConfig(config);
      log('info', `✅ 设备绑定成功（${deviceId}），配置已写入 ${configPath()}`);
      return { deviceId, deviceToken: res.deviceToken, config };
    } catch (e) {
      if (e instanceof AuthError) log('error', `❌ 授权失败：${e.message}`);
      // 不在锁内退出进程；cli.ts 顶层捕获后退出，finally 始终释放锁。
      throw e;
    }
  });

  const { config: saved, deviceId, deviceToken } = prepared;
  if (saved.allowedCwd?.length) {
    log('info', `[agent-bridge] 目录白名单已启用（${saved.allowedCwd.length} 个条目），越界任务将被拒绝`);
  }
  if (saved.requireServiceToken) {
    log('info', '[agent-bridge] 已开启 require_service_token：无有效服务令牌的任务将被拒绝');
  }

  // 启动参数优先级最高：--max-tasks / --max-queue > 环境变量 > config.toml > 默认（30 / 60）
  const maxTasksOverride = numFlagMin(flags, 'max-tasks', 1);
  const maxQueueOverride = numFlagMin(flags, 'max-queue', 0);
  // 权限策略：非法值由 resolvePermissionPolicy 回落到 default（失败关闭）
  const permissionPolicyOverride = strFlag(flags, 'permission-policy');
  const externalSandboxOverride = boolFlag(flags, 'external-sandbox') || undefined;
  // 交互开关与额度：缺省全关（不发交互请求），显式 --interaction-enabled 才开
  const interactionEnabledOverride = boolFlag(flags, 'interaction-enabled') || undefined;
  const interactionTimeoutOverride = numFlagMin(flags, 'interaction-timeout-ms', 1000);
  const maxInteractionsOverride = numFlagMin(flags, 'max-interactions-per-task', 1);
  const approvalLedgerOverride = boolFlag(flags, 'approval-ledger') || undefined;
  const approvalTtlOverride = numFlagMin(flags, 'approval-ttl-ms', 60_000);

  const store = new SessionStore(stateDbPath());
  const recovered = store.recoverInterrupted();
  if (recovered > 0) {
    log('info', `[agent-bridge] 已恢复 ${recovered} 个上次中断的会话（未自动重放副作用）`);
  }
  let session: BridgeSession;
  let refreshToken = saved?.refreshToken;
  const refresh = refreshToken
    ? () =>
        refreshDeviceToken(
          {
            platformUrl: targetUrl,
            deviceId,
            hostname: hostname(),
            platform: process.platform,
            cliVersion: version(),
          },
          refreshToken as string,
        )
    : undefined;
  try {
    session = createSession({
      platformUrl: targetUrl,
      deviceToken,
      deviceId,
      refresh,
      onTokenRefreshed: (tokens) => {
        refreshToken = tokens.refreshToken ?? refreshToken;
        if (!saved) return;
        saved.deviceToken = tokens.deviceToken;
        if (refreshToken) saved.refreshToken = refreshToken;
        const bound = {
          ...saved,
          platformUrl: saved.platformUrl ?? targetUrl,
          deviceId: saved.deviceId ?? deviceId,
          deviceToken: tokens.deviceToken,
          ...(refreshToken ? { refreshToken } : {}),
        };
        void saveConfig(bound);
      },
      cliVersion: version(),
      hostname: hostname(),
      allowedCwd: saved.allowedCwd,
      maxConcurrent: resolveMaxTasks(saved.maxTasks, maxTasksOverride),
      maxQueued: resolveMaxQueued(saved.maxQueued, maxQueueOverride),
      diffMaxBytes: resolveDiffMaxBytes(saved.diffMaxBytes),
      captureDiffByDefault: saved.diffDefault === true,
      requireServiceToken: saved.requireServiceToken === true,
      permissionPolicy: resolvePermissionPolicy(saved.permissionPolicy, permissionPolicyOverride),
      externalSandbox: resolveExternalSandbox(saved.externalSandbox, externalSandboxOverride),
      interactionEnabled: resolveInteractionEnabled(saved.interactionEnabled, interactionEnabledOverride),
      interactionTimeoutMs: resolveInteractionTimeoutMs(saved.interactionTimeoutMs, interactionTimeoutOverride),
      maxInteractionsPerTask: resolveMaxInteractionsPerTask(
        saved.maxInteractionsPerTask,
        maxInteractionsOverride,
      ),
      approvalLedgerEnabled: resolveApprovalLedgerEnabled(saved.approvalLedgerEnabled, approvalLedgerOverride),
      approvalTtlMs: resolveApprovalTtlMs(saved.approvalTtlMs, approvalTtlOverride),
      sessionIdleMs: resolveSessionIdleMs(saved.sessionIdleMs),
      registry: new TaskRegistry(),
      store,
      artifactRootDir: join(stateDir(), 'artifacts'),
      log,
    });
  } catch (error) {
    store.close();
    throw error;
  }

  return { session, config: saved };
}

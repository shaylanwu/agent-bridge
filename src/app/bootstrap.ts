/**
 * 会话启动（应用编排层）
 *
 * `connect` 与 `serve` 共用同一段"取凭证 → 建会话"的流程：
 * 抽出来是为了不复制一份授权交互（复制品的必然结局是两边慢慢不一致）。
 *
 * 这里只负责**把会话建起来**，不负责"建完之后要一直活着还是顺便开个控制面"—— 那是命令层的事。
 */

import { hostname } from 'node:os';
import { version } from '../cli/meta.js';
import type { Flags } from '../cli/flags.js';
import { boolFlag, posFlag, strFlag } from '../cli/flags.js';
import type { SessionLog } from './session-log.js';
import { createSession, type BridgeSession } from './session.js';
import { AuthError, authorizeWithBrowser, authorizeWithDeviceCode } from '../infra/auth.js';
import {
  configPath,
  loadConfig,
  resolveDiffMaxBytes,
  resolveMaxQueued,
  resolveMaxTasks,
  saveConfig,
  tokenTail,
  type BridgeConfig,
} from '../infra/config.js';
import { resolveDeviceId } from '../transport/bridge-client.js';

export interface BridgeBootstrap {
  session: BridgeSession;
  /** 生效的配置（可能为 null：--token 模式下本地没存过配置） */
  config: BridgeConfig | null;
}

export async function startBridge(flags: Flags, log: SessionLog): Promise<BridgeBootstrap> {
  const platformUrl = posFlag(flags, 1);
  if (!platformUrl) {
    log('error', '用法：agent-bridge connect <platformUrl> [--token=xxx] [--no-browser]');
    process.exit(2);
  }

  const saved = loadConfig();
  let deviceToken = strFlag(flags, 'token');
  // 只在授权/复用配置时被赋值；--token 模式下由下面的 resolveDeviceId 解析
  let deviceId = '';
  let boundUrl = saved?.platformUrl ?? '';

  if (!deviceToken) {
    if (saved?.platformUrl === platformUrl.replace(/\/+$/, '') && saved.deviceToken) {
      deviceToken = saved.deviceToken;
      deviceId = saved.deviceId;
      boundUrl = saved.platformUrl;
      log('info', `复用已保存的设备凭证（${deviceId}，token ${tokenTail(deviceToken)}）`);
    } else {
      log('info', '[agent-bridge] 开始设备授权…');
      const useBrowser = !boolFlag(flags, 'no-browser');
      try {
        const res = useBrowser
          ? await authorizeWithBrowser(platformUrl, {
              onPrompt: (url) =>
                log('info', `[agent-bridge] 已打开浏览器，若无反应请手动访问：\n  ${url}`),
            })
          : await authorizeWithDeviceCode(platformUrl, {
              onPrompt: (uri, code) =>
                log('info', `[agent-bridge] 请在浏览器打开 ${uri} 并输入验证码：${code}`),
            });
        deviceToken = res.deviceToken;
        deviceId = res.deviceId;
        boundUrl = res.platformUrl;
        saveConfig({
          platformUrl: res.platformUrl,
          deviceId: res.deviceId,
          deviceToken: res.deviceToken,
          refreshToken: res.refreshToken,
          label: strFlag(flags, 'label') ?? hostname(),
          boundAt: new Date().toISOString(),
        });
        log('info', `✅ 设备绑定成功（${res.deviceId}），配置已写入 ${configPath()}`);
      } catch (e) {
        if (e instanceof AuthError) {
          log('error', `❌ 授权失败：${e.message}`);
          process.exit(1);
        }
        throw e;
      }
    }
  }

  // deviceId 解析优先级：授权响应 > --device-id > AGENT_BRIDGE_DEVICE_ID > 已保存配置（同平台）
  const targetUrl = (boundUrl || platformUrl).replace(/\/+$/, '');
  const savedId = saved && saved.platformUrl === targetUrl ? saved.deviceId : '';
  deviceId = resolveDeviceId({
    fromAuth: deviceId,
    flag: strFlag(flags, 'device-id') ?? '',
    env: process.env['AGENT_BRIDGE_DEVICE_ID'] ?? '',
    saved: savedId,
  });
  if (!deviceId) {
    log(
      'warn',
      '[agent-bridge] 未提供 deviceId（--device-id / AGENT_BRIDGE_DEVICE_ID）：' +
        '连接将不带 deviceId 参数，平台需按 Bearer token 反查设备',
    );
  }

  if (saved?.allowedCwd?.length) {
    log('info', `[agent-bridge] 目录白名单已启用（${saved.allowedCwd.length} 个条目），越界任务将被拒绝`);
  }
  if (saved?.requireServiceToken) {
    log('info', '[agent-bridge] 已开启 require_service_token：无有效服务令牌的任务将被拒绝');
  }

  const session = createSession({
    platformUrl: boundUrl || platformUrl,
    deviceToken,
    deviceId,
    cliVersion: version(),
    hostname: hostname(),
    allowedCwd: saved?.allowedCwd,
    maxConcurrent: resolveMaxTasks(saved?.maxTasks),
    maxQueued: resolveMaxQueued(saved?.maxQueued),
    diffMaxBytes: resolveDiffMaxBytes(saved?.diffMaxBytes),
    captureDiffByDefault: saved?.diffDefault === true,
    requireServiceToken: saved?.requireServiceToken === true,
    log,
  });

  return { session, config: saved };
}

/**
 * `agent-bridge logout` —— 清除本地设备凭证
 *
 * 只清本地：平台侧的"设备下线"是对端动作，必须提示用户去平台吊销（否则会出现
 * 「本地已登出但平台还挂着这台设备」的错配）。
 */

import { out } from '../cli/render.js';
import { clearConfig, loadConfig, stateDir } from '../infra/config.js';
import { withProfileLock } from '../infra/profile-lock.js';

export async function cmdLogout(): Promise<void> {
  await withProfileLock(stateDir(), async () => {
    const cfg = loadConfig();
    if (!cfg) {
      out.info('[agent-bridge] 未绑定任何平台');
      return;
    }
    await clearConfig();
    out.ok(`✅ 已清除本地设备凭证（${cfg.deviceId}），设备身份与业务设置已保留`);
    out.info('提示：如需让平台侧同步下线，请到「设备管理」里吊销该设备。');
  });
}

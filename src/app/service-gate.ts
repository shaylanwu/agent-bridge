/**
 * 服务身份校验（P0-8）—— 应用编排层
 *
 * 兼容策略（不能变，平台靠它平滑升级）：
 *  - 本地没登记任何令牌、且未开启 `require_service_token` → 放行，与 v1 行为**完全一致**；
 *  - 一旦报文带了令牌 → **必须**校验通过，不存在"带了也跳过"的口子。
 *
 * 校验结果一律落审计（成功与失败都落），失败再映射成受控错误码回给平台。
 */

import { tokenDenyCode, type BridgeErrorCode } from '../core/errors.js';
import { writeAudit } from '../infra/audit.js';
import { verifyServiceToken, type ServiceScope } from '../infra/service-token.js';

export type GateResult =
  | { ok: true; serviceId?: string }
  | { ok: false; message: string; code: BridgeErrorCode };

export interface ServiceIdentityInput {
  serviceToken?: string;
  requestedBy?: string;
  purpose?: string;
}

export function authorizeService(
  msg: ServiceIdentityInput,
  action: 'run_task' | 'cancel_task',
  taskId: string,
  scope: ServiceScope,
  requireToken: boolean,
): GateResult {
  if (!msg.serviceToken && !requireToken) return { ok: true };

  const res = verifyServiceToken(msg.serviceToken, scope);
  const at = new Date().toISOString();
  if (res.ok) {
    writeAudit({
      at,
      action,
      outcome: 'allowed',
      taskId,
      requestedBy: msg.requestedBy,
      purpose: msg.purpose,
      serviceId: res.record?.id,
      scopes: res.record?.scopes,
    });
    return { ok: true, serviceId: res.record?.id };
  }

  writeAudit({
    at,
    action,
    outcome: 'denied',
    taskId,
    requestedBy: msg.requestedBy,
    purpose: msg.purpose,
    serviceId: res.record?.id,
    scopes: res.record?.scopes,
    reason: res.message,
  });
  return { ok: false, message: res.message ?? '服务令牌校验失败', code: tokenDenyCode(res.reason) };
}

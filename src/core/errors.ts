/**
 * 受控错误码（架构第一期）
 *
 * 为什么要有这块：`task_status.error` 现在是自由文案，第三方平台无法**程序化**处理
 * （"该工具不支持"到底是没装、没凭据、还是装坏了？只能靠匹配中文子串，一改文案就崩）。
 *
 * 口径与平台侧 design §7 的错误分类表一致，两端共用同一张码表；
 * `error` 保留人类可读串（给 UI 直接显示），`errorCode` 给程序分支用 —— 两者并存，不互相替代。
 */

export const BRIDGE_ERROR_CODES = [
  // —— 设备/协议层（bridge 侧产生）——
  'protocol_incompatible', // 协议版本不满足
  'tool_not_installed', // 白名单内但本机没装（或 kind 未知）
  'tool_no_credentials', // 装了但缺凭据
  'tool_broken', // 装了但执行失败（--version 非 0）
  'cwd_missing', // 工作目录不存在
  'cwd_not_allowed', // 不在 allowed_cwd 白名单内
  'device_busy', // 并发与队列都满，装不下
  'timeout', // 任务超时（含排队超时）
  'cancelled', // 被取消
  'agent_error', // CLI 非 0 退出 / 启动失败
  'internal', // bridge 自身异常
  // —— 服务身份（P0-8）——
  'unauthorized', // 未提供服务令牌（开启 require_service_token 时）
  'invalid_token', // 令牌格式非法 / 未登记 / 不匹配
  'token_expired', // 令牌过期或已吊销
  'insufficient_scope', // 令牌有效但 scope 不足
  'tenant_not_supported', // 带了租户声明，但当前控制面尚未按租户分区读取
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export function isBridgeErrorCode(v: unknown): v is BridgeErrorCode {
  return typeof v === 'string' && (BRIDGE_ERROR_CODES as readonly string[]).includes(v);
}

/** 携带机器可读码的错误；`message` 仍是人类可读文案 */
export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: BridgeErrorCode, message?: string, data?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'BridgeError';
    this.code = code;
    if (data) this.data = data;
  }
}

/**
 * 受控错误码 → HTTP 状态码（RFC 9457 Problem Details 用，本地控制面）
 *
 * 映射只表达"语义相近"，不追求严格：控制面是本机回环通道，
 * 状态码主要给客户端做分支，细节仍在 `code` 字段里。
 */
export const ERROR_HTTP_STATUS: Record<BridgeErrorCode, number> = {
  protocol_incompatible: 400,
  tool_not_installed: 400,
  tool_no_credentials: 400,
  tool_broken: 400,
  cwd_missing: 400,
  cwd_not_allowed: 403,
  device_busy: 409,
  timeout: 504,
  cancelled: 409,
  agent_error: 502,
  internal: 500,
  unauthorized: 401,
  invalid_token: 401,
  token_expired: 401,
  insufficient_scope: 403,
  tenant_not_supported: 403,
};

/** RFC 9457 `application/problem+json` 对象 */
export interface ProblemDetail {
  type: string;
  title: string;
  status: number;
  detail?: string;
  /** 与 wire 层 `errorCode` 同枚举，客户端可直接按它分支 */
  code: BridgeErrorCode;
}

export function toProblem(
  code: BridgeErrorCode,
  opts: { detail?: string; status?: number } = {},
): ProblemDetail {
  return {
    type: `https://agent-bridge.dev/errors/${code}`,
    title: code,
    status: opts.status ?? ERROR_HTTP_STATUS[code],
    ...(opts.detail ? { detail: opts.detail } : {}),
    code,
  };
}

/** 服务令牌校验结果 → 受控错误码（避免把四种失败混成一个 unauthorized） */
export function tokenDenyCode(reason: string | undefined): BridgeErrorCode {
  switch (reason) {
    case 'missing':
      return 'unauthorized';
    case 'expired':
    case 'revoked':
      return 'token_expired';
    case 'scope':
      return 'insufficient_scope';
    default:
      return 'invalid_token';
  }
}

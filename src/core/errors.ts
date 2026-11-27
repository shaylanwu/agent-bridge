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
  // —— 权限策略（1.0 Phase 2）——
  'permission_mode_unsupported', // 本机/该工具不满足 full 运行条件（无映射、缺 external_sandbox）
  'permission_policy_denied', // 本机策略不允许该权限组合（default 策略下请求 full、受管参数模式带自定义 args）
  // 已尝试向 adapter 写入交互响应，但结果无法确认；必须结束回合并禁止重试，避免重复授权/重复表单提交。
  'interaction_delivery_unknown',
  'interaction_invalid_response',
  'interaction_response_conflict',
  // 单次交互等待到期且当前 options 不提供 reject_once：以 cancelled outcome 完成请求并结束回合
  //（spec「等待状态、超时与取消」；有 reject_once 时按其原 optionId 拒绝、回合继续，不用此码）。
  'interaction_timeout',
  // full 模式的残余权限请求且 options 不提供 reject_once：fail closed 取消回合并结束
  //（spec「权限与问题的组合语义」：不转交人工、不伪造 reject 选项）。
  'interaction_denied',
  'agent_protocol_error',
  'idempotency_conflict',
  // —— 会话历史（1.0）——
  // 两者都是 410 Gone：任务曾经存在，但内容已不可完整取得，重试同一个 taskId 也不会变好。
  'session_deleted', // taskId 命中 tombstone（内容已随 retention 删除，且永不复用）
  'session_history_pruned', // 请求的游标落在已被 retention 裁剪的历史里，无法完整 replay
  // 这两个早就在 task_snapshot / artifact_content 上以字符串形式发出去了，
  // 进受控表只是把它们钉住：自由串会随文案漂，平台没法稳定分支。
  'task_not_found', // taskId 从未存在，或不属于该租户
  'artifact_not_found', // artifactId 未知或已淘汰
  // conversation 创建前就拒：该工具没有任何可续接回合的通道（continuation=single-turn）。
  // 在 message_ack 上早就用它了，这里钉住，让 run_task 的拒绝也能被程序化分支。
  'session_not_continuable',
  // —— 会话历史（replay 超上下文）——
  // 只由 CLI **自己报出的超限文本**触发（core/context-overflow.ts），不做预算预测：
  // 重试同一个 prompt 一定还是失败，正确处理是「开新会话 / 缩短历史」，不是原样重试。
  'context_exhausted',
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
  permission_mode_unsupported: 400,
  permission_policy_denied: 403,
  interaction_delivery_unknown: 500,
  interaction_invalid_response: 400,
  interaction_response_conflict: 409,
  interaction_timeout: 504,
  interaction_denied: 403,
  agent_protocol_error: 502,
  idempotency_conflict: 409,
  session_deleted: 410,
  session_history_pruned: 410,
  task_not_found: 404,
  artifact_not_found: 404,
  // 会话形态与请求不符（工具不支持多轮），换个参数就能成功 ⇒ 409 而不是 400
  session_not_continuable: 409,
  // 请求本身没写错，服务端也没坏，是「这段历史装不进模型的上下文窗口」⇒ 422（语义不可处理）。
  // 重试无效，客户端应改用新会话或缩短历史。
  context_exhausted: 422,
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

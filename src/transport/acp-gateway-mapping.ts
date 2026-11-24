/**
 * ACP（Agent Client Protocol，v1）server 侧映射层 —— 纯函数，无 IO（task 1.3）
 *
 * 职责：bridge 语义 ↔ ACP agent-server 语义的翻译表。
 * 方向说明：仓库里 `src/adapters/acp-*.ts` 是 **client** 侧（bridge 当 client 去接 CLI）；
 * 本文件是 **server** 侧（bridge 当 agent 被 editor / 外部编排调用）。两侧 wire 形状
 * 同源（都是 ACP v1 JSON-RPC），但类型独立定义：transport 不 import adapters（边缘不互相依赖）。
 *
 * 交互映射（proposal design）：
 *  - bridge `task_interaction_request(kind=permission)` ↔ ACP `session/request_permission`（agent→client 请求）
 *  - bridge `task_interaction_request(kind=form)` ↔ ACP `elicitation/create`（structured input）
 *  - bridge `task_interaction_request(kind=auth-url)` ↔ URL-mode elicitation（`elicitation/create` + `mode: "url"`）
 *  - bridge `task_interaction_response` ↔ ACP 请求的 result（`outcome` / `action`）
 *  - bridge `run_task` ↔ `session/prompt`；`cancel_task` ↔ `session/cancel`
 */

import type { TaskStatus } from '../protocol.js';
import type { InteractionRecord } from '../core/session-store.js';

/** ACP v1 的 PermissionOption（与 adapters 侧 wire 同形；server 侧独立定义） */
export interface AcpgwPermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

/** agent→client 的 `session/request_permission` 请求 params */
export interface AcpgwPermissionRequestParams {
  sessionId: string;
  options: AcpgwPermissionOption[];
  toolCall?: unknown;
}

/** client 对 permission 请求的 result（v1 outcome 包装） */
export interface AcpgwPermissionOutcome {
  outcome: 'selected' | 'cancelled';
  optionId?: string;
}

/** agent→client 的 `elicitation/create` 请求 params（v1 elicitation；form 与 URL 两种 mode） */
export interface AcpgwElicitationParams {
  sessionId: string;
  /** form 模式：请求填写的 JSON Schema */
  schema?: Record<string, unknown>;
  /** url 模式：要人工访问完成认证的地址 */
  url?: string;
  message?: string;
  mode?: 'form' | 'url';
}

/** client 对 elicitation 请求的 result */
export interface AcpgwElicitationResult {
  action: 'accept' | 'decline' | 'cancel';
  content?: Record<string, unknown>;
}

/** `session/prompt` 的 result（v1：stopReason + content） */
export interface AcpgwPromptResult {
  sessionId: string;
  stopReason: 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal';
  content?: string;
}

/**
 * bridge `TaskStatus` → ACP `stopReason`。
 *
 * | bridge | ACP |
 * | --- | --- |
 * | success | end_turn |
 * | cancelled | cancelled |
 * | timeout | （JSON-RPC error 表达，不产出 stopReason） |
 * | failed | （同上） |
 */
export function toAcpStopReason(status: TaskStatus): AcpgwPromptResult['stopReason'] | undefined {
  if (status === 'success') return 'end_turn';
  if (status === 'cancelled') return 'cancelled';
  return undefined;
}

/**
 * `session/prompt` params.prompt（ContentBlock 数组）→ bridge prompt 文本。
 * 只收 text block（bridge run_task 的 prompt 是纯文本）；出现非 text block 时
 * 返回 undefined，调用方回「输入不 supported」——不能静默丢掉图片/资源链接后假装收到完整请求。
 */
export function acpPromptToText(prompt: unknown): { text: string } | { unsupported: string } {
  if (typeof prompt === 'string') return { text: prompt };
  if (!Array.isArray(prompt) || prompt.length === 0) return { unsupported: 'prompt 必须是非空 text block 数组' };
  const parts: string[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== 'object' || (block as Record<string, unknown>)['type'] !== 'text') {
      return { unsupported: '只支持 type=text 的 prompt block（image/resource_link 暂不支持）' };
    }
    const text = (block as Record<string, unknown>)['text'];
    if (typeof text !== 'string') return { unsupported: 'text block 缺 text 字段' };
    parts.push(text);
  }
  return { text: parts.join('\n') };
}

/**
 * bridge permission 交互 → `session/request_permission` 请求 params。
 *
 * bridge 侧 payload 存的就是 ACP 形状（options + toolCall，由适配器原样落库），
 * 这里只做**结构校验与透传**，并对畸形 payload（非数组 options）给出可回错的形状，
 * 绝不把未知结构原样发给 client。
 */
export function toAcpPermissionRequestParams(
  interaction: Pick<InteractionRecord, 'sessionId' | 'payload'>,
): AcpgwPermissionRequestParams | { invalid: string } {
  const payload = interaction.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== 'object') return { invalid: 'permission payload 缺失' };
  const rawOptions = payload['options'];
  if (!Array.isArray(rawOptions) || rawOptions.length === 0) return { invalid: 'permission options 缺失或为空' };
  const options: AcpgwPermissionOption[] = [];
  for (const o of rawOptions) {
    if (!o || typeof o !== 'object') return { invalid: 'permission option 结构非法' };
    const rec = o as Record<string, unknown>;
    const optionId = rec['optionId'];
    if (typeof optionId !== 'string' || !optionId) return { invalid: 'permission option 缺 optionId' };
    options.push({
      optionId,
      ...(typeof rec['kind'] === 'string' ? { kind: rec['kind'] } : {}),
      ...(typeof rec['name'] === 'string' ? { name: rec['name'] } : {}),
    });
  }
  return {
    sessionId: interaction.sessionId,
    options,
    ...('toolCall' in payload && payload['toolCall'] !== undefined ? { toolCall: payload['toolCall'] } : {}),
  };
}

/**
 * client 的 permission result（`outcome` 包装）→ bridge 交互应答动作。
 * `selected` → accepted（带 optionId）；`cancelled` → cancelled。
 */
export function fromAcpPermissionOutcome(
  result: unknown,
): { state: 'accepted'; optionId: string } | { state: 'cancelled' } | { invalid: string } {
  const rec = result as Record<string, unknown> | null | undefined;
  const outcome = rec && typeof rec === 'object' ? (rec['outcome'] as Record<string, unknown> | undefined) : undefined;
  if (!outcome || typeof outcome !== 'object') return { invalid: 'permission result 缺 outcome' };
  const kind = outcome['outcome'];
  if (kind === 'selected') {
    const optionId = outcome['optionId'];
    if (typeof optionId !== 'string' || !optionId) return { invalid: 'selected 缺 optionId' };
    return { state: 'accepted', optionId };
  }
  if (kind === 'cancelled') return { state: 'cancelled' };
  return { invalid: `未知 permission outcome：${String(kind)}` };
}

/**
 * bridge form 交互 → `elicitation/create` 请求 params（form 模式）。
 * bridge payload 存 message + requestedSchema（MCP elicitation 原形）。
 */
export function toAcpElicitationParams(
  interaction: Pick<InteractionRecord, 'sessionId' | 'payload'>,
): AcpgwElicitationParams | { invalid: string } {
  const payload = interaction.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== 'object') return { invalid: 'form payload 缺失' };
  const schema = payload['requestedSchema'] ?? payload['schema'];
  if (!schema || typeof schema !== 'object') return { invalid: 'form payload 缺 schema' };
  return {
    sessionId: interaction.sessionId,
    schema: schema as Record<string, unknown>,
    mode: 'form',
    ...(typeof payload['message'] === 'string' ? { message: payload['message'] } : {}),
  };
}

/**
 * bridge auth-url 交互 → URL 模式 elicitation params。
 * payload 里必须有 url 字符串；无 url 的 payload 判非法（网关宁可报错也不猜地址）。
 */
export function toAcpUrlElicititationParams(
  interaction: Pick<InteractionRecord, 'sessionId' | 'payload'>,
): AcpgwElicitationParams | { invalid: string } {
  const payload = interaction.payload as Record<string, unknown> | null | undefined;
  if (!payload || typeof payload !== 'object') return { invalid: 'auth-url payload 缺失' };
  const url = payload['url'];
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return { invalid: 'auth-url payload 缺合法 url' };
  return {
    sessionId: interaction.sessionId,
    url,
    mode: 'url',
    ...(typeof payload['message'] === 'string' ? { message: payload['message'] } : {}),
  };
}

/**
 * client 的 elicitation result → bridge form 应答。
 * accept 带 content；decline/cancel 直接映射同名 state。
 */
export function fromAcpElicitationResult(
  result: unknown,
): { state: 'accepted'; content: Record<string, unknown> } | { state: 'declined' } | { state: 'cancelled' } | { invalid: string } {
  const rec = result as Record<string, unknown> | null | undefined;
  const action = rec && typeof rec === 'object' ? rec['action'] : undefined;
  if (action === 'accept') {
    const content = rec?.['content'];
    if (!content || typeof content !== 'object') return { invalid: 'accept 缺 content' };
    return { state: 'accepted', content: content as Record<string, unknown> };
  }
  if (action === 'decline') return { state: 'declined' };
  if (action === 'cancel') return { state: 'cancelled' };
  return { invalid: `未知 elicitation action：${String(action)}` };
}

/**
 * bridge 交互 kind → ACP agent→client 请求的方法名。
 * ACP v1 稳定表面只有 `session/request_permission` 与 `elicitation/create`；
 * auth-url 用 URL 模式 elicitation 表达（mode: "url"）。
 */
export function acpMethodForInteractionKind(kind: 'permission' | 'form' | 'auth-url'): string {
  if (kind === 'permission') return 'session/request_permission';
  return 'elicitation/create';
}

/** ACP JSON-RPC 错误码（协议 v1 用标准码域；扩展语义放 data） */
export const ACP_JSONRPC_ERRORS = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  /** 会话不存在 / 跨租户不可见（映射 bridge 404 语义） */
  sessionNotFound: -32001,
  /** 当前轮已在处理中（bridge 的任务并发语义） */
  promptBusy: -32002,
  /** 能力未接入/未实现（诚实拒绝，不降级） */
  unsupportedOperation: -32004,
} as const;

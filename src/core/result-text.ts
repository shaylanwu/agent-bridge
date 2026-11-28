/**
 * 终态最终回答的起草口径（`task_status.result`）。
 *
 * 协议字段表写明该字段是「终态最终回答文本（≤16KB）」，所以上行前必须按 16384 字符截断。
 * 单列一个模块的理由和 `form-schema.ts` / `context-overflow.ts` 一致：**两处以上会用同一口径**
 * （WS 上行 + 事件落库），各写一遍必然漂移。
 *
 * 注意不要顺手拿它去截 `task_message.text`：那条通道的契约里**没有**上限，
 * 截了等于偷偷丢内容；这里只服务 `result` 字段。
 */

export const RESULT_TEXT_LIMIT = 16_384;

export function capResultText(text: string | undefined | null): string | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  return text.length > RESULT_TEXT_LIMIT ? `${text.slice(0, RESULT_TEXT_LIMIT)}…` : text;
}

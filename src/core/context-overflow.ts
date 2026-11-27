/**
 * 上下文超限的**反应式**识别（`context_exhausted`）
 *
 * 为什么不做预算表：桥接拿不到「本次实际模型 → 上下文窗口」的稳定映射
 *（模型可被 `--model`／配置文件／服务端路由随时切换），token 计数也要与各家分词器一致，
 * 阈值附近必然误报；而误报的代价是把能成功的任务提前判死，比不报更坏。
 *
 * 所以判定只来自**失败输出里 CLI 自己给出的超限信号**：claude 的
 * `prompt is too long: 213456 tokens > 200000 maximum`、OpenAI 兼容端的
 * `context_length_exceeded`、Gemini 的 `The input token count exceeds the maximum …`。
 *
 * 规则刻意要求「上下文/token 量词」与「超限语义」**同一行内 80 字符内同现**，
 * 否则会把 gRPC 的 `context deadline exceeded`（超时）、`credit limit exceeded`（额度）
 * 这类完全无关的失败误判成超限 —— 宁可不报，不得虚报。
 */

/** 显式错误码风格（出现即命中，不需要量词判断） */
export const CONTEXT_OVERFLOW_CODES: readonly string[] = [
  'context_length_exceeded',
  'context_window_exceeded',
  'context_overflow',
  'prompt_too_long',
  'too_many_tokens',
  'max_tokens_exceeded',
  'token_limit_exceeded',
  'input_too_long',
];

/**
 * 「什么被撑爆了」——注意 `context` 必须与窗口类词组合，
 * 单写 `context` 会命中 gRPC 的 `context deadline exceeded`（那是超时，不是超限）。
 */
const SUBJECT = String.raw`(?:prompt|input|conversation|messages?|token count|tokens?|context[ _-]?(?:window|length|size|limit|budget))`;

/** 「撑爆了」的语义 */
const OVERFLOW = String.raw`(?:exceed(?:s|ed|ing)?|too\s+(?:long|large|many|big)|overflow(?:ed|s)?|over\s+the\s+limit|(?:maximum|max)\s*(?:allowed|limit)?\s*(?:is|of)?\s*[\d,]+|out\s+of\s+(?:context|space))`;

/**
 * 英文：量词与超限语义同现，允许 80 字符间隔（同一行内）。
 *
 * `prompt is too long: 213456 tokens > 200000 maximum` 这类文案里量词在前、语义在后，
 * 也有 `maximum context length is 200000 tokens, however you requested …` 这种反序的，
 * 所以两个方向都要匹配。
 */
const EN_PATTERN = new RegExp(
  `${SUBJECT}[^\\n]{0,80}${OVERFLOW}|${OVERFLOW}[^\\n]{0,80}${SUBJECT}`,
  'i',
);

/** 中文文案（部分国内 CLI 用中文报错） */
const ZH_PATTERNS: readonly RegExp[] = [
  /上下文(?:窗口|长度|容量)?[^\n。]{0,20}(?:超出|超过|超限|过大|溢出|不够)/,
  /(?:提示词|对话|会话|历史|输入)[^\n。]{0,12}(?:过长|太长|超出|超过)[^\n。]{0,12}(?:上限|限制|窗口|长度)/,
  /token[^\n。]{0,12}(?:超出|超过|超限)[^\n。]{0,8}(?:上限|限制)/i,
];

/**
 * 反序句式：`maximum context length is 128000 tokens` —— 量词跟在 `maximum` 后面，
 * 数字隔得更远，上面对称规则覆盖不到。
 *
 * 这里刻意要求「max + 窗口类量词 + 至少 4 位数字」，避免把 `--max-tokens 4096`
 * 这类**配置值**（不是错误）当成超限：那个句式里 max 后面直接是 tokens，没有窗口类词。
 */
const MAX_CONTEXT_PATTERN =
  /(?:maximum|max)[ _-]?(?:context[ _-]?(?:window|length|size)|prompt|input|conversation)[^\n]{0,40}?[\d,]{4,}/i;

/**
 * 判断给定文本是否表达了「上下文超限」。
 *
 * 传入多段（如 `info.error` 与输出尾部）时，**任意一段**命中即算命中。
 * 未命中一律返回 `false`：调用方据此维持 `agent_error`，不得猜测。
 */
export function looksLikeContextOverflow(...texts: Array<string | undefined | null>): boolean {
  for (const raw of texts) {
    if (!raw) continue;
    const text = String(raw);
    const lower = text.toLowerCase();
    if (CONTEXT_OVERFLOW_CODES.some((code) => lower.includes(code))) return true;
    if (MAX_CONTEXT_PATTERN.test(text)) return true;
    if (EN_PATTERN.test(text)) return true;
    if (ZH_PATTERNS.some((re) => re.test(text))) return true;
  }
  return false;
}

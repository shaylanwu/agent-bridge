/**
 * 宿主注入环境变量的清理。
 *
 * 为什么需要：bridge 经常跑在 WorkBuddy / CodeBuddy 宿主进程里，宿主会把自己的会话上下文
 * 塞进环境变量（`CODEBUDDY_SESSION_ID`、`CODEBUDDY_MCP_CONFIG`、`SERVER__PORT` …）。
 * 子 CLI 继承它们会**冒充宿主会话**，最典型的症状是抢宿主的端口：
 *
 *   实测 codebuddy `-p --output-format stream-json --verbose`
 *   → `Error: listen EADDRINUSE: address already in use 127.0.0.1:57193`（exit 1）
 *   清掉 `CODEBUDDY_*` 后立刻正常（exit 0，正常输出 stream-json）。
 *
 * 这类变量只对宿主自己有意义，平台任务不该继承 —— 继承了还会把宿主的 MCP 配置、
 * 会话 id 一起带进去，任务行为跟着宿主漂。
 */

/** 精确匹配（别的产品也可能注入同名变量，不做前缀匹配） */
const HOST_ENV_KEYS = [
  'SERVER__PORT',
  'CLAUDE_SESSION_ID',
  // ACP 侧的原始清单（sanitizeHostEnv 一直依赖它，迁移到这里保持单一真源）
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CODEBUDDY_SESSION_ID',
  'CODEBUDDY_TOOL_CALL_ID',
  'CODEBUDDY_ARTIFACTS',
  'CODEBUDDY_ROOT_REQUEST_ID',
  'CODEBUDDY_CONVERSATION_REQUEST_ID',
  'CODEBUDDY_CONVERSATION_MESSAGE_ID',
  'CODEBUDDY_MCP_CONFIG',
] as const;

/** 前缀匹配：宿主版本升级常新增同族变量，逐条维护必然漏 */
const HOST_ENV_PREFIXES = ['CODEBUDDY_'] as const;

/** 例外：子进程**认证**要用，必须保留 */
const HOST_ENV_KEEP = new Set(['CODEBUDDY_AUTH_TOKEN']);

export function isHostInjectedEnv(key: string): boolean {
  if (HOST_ENV_KEEP.has(key)) return false;
  if ((HOST_ENV_KEYS as readonly string[]).includes(key)) return true;
  return HOST_ENV_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** 返回去掉宿主注入变量的**副本**（不改入参） */
export function withoutHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!isHostInjectedEnv(key)) out[key] = value;
  }
  return out;
}

/**
 * 步骤流解析器（B 批次：L1/L2 结构化事件 → task_step）
 *
 * 数据源格式（2026-10-24 本机实测，样例落档 openspec/changes/add-multi-task-visibility/research/）：
 *  - `claude-json`：claude / codebuddy 的 `-p --output-format stream-json --verbose`
 *      assistant.message.content[].tool_use → started（action=name，label 取 input 摘要）
 *      user.message.content[].tool_result   → finished（ref=tool_use_id，ok=!is_error）
 *  - `codex-json`：`codex exec --json`
 *      item.started / item.completed 成对（item.id 配对）；只收动作类 item
 *      （command_execution / file_change / mcp_tool_call / web_search），reasoning / agent_message 跳过
 *  - `opencode-json`：`opencode run --format json`（⛔ 不是 `--json`，那是无效参数）
 *      tool_use 事件一次带齐 part.state.status → 直接发 finished
 *
 * 解析器是纯函数状态机：feed() 内部维持行缓冲，只处理完整行；非 JSON 行快速跳过。
 */

/**
 * 富 toolCall（4.8）：工具调用的规范化子集 —— kind 用 ACP 的
 * read/edit/delete/move/search/execute/think/fetch/switch_mode/other；
 * content 是有界 text/diff/terminal 块（单块 16KB，由生成处截断、上行出口脱敏）；
 * rawInput/rawOutput 默认不上行 —— 只有 locations 的路径与 content 的输出摘要。
 */
export interface ParsedToolCall {
  toolCallId?: string;
  name: string;
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  title?: string;
  status?: string;
  locations?: Array<{ path?: string; line?: number }>;
  content?: Array<{ kind: 'text' | 'diff' | 'terminal'; text: string }>;
}

export interface ParsedStep {
  /** 动作名：Bash / Edit / Read / command_execution / file_change…（依工具而定） */
  action: string;
  /** 目标摘要（命令行 / 文件路径等；调用方负责截断与脱敏） */
  label?: string;
  state: 'started' | 'finished';
  /** state=finished 时给出成败 */
  ok?: boolean;
  /** 源事件关联 id（started/finished 配对） */
  ref?: string;
  /** 富 toolCall（4.8）：无法可靠提取的适配器省略，只保留 legacy 字段 */
  toolCall?: ParsedToolCall;
}

/** 中间 agent 消息（4.7）：messageId 优先用 CLI 原生 ID，缺省由调用方生成稳定 ID */
export interface ParsedAgentMessage {
  messageId?: string;
  text: string;
}

/** 单个 content 块的字符上限（design「有界 text/diff/terminal」；超限截断，不扫描全文） */
const TOOL_CONTENT_MAX = 16_384;

export type StepFormat =
  | 'claude-json'
  | 'codex-json'
  | 'opencode-json'
  | 'agy-json'
  | 'kimi-json'
  | 'dsh-json'
  | 'mcode-json';

/** 待办计划项（TodoWrite 类工具的快照；平台/面板共用） */
export interface PlanItem {
  text: string;
  state: 'pending' | 'in_progress' | 'completed';
}

/** 从 TodoWrite 类工具的 input 提取计划（存在才返回；工具名含 todo 且带 todos 数组才认） */
function planOfInput(toolName: string, input: unknown): PlanItem[] | undefined {
  if (!/todo/i.test(toolName)) return undefined;
  if (typeof input !== 'object' || input === null) return undefined;
  const todos = (input as Record<string, unknown>)['todos'];
  if (!Array.isArray(todos)) return undefined;
  const items: PlanItem[] = [];
  for (const t of todos) {
    if (typeof t !== 'object' || t === null) continue;
    const text = String((t as Record<string, unknown>)['content'] ?? (t as Record<string, unknown>)['text'] ?? '');
    if (!text) continue;
    const raw = String((t as Record<string, unknown>)['status'] ?? 'pending');
    const state: PlanItem['state'] = raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'in_progress' : 'pending';
    items.push({ text, state });
  }
  return items.length > 0 ? items : undefined;
}

export interface StepParser {
  feed(chunk: string): ParsedStep[];
  /** 终态时的最终回答文本（从各自 result/final 事件提取；没有则 undefined） */
  finalText?(): string | undefined;
  /**
   * 中间 agent 消息（4.7）：headless 结构化输出里已定稿的 assistant 文本
   *（此前只埋在 task_log）。drain 语义 —— 取走即清空，重复调用不重复给。
   * 只有能可靠区分 assistant 文本的格式实现（claude-json 已实测）；未实测格式不猜。
   */
  drainMessages?(): ParsedAgentMessage[];
  /**
   * 终态语义裁决（可选；agy 引入）：有些 CLI 退出码 0 也可能是「优雅的部分完成」
   * （agy 官方文档：--print-timeout 到期以 0 结束），只有流内 status 才是真相。
   * ok:false 时 supervisor 推翻「退出码 0 = 成功」按失败结算。
   */
  finalOutcome?(): { ok: boolean; error?: string; result?: string } | undefined;
  /** 最近一次 TodoWrite 类工具调用给出的待办计划快照（无计划能力/未调用则 undefined） */
  plan?(): PlanItem[] | undefined;
}

/** 从 tool_use.input 里挑一个最有信息量的摘要字段 */
function labelOfInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const o = input as Record<string, unknown>;
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description'] as const) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

function forEachJsonLine(buffer: { rest: string }, chunk: string, onLine: (obj: Record<string, unknown>) => void): void {
  const text = buffer.rest + chunk;
  const lines = text.split('\n');
  buffer.rest = lines.pop() ?? '';
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      onLine(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* 半行/非 JSON：跳过 */
    }
  }
}

// ---------- claude / codebuddy：stream-json ----------

/** claude 工具名 → ACP kind（4.8 富 toolCall；未列出的工具归 other，不猜） */
const CLAUDE_TOOL_KINDS: Record<string, NonNullable<ParsedToolCall['kind']>> = {
  Read: 'read',
  Edit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  MultiEdit: 'edit',
  Delete: 'delete',
  Move: 'move',
  Glob: 'search',
  Grep: 'search',
  Bash: 'execute',
  Think: 'think',
  WebFetch: 'fetch',
  WebSearch: 'fetch',
};

/** tool_use.input 里的路径字段 → locations 包装（file_path 优先，与 labelOfInput 同源字段；无命中给空对象） */
function locationsOfInput(input: unknown): { locations?: Array<{ path?: string }> } {
  if (!input || typeof input !== 'object') return {};
  const o = input as Record<string, unknown>;
  for (const k of ['file_path', 'path', 'notebook_path'] as const) {
    const v = o[k];
    if (typeof v === 'string' && v) return { locations: [{ path: v }] };
  }
  return {};
}

/**
 * claude 系 tool_use → 富 toolCall（supervisor 的常驻 stream 通道复用同一映射；
 * headless 解析器内部直接内联同款构造）。
 */
export function claudeToolCallOf(
  name: string,
  id: unknown,
  input: unknown,
): { toolCallId?: string; name: string; kind: NonNullable<ParsedToolCall['kind']>; status: string } & {
  locations?: Array<{ path?: string }>;
} {
  return {
    ...(typeof id === 'string' && id ? { toolCallId: id } : {}),
    name,
    kind: CLAUDE_TOOL_KINDS[name] ?? 'other',
    status: 'pending',
    ...locationsOfInput(input),
  };
}

/** tool_result.content → 有界块（Bash 类输出映射 terminal；其余 text）。字符串/块数组都收。 */
function toolResultContent(raw: unknown): Array<{ kind: 'text' | 'terminal'; text: string }> | undefined {
  const pieces: string[] = [];
  if (typeof raw === 'string') pieces.push(raw);
  else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') pieces.push(item);
      else if (item && typeof item === 'object' && typeof (item as Record<string, unknown>)['text'] === 'string') {
        pieces.push((item as Record<string, unknown>)['text'] as string);
      }
    }
  }
  const text = pieces.join('\n');
  if (!text) return undefined;
  return [{ kind: 'terminal', text: text.length > TOOL_CONTENT_MAX ? `${text.slice(0, TOOL_CONTENT_MAX - 1)}…` : text }];
}

function createClaudeParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：result 事件的 result 字段优先；兜底最后一条 assistant text 块
  let lastText: string | undefined;
  // 待办计划：TodoWrite 的 input.todos 快照（每次调用覆盖）
  let plan: PlanItem[] | undefined;
  let outcome: { ok: boolean; error?: string; result?: string } | undefined;
  // 中间 agent 消息（4.7）：按 assistant 消息聚合 text 块，drain 即清空
  const pendingMessages: ParsedAgentMessage[] = [];
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const message = o['message'] as Record<string, unknown> | undefined;
        const content = message?.['content'];
        if (o['type'] === 'result') {
          const resultText = typeof o['result'] === 'string' ? (o['result'] as string) : undefined;
          if (resultText !== undefined) lastText = resultText;
          const subtype = typeof o['subtype'] === 'string' ? (o['subtype'] as string) : undefined;
          const failed = o['is_error'] === true || (subtype !== undefined && subtype !== 'success');
          const detail =
            (typeof o['error'] === 'string' && (o['error'] as string)) || resultText || subtype || '未知终态错误';
          outcome = {
            ok: !failed,
            ...(failed ? { error: `CLI result${subtype ? ` ${subtype}` : ''}：${detail}` } : {}),
            ...(resultText ? { result: resultText } : {}),
          };
        }
        if (!Array.isArray(content)) return;
        if (o['type'] === 'assistant') {
          const nativeId = typeof message?.['id'] === 'string' ? (message?.['id'] as string) : undefined;
          let textParts: string[] = [];
          for (const b of content) {
            if (b?.type === 'tool_use' && typeof b.name === 'string') {
              plan = planOfInput(b.name, b.input) ?? plan;
              out.push({
                action: b.name,
                label: labelOfInput(b.input),
                state: 'started',
                ref: typeof b.id === 'string' ? b.id : undefined,
                toolCall: {
                  ...(typeof b.id === 'string' ? { toolCallId: b.id } : {}),
                  name: b.name,
                  kind: CLAUDE_TOOL_KINDS[b.name] ?? 'other',
                  ...(typeof b.title === 'string' ? { title: b.title } : {}),
                  status: 'pending',
                  ...locationsOfInput(b.input),
                  // rawInput 不上行：只有上面的 locations 路径与 label 摘要
                },
              });
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              lastText = b.text;
              textParts.push(b.text as string);
            }
          }
          // 同一条 assistant 消息的多个 text 块聚合为一条中间消息（CLI 原生 id 作幂等键）
          if (textParts.length > 0) {
            pendingMessages.push({
              ...(nativeId ? { messageId: nativeId } : {}),
              text: textParts.join('\n\n'),
            });
          }
        } else if (o['type'] === 'user') {
          for (const b of content) {
            if (b?.type === 'tool_result') {
              const ref = typeof b['tool_use_id'] === 'string' ? (b['tool_use_id'] as string) : undefined;
              const resultContent = toolResultContent(b['content']);
              out.push({
                action: 'tool_result',
                state: 'finished',
                ok: b['is_error'] !== true,
                ref,
                toolCall: {
                  ...(ref ? { toolCallId: ref } : {}),
                  name: 'tool_result',
                  status: b['is_error'] === true ? 'failed' : 'completed',
                  ...(resultContent ? { content: resultContent } : {}),
                },
              });
            }
          }
        }
      });
      return out;
    },
    finalText: () => lastText,
    drainMessages: () => pendingMessages.splice(0),
    finalOutcome: () => outcome,
    plan: () => plan,
  };
}

// ---------- codex：exec --json ----------

/** 动作类 item：只有它们值得成为步骤（reasoning / agent_message 是思考与回复，不算） */
const CODEX_ACTION_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

function codexLabel(item: Record<string, unknown>): string | undefined {
  if (typeof item['command'] === 'string') return item['command'];
  const changes = item['changes'];
  if (Array.isArray(changes) && changes.length > 0) {
    const p = (changes[0] as Record<string, unknown> | undefined)?.['path'];
    if (typeof p === 'string') return p;
  }
  return typeof item['path'] === 'string' ? item['path'] : undefined;
}

function createCodexParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：最后一条 agent_message 的 text
  let lastText: string | undefined;
  // 计划：codex 的 plan/update_plan item（item.plan = [{step,status}]）
  let plan: PlanItem[] | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const type = o['type'];
        if (type !== 'item.started' && type !== 'item.completed' && type !== 'item.updated') return;
        const item = o['item'] as Record<string, unknown> | undefined;
        if (!item || typeof item['type'] !== 'string') return;
        if ((item['type'] === 'plan' || item['type'] === 'update_plan') && Array.isArray(item['plan'])) {
          const items: PlanItem[] = [];
          for (const p of item['plan'] as Record<string, unknown>[]) {
            const text = String(p?.['step'] ?? p?.['text'] ?? '');
            if (!text) continue;
            const raw = String(p?.['status'] ?? 'pending');
            items.push({
              text,
              state: raw === 'completed' ? 'completed' : raw === 'in_progress' ? 'in_progress' : 'pending',
            });
          }
          if (items.length > 0) plan = items;
        }
        if (type === 'item.completed' && item['type'] === 'agent_message' && typeof item['text'] === 'string') {
          lastText = item['text'] as string;
        }
        if (type === 'item.updated') return;
        if (!CODEX_ACTION_ITEMS.has(item['type'])) return;
        const started = type === 'item.started';
        out.push({
          action: item['type'],
          label: codexLabel(item),
          state: started ? 'started' : 'finished',
          ok: started ? undefined : item['type'] !== 'error' && (item['exit_code'] === undefined || item['exit_code'] === 0),
          ref: typeof item['id'] === 'string' ? item['id'] : undefined,
        });
      });
      return out;
    },
    finalText: () => lastText,
    plan: () => plan,
  };
}

// ---------- opencode：run --format json ----------

function createOpencodeParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：最后一条 text 事件的 part.text
  let lastText: string | undefined;
  let plan: PlanItem[] | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        if (o['type'] === 'text') {
          const part = o['part'] as Record<string, unknown> | undefined;
          if (typeof part?.['text'] === 'string' && (part['text'] as string).trim()) lastText = part['text'] as string;
          return;
        }
        if (o['type'] !== 'tool_use') return;
        const part = o['part'] as Record<string, unknown> | undefined;
        if (!part || part['type'] !== 'tool' || typeof part['tool'] !== 'string') return;
        const state = part['state'] as Record<string, unknown> | undefined;
        plan = planOfInput(part['tool'], state?.['input']) ?? plan;
        out.push({
          action: part['tool'],
          label: labelOfInput(state?.['input']),
          state: 'finished',
          ok: state?.['status'] === 'completed',
          ref: typeof part['callID'] === 'string' ? part['callID'] : undefined,
        });
      });
      return out;
    },
    finalText: () => lastText,
    plan: () => plan,
  };
}

// ---------- agy（Antigravity CLI）：-p --output-format stream-json ----------
// 官方 headless 文档 + 1.4.10 本机实测信封一致：{"event":"init"|"step_update"|"result",…同名负载}。
// tool 步骤两态（ACTIVE/DONE）按 step_index 配对；result.status 枚举里只有 SUCCESS 算完成 ——
// 退出码 0 也可能是 --print-timeout 的优雅部分完成，finalOutcome 负责推翻假成功。
// init 的 conversation_id 在信封顶层，supervisor 既有 onSession 正则直接命中，无需新机制。

/** agy 参数对象的摘要键（`CommandLine` 是 agy 特有大小写，通用 labelOfInput 不含） */
function agyLabelOfParameters(parameters: unknown): string | undefined {
  if (!parameters || typeof parameters !== 'object') return labelOfInput(parameters);
  const o = parameters as Record<string, unknown>;
  const cl = o['CommandLine'];
  if (typeof cl === 'string' && cl.trim()) return cl;
  return labelOfInput(parameters);
}

function createAgyParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：result.response 优先；agent_response 的 text_delta 增量拼接兜底
  let deltaText: string | undefined;
  let finalResponse: string | undefined;
  // 终态裁决：见过 result 事件才有发言权（没见过 = 该流没有 status 语义，不推翻退出码）
  let outcome: { ok: boolean; error?: string; result?: string } | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const event = o['event'];
        if (event === 'step_update') {
          const p = o['step_update'] as Record<string, unknown> | undefined;
          if (!p || p['step_type'] !== 'tool') {
            if (p?.['step_type'] === 'agent_response' && typeof p['text_delta'] === 'string') {
              deltaText = (deltaText ?? '') + (p['text_delta'] as string);
            }
            return;
          }
          const state = p['state'];
          if (state !== 'ACTIVE' && state !== 'DONE') return;
          const done = state === 'DONE';
          // ACTIVE 就带 parameters（官方实样）：started 步骤立即显示命令行，不必等 DONE
          const toolInfo = p['tool_info'] as Record<string, unknown> | undefined;
          out.push({
            action: typeof p['tool_name'] === 'string' ? (p['tool_name'] as string) : 'tool',
            label: agyLabelOfParameters(toolInfo?.['parameters']),
            state: done ? 'finished' : 'started',
            ...(done ? { ok: toolInfo?.['error'] == null } : {}),
            ref: p['step_index'] === undefined ? undefined : String(p['step_index']),
          });
        } else if (event === 'result') {
          const r = o['result'] as Record<string, unknown> | undefined;
          if (!r) return;
          const response = typeof r['response'] === 'string' ? (r['response'] as string) : undefined;
          if (response && response.trim()) finalResponse = response;
          const status = String(r['status'] ?? '');
          const errMsg = typeof r['error'] === 'string' && r['error'] ? (r['error'] as string) : undefined;
          outcome = {
            ok: status === 'SUCCESS',
            ...(status !== 'SUCCESS'
              ? { error: `Antigravity CLI status=${status || 'unknown'}${errMsg ? `：${errMsg}` : ''}` }
              : {}),
            ...(finalResponse ? { result: finalResponse } : {}),
          };
        }
      });
      return out;
    },
    finalText: () => finalResponse ?? deltaText,
    finalOutcome: () => outcome,
  };
}

// ---------- kimi：OpenAI 风格 tool_calls ----------
// 实测（kimi -p … --output-format stream-json）：assistant.tool_calls[] → role:tool。
// function.arguments 是 JSON 字符串（OpenAI 惯例），抠出内部摘要字段做 label。

function createKimiParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：最后一条 role:assistant 的 content 字符串
  let lastText: string | undefined;
  let plan: PlanItem[] | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        if (o['role'] === 'assistant' && Array.isArray(o['tool_calls'])) {
          if (typeof o['content'] === 'string' && (o['content'] as string).trim()) lastText = o['content'] as string;
          for (const call of o['tool_calls'] as Record<string, unknown>[]) {
            const fn = call?.['function'] as Record<string, unknown> | undefined;
            if (typeof fn?.['name'] !== 'string') continue;
            let label: string | undefined;
            let input: unknown;
            if (typeof fn['arguments'] === 'string') {
              try {
                input = JSON.parse(fn['arguments']);
                label = labelOfInput(input);
              } catch {
                label = fn['arguments'];
              }
            } else {
              input = fn['arguments'];
              label = labelOfInput(input);
            }
            plan = planOfInput(fn['name'], input) ?? plan;
            out.push({
              action: fn['name'],
              label,
              state: 'started',
              ref: typeof call['id'] === 'string' ? call['id'] : undefined,
            });
          }
        } else if (o['role'] === 'assistant' && typeof o['content'] === 'string' && (o['content'] as string).trim()) {
          lastText = o['content'] as string;
        } else if (o['role'] === 'tool') {
          out.push({
            action: 'tool_result',
            state: 'finished',
            ok: true,
            ref: typeof o['tool_call_id'] === 'string' ? (o['tool_call_id'] as string) : undefined,
          });
        }
      });
      return out;
    },
    finalText: () => lastText,
    plan: () => plan,
  };
}

// ---------- dsh（DeepSeek Harness）：--profile headless --json ----------
// 官方文档口径（本机缺 key 未取得 tool_call 实测）：session / status / text / thinking /
// tool_call / tool_result / final / error；tool_result.callId 与 tool_call.callId 配对。

function createDshParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：final 事件的 text
  let lastText: string | undefined;
  let plan: PlanItem[] | undefined;
  let outcome: { ok: boolean; error?: string; result?: string } | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const type = o['type'];
        if (type === 'status' && o['phase'] === 'turn_end') {
          const reason = o['reason'] as Record<string, unknown> | undefined;
          if (reason?.['kind'] === 'error') {
            const error = reason['error'] as Record<string, unknown> | undefined;
            const code = typeof error?.['code'] === 'string' ? `${error['code']}: ` : '';
            const message = typeof error?.['message'] === 'string' ? error['message'] : 'DSH 回合失败';
            outcome = { ok: false, error: `DSH ${code}${message}` };
          }
        }
        if (type === 'final' && typeof o['text'] === 'string') lastText = o['text'] as string;
        if (type === 'tool_call') {
          const action = (o['name'] ?? o['tool']) as string | undefined;
          if (typeof action !== 'string') return;
          plan = planOfInput(action, o['arguments'] ?? o['input'] ?? o['args']) ?? plan;
          out.push({
            action,
            label: labelOfInput(o['arguments'] ?? o['input'] ?? o['args']),
            state: 'started',
            ref: typeof o['callId'] === 'string' ? o['callId'] : undefined,
          });
        } else if (type === 'tool_result') {
          out.push({
            action: 'tool_result',
            state: 'finished',
            ok: o['isError'] !== true && o['is_error'] !== true,
            ref: typeof o['callId'] === 'string' ? o['callId'] : undefined,
          });
        }
      });
      return out;
    },
    finalText: () => lastText,
    finalOutcome: () => outcome,
    plan: () => plan,
  };
}

// ---------- minimax-code（mcode）：exec --output-format stream-json ----------
// 实测（0.6.13）：exec/session/turn 生命周期 + item.started|updated|completed。
// 动作在 item.type === 'tool_call'（toolCall{id,name,input,status}）；reasoning / agent_message 跳过；
// item.updated 是增量噪音，同样跳过。status 是数字枚举（成功观测值为 2），不猜语义：
// ok 仅在显式 error 字段存在时判 false。

function createMcodeParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：exec.completed 的 result.output/answer；兜底最后一条 agent_message content
  let lastText: string | undefined;
  let plan: PlanItem[] | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const type = o['type'];
        if (type === 'exec.completed') {
          const result = o['result'] as Record<string, unknown> | undefined;
          const text = (result?.['output'] ?? result?.['answer']) as string | undefined;
          if (typeof text === 'string' && text.trim()) lastText = text;
          return;
        }
        if (type !== 'item.started' && type !== 'item.completed') return;
        const item = o['item'] as Record<string, unknown> | undefined;
        if (!item) return;
        if (
          type === 'item.completed' &&
          item['type'] === 'agent_message' &&
          typeof item['content'] === 'string' &&
          (item['content'] as string).trim()
        ) {
          lastText = item['content'] as string;
        }
        if (item['type'] !== 'tool_call') return;
        const call = item['toolCall'] as Record<string, unknown> | undefined;
        if (!call || typeof call['name'] !== 'string') return;
        plan = planOfInput(call['name'], call['input']) ?? plan;
        const started = type === 'item.started';
        out.push({
          action: call['name'],
          label: labelOfInput(call['input']),
          state: started ? 'started' : 'finished',
          ok: started ? undefined : call['error'] == null,
          ref: typeof call['id'] === 'string' ? call['id'] : undefined,
        });
      });
      return out;
    },
    finalText: () => lastText,
    plan: () => plan,
  };
}

/** 按格式名造解析器（格式由适配器声明，解析器与 CLI 输出一一对应） */
export function createStepParser(format: StepFormat): StepParser {
  if (format === 'claude-json') return createClaudeParser();
  if (format === 'codex-json') return createCodexParser();
  if (format === 'agy-json') return createAgyParser();
  if (format === 'kimi-json') return createKimiParser();
  if (format === 'dsh-json') return createDshParser();
  if (format === 'mcode-json') return createMcodeParser();
  return createOpencodeParser();
}

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
}

export type StepFormat =
  | 'claude-json'
  | 'codex-json'
  | 'opencode-json'
  | 'gemini-json'
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

function createClaudeParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：result 事件的 result 字段优先；兜底最后一条 assistant text 块
  let lastText: string | undefined;
  // 待办计划：TodoWrite 的 input.todos 快照（每次调用覆盖）
  let plan: PlanItem[] | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const content = (o['message'] as Record<string, unknown> | undefined)?.['content'];
        if (o['type'] === 'result' && typeof o['result'] === 'string') lastText = o['result'] as string;
        if (!Array.isArray(content)) return;
        if (o['type'] === 'assistant') {
          for (const b of content) {
            if (b?.type === 'tool_use' && typeof b.name === 'string') {
              plan = planOfInput(b.name, b.input) ?? plan;
              out.push({
                action: b.name,
                label: labelOfInput(b.input),
                state: 'started',
                ref: typeof b.id === 'string' ? b.id : undefined,
              });
            } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
              lastText = b.text;
            }
          }
        } else if (o['type'] === 'user') {
          for (const b of content) {
            if (b?.type === 'tool_result') {
              out.push({
                action: 'tool_result',
                state: 'finished',
                ok: b['is_error'] !== true,
                ref: typeof b['tool_use_id'] === 'string' ? (b['tool_use_id'] as string) : undefined,
              });
            }
          }
        }
      });
      return out;
    },
    finalText: () => lastText,
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

// ---------- gemini：stream-json ----------
// 官方文档口径（本机缺凭据未实测事件流）：init / message / tool_use / tool_result / result。
// 字段名两种写法并存（name+args 与 tool_name+parameters），解析器兼容两者。

function createGeminiParser(): StepParser {
  const buffer = { rest: '' };
  // 最终回答：最后一条 assistant message 的 content
  let lastText: string | undefined;
  let plan: PlanItem[] | undefined;
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const type = o['type'];
        if (type === 'tool_use') {
          const action = (o['tool_name'] ?? o['name']) as string | undefined;
          if (typeof action !== 'string') return;
          plan = planOfInput(action, o['parameters'] ?? o['args'] ?? o['input']) ?? plan;
          out.push({
            action,
            label: labelOfInput(o['parameters'] ?? o['args'] ?? o['input']),
            state: 'started',
            ref: (o['tool_id'] ?? o['id']) as string | undefined,
          });
        } else if (type === 'tool_result') {
          out.push({
            action: 'tool_result',
            state: 'finished',
            ok: o['status'] !== 'error',
            ref: (o['tool_id'] ?? o['id']) as string | undefined,
          });
        } else if (type === 'message' && o['role'] === 'assistant' && typeof o['content'] === 'string') {
          lastText = o['content'] as string;
        }
      });
      return out;
    },
    finalText: () => lastText,
    plan: () => plan,
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
  return {
    feed(chunk) {
      const out: ParsedStep[] = [];
      forEachJsonLine(buffer, chunk, (o) => {
        const type = o['type'];
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
        if (type === 'item.completed' && item['type'] === 'agent_message' && typeof item['content'] === 'string') {
          lastText ??= item['content'] as string;
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
  if (format === 'gemini-json') return createGeminiParser();
  if (format === 'kimi-json') return createKimiParser();
  if (format === 'dsh-json') return createDshParser();
  if (format === 'mcode-json') return createMcodeParser();
  return createOpencodeParser();
}

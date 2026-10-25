/**
 * 步骤流解析器单测（B 批次）
 *
 * fixture 是 2026-10-24 本机真跑三个 CLI 的实测输出
 * （原件落档在 openspec/changes/add-multi-task-visibility/research/）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createStepParser, type ParsedStep } from '../src/adapters/step-parsers';
import { Emitter } from '../src/core/emitter';
import type { ClientMessage } from '../src/protocol';

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');
}

function parseAll(
  format:
    | 'claude-json'
    | 'codex-json'
    | 'opencode-json'
    | 'gemini-json'
    | 'kimi-json'
    | 'dsh-json'
    | 'mcode-json',
  text: string,
): ParsedStep[] {
  const p = createStepParser(format);
  // 一次喂入
  return p.feed(text);
}

describe('步骤流解析器', () => {
  it('claude stream-json：tool_use → started，tool_result → finished 且按 ref 配对', () => {
    const steps = parseAll('claude-json', fixture('claude-stream.jsonl'));
    const started = steps.find((s) => s.state === 'started');
    const finished = steps.find((s) => s.state === 'finished');
    expect(started).toMatchObject({ action: 'Bash', label: 'ls -la' });
    expect(started?.ref).toMatch(/^tool_/);
    expect(finished).toMatchObject({ action: 'tool_result', ok: true });
    expect(finished?.ref).toBe(started?.ref);
  });

  it('claude：碎片喂入（7 字节一片）结果不变——行缓冲跨分片正确', () => {
    const text = fixture('claude-stream.jsonl');
    const p = createStepParser('claude-json');
    const steps: ParsedStep[] = [];
    for (let i = 0; i < text.length; i += 7) steps.push(...p.feed(text.slice(i, i + 7)));
    expect(steps.filter((s) => s.state === 'started')).toHaveLength(1);
    expect(steps.filter((s) => s.state === 'finished')).toHaveLength(1);
  });

  it('codex --json：只收动作类 item，started/completed 按 item.id 配对', () => {
    const steps = parseAll('codex-json', fixture('codex-events.jsonl'));
    const started = steps.filter((s) => s.state === 'started');
    const finished = steps.filter((s) => s.state === 'finished');
    // 样例里有两个 error 类 item（配置警告）——必须被跳过
    expect(started).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(started[0]).toMatchObject({ action: 'command_execution', state: 'started' });
    expect(started[0]?.label).toContain('powershell');
    expect(finished[0]?.ref).toBe(started[0]?.ref);
    expect(finished[0]?.ok).toBe(true);
  });

  it('opencode --format json：tool_use 一次带齐状态，直接 finished', () => {
    const steps = parseAll('opencode-json', fixture('opencode-events.jsonl'));
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: 'bash', state: 'finished', ok: true });
    expect(steps[0]?.label).toContain('Get-ChildItem');
  });

  it('噪音行（非 JSON / 半行）不抛错也不产步骤', () => {
    const p = createStepParser('claude-json');
    expect(p.feed('not json at all\n{"broken": ')).toEqual([]);
    expect(p.feed('plain text line\n')).toEqual([]);
  });

  it('kimi stream-json（OpenAI 风格，实测样例）：tool_calls → started，role:tool → finished', () => {
    const steps = parseAll('kimi-json', fixture('kimi-stream.jsonl'));
    const started = steps.find((s) => s.state === 'started');
    const finished = steps.find((s) => s.state === 'finished');
    expect(started).toMatchObject({ action: 'Bash', label: 'ls -la' });
    expect(finished).toMatchObject({ action: 'tool_result', ok: true });
    expect(finished?.ref).toBe(started?.ref);
  });

  it('gemini stream-json（官方文档构造样例）：兼容 tool_name/parameters 与 name/args 两种写法', () => {
    const steps = parseAll('gemini-json', fixture('gemini-stream.jsonl'));
    const started = steps.filter((s) => s.state === 'started');
    const finished = steps.filter((s) => s.state === 'finished');
    expect(started).toHaveLength(2);
    expect(started[0]).toMatchObject({ action: 'run_shell_command', label: 'ls -la', ref: 'call_abc' });
    expect(started[1]).toMatchObject({ action: 'write_file', label: 'b.txt', ref: 'call_def' });
    expect(finished[0]).toMatchObject({ ok: true, ref: 'call_abc' });
    expect(finished[1]).toMatchObject({ ok: false, ref: 'call_def' });
  });

  it('grok 复用 claude 解析器（实测其 streaming-messages-json 与 claude 同构）', () => {
    // grok 的样例就是 claude 格式骨架；用 claude fixture 验证同一解析器产出
    const steps = parseAll('claude-json', fixture('claude-stream.jsonl'));
    expect(steps.some((s) => s.action === 'Bash' && s.state === 'started')).toBe(true);
  });

  it('qoder 实测样例（claude 同构）：tool_use → started，tool_result → finished', () => {
    const steps = parseAll('claude-json', fixture('qoder-stream.jsonl'));
    const started = steps.find((s) => s.state === 'started');
    const finished = steps.find((s) => s.state === 'finished');
    expect(started).toMatchObject({ action: 'Bash', label: 'ls -la' });
    expect(finished).toMatchObject({ action: 'tool_result', ok: true });
    expect(finished?.ref).toBe(started?.ref);
  });

  it('trae 实测样例（未配模型，只有 init）：不产步骤也不报错', () => {
    expect(parseAll('claude-json', fixture('trae-stream.jsonl'))).toEqual([]);
  });

  it('dsh 实测骨架（缺 key 无 tool_call）+ 官方文档构造的 tool_call/tool_result 配对', () => {
    // 实测部分：session/status/final 骨架不产步骤、不报错
    expect(parseAll('dsh-json', fixture('dsh-events.jsonl'))).toEqual([]);
    // 文档口径部分（本机缺 key 未取得实测，字段名按文档 + 兼容双写法）
    const doc =
      '{"type":"tool_call","callId":"c1","name":"bash","arguments":{"command":"ls"}}\n' +
      '{"type":"tool_result","callId":"c1","isError":false}\n';
    const steps = parseAll('dsh-json', doc);
    expect(steps[0]).toMatchObject({ action: 'bash', label: 'ls', state: 'started', ref: 'c1' });
    expect(steps[1]).toMatchObject({ state: 'finished', ok: true, ref: 'c1' });
  });

  it('mcode 实测样例（0.6.13）：4 次 tool_call 全部 started/completed 配对，reasoning/agent_message/updated 跳过', () => {
    const steps = parseAll('mcode-json', fixture('mcode-events.jsonl'));
    const started = steps.filter((s) => s.state === 'started');
    const finished = steps.filter((s) => s.state === 'finished');
    expect(started).toHaveLength(4);
    expect(started.map((s) => s.action)).toEqual(['glob', 'bash', 'glob', 'glob']);
    // started 时 input 尚在流式组装，label 可缺；completed 时 input 完整，label 必有
    expect(finished).toHaveLength(4);
    expect(finished.map((s) => s.label).every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(new Set(started.map((s) => s.ref)).size).toBe(4);
    for (const f of finished) expect(f.ok).toBe(true);
  });

  it('finalText：各族解析器从 result/final 事件提取最终回答', () => {
    const claude = createStepParser('claude-json');
    claude.feed(fixture('claude-stream.jsonl'));
    expect(typeof claude.finalText?.()).toBe('string');
    const kimi = createStepParser('kimi-json');
    kimi.feed(fixture('kimi-stream.jsonl'));
    expect(kimi.finalText?.()).toContain('research');
    const codex = createStepParser('codex-json');
    codex.feed(fixture('codex-events.jsonl'));
    expect(codex.finalText?.()).toBe('done');
    const opencode = createStepParser('opencode-json');
    opencode.feed(fixture('opencode-events.jsonl'));
    expect(typeof opencode.finalText?.()).toBe('string');
    const mcode = createStepParser('mcode-json');
    mcode.feed(fixture('mcode-events.jsonl'));
    expect(typeof mcode.finalText?.()).toBe('string');
  });

  it('待办计划：7 族解析器都能从 TodoWrite 类工具提取三态计划', () => {
    const todos = [
      { content: '读代码', status: 'completed' },
      { content: '改实现', status: 'in_progress' },
      { content: '跑测试', status: 'pending' },
    ];
    const cases: Array<[Parameters<typeof createStepParser>[0], string]> = [
      ['claude-json', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos } }] } }) + '\n'],
      ['opencode-json', JSON.stringify({ type: 'tool_use', part: { type: 'tool', tool: 'todowrite', callID: 'c1', state: { status: 'completed', input: { todos } } } }) + '\n'],
      ['codex-json', JSON.stringify({ type: 'item.completed', item: { id: 'p1', type: 'plan', plan: [{ step: '读代码', status: 'completed' }, { step: '改实现', status: 'in_progress' }] } }) + '\n'],
      ['gemini-json', JSON.stringify({ type: 'tool_use', tool_name: 'todo_write', tool_id: 'g1', parameters: { todos } }) + '\n'],
      ['kimi-json', JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'k1', type: 'function', function: { name: 'TodoWrite', arguments: JSON.stringify({ todos }) } }] }) + '\n'],
      ['dsh-json', JSON.stringify({ type: 'tool_call', callId: 'd1', name: 'todo_write', arguments: { todos } }) + '\n'],
      ['mcode-json', JSON.stringify({ type: 'item.started', item: { id: 'm1', type: 'tool_call', toolCall: { id: 'm1', name: 'todo_write', input: { todos } } } }) + '\n'],
    ];
    for (const [format, line] of cases) {
      const p = createStepParser(format);
      p.feed(line);
      const plan = p.plan?.();
      expect(plan, format).toBeDefined();
      expect(plan!.length, format).toBeGreaterThanOrEqual(2);
      expect(plan![0], format).toMatchObject({ text: '读代码', state: 'completed' });
      expect(plan![1], format).toMatchObject({ text: '改实现', state: 'in_progress' });
    }
  });
});

describe('task_step 上行收口（Emitter）', () => {
  it('label 超长截断到 160 且家目录脱敏；终态后步骤被丢弃', () => {
    const sent: ClientMessage[] = [];
    const emitter = new Emitter({ sink: (m) => sent.push(m as ClientMessage), home: '/home/u' });
    const base = { type: 'task_step', taskId: 't1', seq: 1, action: 'Bash', state: 'started', at: 'now' } as const;
    emitter.emit({ ...base, label: `cat ${'/home/u'}/secret/${'x'.repeat(300)}` });
    const step = sent[0] as Extract<ClientMessage, { type: 'task_step' }>;
    expect(step.label!.length).toBeLessThanOrEqual(160);
    expect(step.label).toContain('~');
    expect(step.label).not.toContain('/home/u');
    // 终态后该 task 的一切上行（含步骤）被丢弃
    emitter.emit({ type: 'task_status', taskId: 't1', status: 'success' });
    emitter.emit({ ...base, seq: 2 });
    expect(sent.filter((m) => m.type === 'task_step')).toHaveLength(1);
  });
});

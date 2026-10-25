/**
 * 内嵌 Web 面板的结构化日志模型测试（不启动浏览器）
 *
 * 用最小 DOM 桩在 vm 中执行页面脚本，直接验证 7 族 CLI 事件的归一化：
 * tool_use/tool_result 合并且不重复占行、缓存有界。防止「样式升级但日志仍不可读」。
 */

import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { DASHBOARD_HTML } from '../src/transport/control-plane-page';

function makeContext(): vm.Context {
  const element = () => ({
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    children: [],
    value: '',
    checked: true,
    innerHTML: '',
    textContent: '',
    addEventListener() {},
    setAttribute() {},
    focus() {},
  });
  const document = {
    hidden: false,
    body: { style: {} },
    getElementById: () => element(),
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const context = vm.createContext({
    document,
    location: { search: '', pathname: '/' },
    localStorage: { getItem: () => null, setItem() {} },
    history: { replaceState() {} },
    navigator: {},
    URLSearchParams,
    JSON,
    Date,
    Math,
    String,
    Number,
    Array,
    Object,
    console,
    setTimeout: () => 0,
    setInterval: () => 0,
    clearInterval() {},
  });
  const script = DASHBOARD_HTML.match(/<script>([\s\S]*?)<\/script>/)![1];
  vm.runInContext(script, context);
  return context;
}

function feed(context: vm.Context, value: unknown): void {
  vm.runInContext(`consumeObject(${JSON.stringify(value)})`, context);
}

function events(context: vm.Context): Array<Record<string, unknown>> {
  return vm.runInContext('log.events', context) as Array<Record<string, unknown>>;
}

describe('Web 面板结构化日志模型', () => {
  it('claude 族：tool_use 与 tool_result 合并成一张工具卡', () => {
    const c = makeContext();
    feed(c, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
    feed(c, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
    const ev = events(c);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'tool', title: 'Bash', state: 'done', detail: 'ok' });
  });

  it('opencode / mimo：工具事件与输出合并', () => {
    const c = makeContext();
    feed(c, { type: 'tool_use', part: { type: 'tool', tool: 'bash', callID: 'c1', state: { status: 'completed', input: { command: 'ls' }, output: 'files' } } });
    expect(events(c)).toHaveLength(1);
    expect(events(c)[0]).toMatchObject({ title: 'bash', state: 'done', detail: 'files' });
  });

  it('codex：command_execution started/completed 不重复占行', () => {
    const c = makeContext();
    feed(c, { type: 'item.started', item: { id: 'x1', type: 'command_execution', command: 'ls' } });
    feed(c, { type: 'item.completed', item: { id: 'x1', type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: 'done' } });
    expect(events(c)).toHaveLength(1);
    expect(events(c)[0]).toMatchObject({ state: 'done', detail: 'done' });
  });

  it('gemini / dsh：tool_result 按 tool_id/callId 配对', () => {
    const gemini = makeContext();
    feed(gemini, { type: 'tool_use', tool_name: 'read_file', tool_id: 'g1', parameters: { path: 'a.ts' } });
    feed(gemini, { type: 'tool_result', tool_id: 'g1', status: 'success', output: 'content' });
    expect(events(gemini)).toHaveLength(1);
    expect(events(gemini)[0]).toMatchObject({ state: 'done', detail: 'content' });

    const dsh = makeContext();
    feed(dsh, { type: 'tool_call', callId: 'd1', name: 'bash', arguments: { command: 'ls' } });
    feed(dsh, { type: 'tool_result', callId: 'd1', output: 'ok' });
    expect(events(dsh)).toHaveLength(1);
  });

  it('kimi：OpenAI tool_calls 与 role:tool 配对', () => {
    const c = makeContext();
    feed(c, { role: 'assistant', tool_calls: [{ id: 'k1', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] });
    feed(c, { role: 'tool', tool_call_id: 'k1', content: 'ok' });
    expect(events(c)).toHaveLength(1);
    expect(events(c)[0]).toMatchObject({ title: 'Bash', state: 'done', detail: 'ok' });
  });

  it('mcode：item.started/completed 的 toolCall 配对', () => {
    const c = makeContext();
    feed(c, { type: 'item.started', item: { id: 'm1', type: 'tool_call', toolCall: { id: 'm1', name: 'glob', input: { pattern: '*' } } } });
    feed(c, { type: 'item.completed', item: { id: 'm1', type: 'tool_call', toolCall: { id: 'm1', name: 'glob', output: { content: [{ type: 'text', text: 'a.ts' }] } } } });
    expect(events(c)).toHaveLength(1);
    expect(events(c)[0]).toMatchObject({ state: 'done', detail: 'a.ts' });
  });

  it('缓存有界：超过 600 条后丢弃最旧并标记截断', () => {
    const c = makeContext();
    for (let i = 0; i < 650; i += 1) vm.runInContext(`ingestLine('line ${i}')`, c);
    expect(events(c).length).toBeLessThanOrEqual(600);
    expect(vm.runInContext('log.dropped', c)).toBe(true);
    expect(events(c)[0]!.detail).not.toBe('line 0');
  });
});

import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStepParser } from '../src/adapters/step-parsers.js';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import type { ParsedStep } from '../src/adapters/step-parsers.js';

/**
 * feed 富化（tasks.md 4.7 / 4.8；design「富 task_step」「canonical 消息」）：
 *
 *  - 4.7：headless 结构化输出里的**中间 agent 文本**（assistant text 块）提取为
 *    canonical 消息 —— messageId 优先用 CLI 原生 message.id；此前它们只埋在 task_log 里。
 *  - 4.8：task_step 增加可选 toolCall（toolCallId/name/kind/title/status/locations/content），
 *    kind 用 ACP 的 read/edit/delete/move/search/execute/think/fetch/switch_mode/other；
 *    content 有界 text/diff/terminal 块；rawInput/rawOutput 默认不上行；
 *    无法可靠提取的适配器省略 toolCall，只保留 legacy 字段。
 *
 * 样例全部来自本机实测 fixture（claude-stream.jsonl / claude-tooluse-sample）—— 未实测的格式不做、不猜。
 */

function fixture(name: string): string {
  return readFileSync(join('test', 'fixtures', name), 'utf8');
}

describe('claude-json：中间 agent 消息提取（4.7）', () => {
  it('assistant text 块 → drainMessages：messageId 用 CLI 原生 message.id', () => {
    const p = createStepParser('claude-json');
    p.feed(fixture('claude-stream.jsonl'));
    const messages = p.drainMessages?.() ?? [];
    // fixture 里唯一一条带 text 的 assistant 消息（thinking/tool_use 消息的 id 不同，不混入）
    expect(messages).toHaveLength(1);
    expect(messages[0]?.messageId).toBe('msg_3KOm5FCNAmYKhaD1bGhT4lBP');
    expect(messages[0]?.text).toContain('done');
    // 消息 drain 后清空（重复调用不重复给）
    expect(p.drainMessages?.() ?? []).toHaveLength(0);
  });

  it('thinking 块与空文本不进消息；只有 text 块算', () => {
    const p = createStepParser('claude-json');
    const msgId = 'msg_test_1';
    p.feed(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: msgId,
          content: [
            { type: 'thinking', thinking: '内心戏不该成为消息' },
            { type: 'text', text: '' },
            { type: 'text', text: '第一条' },
            { type: 'text', text: '第二条' },
          ],
        },
      }) + '\n',
    );
    const messages = p.drainMessages?.() ?? [];
    // 同一条 assistant 消息的多个 text 块聚合为一条
    expect(messages).toEqual([{ messageId: msgId, text: '第一条\n\n第二条' }]);
  });

  it('message.id 缺省时 messageId 省略（调用方生成稳定 ID）', () => {
    const p = createStepParser('claude-json');
    p.feed(
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '无 id 消息' }] } }) + '\n',
    );
    const messages = p.drainMessages?.() ?? [];
    expect(messages).toEqual([{ text: '无 id 消息' }]);
  });
});

describe('claude-json：富 toolCall（4.8）', () => {
  it('tool_use 的工具名映射 ACP kind；input 的路径字段进 locations', () => {
    const p = createStepParser('claude-json');
    const steps: ParsedStep[] = [];
    steps.push(
      ...p.feed(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_t1',
            content: [
              { type: 'tool_use', id: 'tool_bash', name: 'Bash', input: { command: 'ls -la' } },
              {
                type: 'tool_use',
                id: 'tool_edit',
                name: 'Edit',
                input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
              },
              { type: 'tool_use', id: 'tool_read', name: 'Read', input: { path: 'README.md' } },
              { type: 'tool_use', id: 'tool_web', name: 'WebFetch', input: { url: 'https://example.com' } },
            ],
          },
        }) + '\n',
      ),
    );
    expect(steps[0]?.toolCall).toMatchObject({ toolCallId: 'tool_bash', name: 'Bash', kind: 'execute' });
    expect(steps[1]?.toolCall).toMatchObject({
      toolCallId: 'tool_edit',
      name: 'Edit',
      kind: 'edit',
      locations: [{ path: 'src/app.ts' }],
    });
    expect(steps[2]?.toolCall).toMatchObject({
      toolCallId: 'tool_read',
      name: 'Read',
      kind: 'read',
      locations: [{ path: 'README.md' }],
    });
    expect(steps[3]?.toolCall).toMatchObject({ toolCallId: 'tool_web', name: 'WebFetch', kind: 'fetch' });
    // rawInput 不上行：toolCall 里没有 input 原文（只有 locations 的路径）
    expect(JSON.stringify(steps[1]?.toolCall)).not.toContain('old_string');
  });

  it('tool_result 的 content 映射有界 terminal/text 块', () => {
    const p = createStepParser('claude-json');
    const big = 'x'.repeat(20_000);
    const steps = p.feed(
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tool_bash',
              content: big,
            },
          ],
        },
      }) + '\n',
    );
    const finished = steps.find((s) => s.state === 'finished');
    expect(finished?.toolCall).toMatchObject({ toolCallId: 'tool_bash', name: 'tool_result' });
    const content = finished?.toolCall?.content;
    expect(content).toBeDefined();
    expect(content?.[0]?.kind).toBe('terminal');
    // 有界：单块截断到 16KB
    expect(content?.[0]?.text.length).toBeLessThanOrEqual(16_384);
  });

  it('既有 fixture 跑通：tool_use → started（带 toolCall），tool_result → finished（terminal 块）', () => {
    const p = createStepParser('claude-json');
    const steps = p.feed(fixture('claude-stream.jsonl'));
    const started = steps.find((s) => s.state === 'started');
    expect(started?.action).toBe('Bash');
    expect(started?.toolCall).toMatchObject({ toolCallId: 'tool_lZ391GKGVYynyiDkOvllaoBk', kind: 'execute' });
    const finished = steps.find((s) => s.state === 'finished');
    expect(finished?.toolCall?.content?.[0]?.kind).toBe('terminal');
  });
});

// —— supervisor 集成：FakeChild 驱动 headless stdout（JSONL）——
const cpMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: cpMocks.spawn as unknown as typeof actual.spawn };
});

const restores: Array<() => void> = [];
afterEach(() => {
  for (const fn of restores.splice(0)) fn();
  cpMocks.spawn.mockReset();
});

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  kill(): boolean {
    return true;
  }
}

describe('supervisor：中间消息与富步骤经 hooks 上行', () => {
  it('headless stdout 的 assistant text → hooks.onAgentMessage（messageId 原生透传）', async () => {
    const { TaskSupervisor } = await import('../src/core/task-supervisor.js');
    const def = agentDefOf('kimi-code');
    if (!def) throw new Error('kimi-code 定义缺失');
    const before = { bin: def.bin, taskArgs: def.taskArgs, steps: def.steps } as const;
    def.bin = 'node';
    def.taskArgs = ['--fake'];
    def.steps = 'claude-json' as typeof def.steps;
    restores.push(() => {
      def.bin = before.bin;
      def.taskArgs = before.taskArgs;
      def.steps = before.steps;
    });

    const child = new FakeChild();
    cpMocks.spawn.mockReturnValueOnce(child as never);
    const sv = new TaskSupervisor();
    const agentMessages: Array<{ messageId?: string; text: string }> = [];
    const steps: ParsedStep[] = [];
    const handle = sv.submit(
      { taskId: 't_feed', agentType: 'kimi-code', cwd: join(tmpdir()), args: [] },
      {
        onLog: () => undefined,
        onStep: (step) => steps.push(step as ParsedStep),
        onAgentMessage: (message) => agentMessages.push(message),
        onStatus: () => undefined,
      },
    );
    child.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_native_1',
            content: [
              { type: 'text', text: '中间回答' },
              { type: 'tool_use', id: 'tool_1', name: 'Bash', input: { command: 'ls' } },
            ],
          },
        }) + '\n',
      ),
    );
    child.emit('close', 0);
    await expect(handle.done).resolves.toBe('success');
    expect(agentMessages).toEqual([{ messageId: 'msg_native_1', text: '中间回答' }]);
    expect(steps[0]?.toolCall).toMatchObject({ toolCallId: 'tool_1', kind: 'execute' });
  });
});

// —— dispatch 集成：onAgentMessage 落 canonical task_message ——
const runnerMocks = vi.hoisted(() => ({ startTask: vi.fn() }));
vi.mock('../src/runner.js', () => ({ startTask: runnerMocks.startTask }));

describe('dispatch：中间 agent 消息落 canonical task_message（4.7）', () => {
  it('hooks.onAgentMessage → appendEvent(task_message) + emitter 上行；messageId 幂等', async () => {
    const { mkdtempSync: mk, rmSync: rm } = await import('node:fs');
    const { dispatchRunTask } = await import('../src/app/task-dispatch.js');
    const { SessionStore } = await import('../src/core/session-store.js');
    const { Emitter } = await import('../src/core/emitter.js');
    const { TaskRegistry } = await import('../src/app/task-registry.js');
    const type = await import('../src/protocol.js');
    const dir = mk(join(tmpdir(), 'agent-bridge-feedmsg-'));
    restores.push(() => {
      rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const store = new SessionStore(join(dir, 'state.db'));
    const sent: type.ClientMessage[] = [];
    const emitter = new Emitter({ sink: (msg) => sent.push(msg as type.ClientMessage) });
    let hooks: Record<string, unknown> = {};
    runnerMocks.startTask.mockImplementation((req, h) => {
      hooks = h as Record<string, unknown>;
      return { taskId: req.taskId, cancel: () => undefined, done: Promise.resolve('success' as const) };
    });
    dispatchRunTask(
      { type: 'run_task', taskId: 't_msg', agentType: 'kimi-code', cwd: dir, args: [], prompt: 'hi' },
      {
        emitter,
        tasks: new Map(),
        registry: new TaskRegistry(),
        maxConcurrent: 5,
        maxQueued: 5,
        diffMaxBytes: 1024,
        captureDiffByDefault: false,
        requireServiceToken: false,
        store,
        log: () => undefined,
      },
    );
    const onAgentMessage = hooks['onAgentMessage'] as
      | ((message: { messageId?: string; text: string }) => void)
      | undefined;
    expect(typeof onAgentMessage).toBe('function');
    onAgentMessage?.({ messageId: 'msg_native_1', text: '中间回答' });
    // 同 messageId 同文本：幂等 duplicate，不产生第二条事件
    onAgentMessage?.({ messageId: 'msg_native_1', text: '中间回答' });

    const events = store.listEvents('t_msg').filter((e) => e.type === 'task_message');
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      messageId: 'msg_native_1',
      role: 'agent',
      state: 'complete',
      text: '中间回答',
    });
    const sentMessages = sent.filter(
      (m): m is Extract<type.ClientMessage, { type: 'task_message' }> => m.type === 'task_message',
    );
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ messageId: 'msg_native_1', state: 'complete', text: '中间回答' });
    store.close();
  });
});

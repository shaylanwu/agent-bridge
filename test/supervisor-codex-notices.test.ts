import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * codex app-server 的「非内容型」通知必须上行成任务日志。
 *
 * 2026-11-27 复盘：codex 0.171 的 responses WebSocket 直连会被丢，CLI 会先打一串
 * `Reconnecting... n/5`（实测 113s）才回退 HTTPS。这段时间 `onCodexUpdate` 只认
 * delta 与 item 事件，其余全丢 —— 平台侧一个字都收不到，外观与「回合挂死」一致。
 * 这里验证修好的那一半：error/warning 会变成 `[codex] …` 的 stderr 日志，且同样内容不刷屏。
 */
const codexMock = vi.hoisted(() => ({
  opts: undefined as { onUpdate?: (n: Record<string, unknown>) => void } | undefined,
  reject: undefined as ((error: Error) => void) | undefined,
}));

vi.mock('../src/adapters/codex-app-server.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/codex-app-server.js')>();
  return {
    ...actual,
    runCodexPrompt: (opts: { onUpdate?: (n: Record<string, unknown>) => void }) => {
      codexMock.opts = opts;
      return new Promise((_resolve, reject) => {
        codexMock.reject = reject;
      });
    },
  };
});

const { agentDefOf } = await import('../src/adapters/agent-adapters.js');
const { TaskSupervisor } = await import('../src/core/task-supervisor.js');

const restores: Array<() => void> = [];
afterEach(() => {
  for (const fn of restores.splice(0)) fn();
  codexMock.opts = undefined;
  codexMock.reject = undefined;
});

/** codex 必须「已安装」才会进 launchAppServer；借 node 的可解析路径，spawn 已被 adapter mock 掉 */
function stubCodexBin(): void {
  const def = agentDefOf('codex');
  if (!def) throw new Error('codex 定义缺失');
  const before = def.bin;
  def.bin = 'node';
  restores.push(() => {
    def.bin = before;
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function start(): Promise<{ logs: string[]; done: Promise<string> }> {
  stubCodexBin();
  const logs: string[] = [];
  const sv = new TaskSupervisor();
  const handle = sv.submit(
    { taskId: 't_codex_notice', agentType: 'codex', cwd: tmpdir(), args: [], prompt: 'hi', appServer: true },
    { onLog: (_stream, text) => logs.push(text), onStatus: () => undefined },
  );
  for (let i = 0; i < 20 && !codexMock.opts; i += 1) await tick();
  expect(codexMock.opts).toBeDefined();
  return { logs, done: handle.done as unknown as Promise<string> };
}

describe('调度器上行的 codex 非内容通知', () => {
  it('重连/回退类 error 立刻变成 [codex] 日志，同样内容只出现一次', async () => {
    const { logs, done } = await start();
    const onUpdate = codexMock.opts?.onUpdate;
    expect(onUpdate).toBeTypeOf('function');

    const reconnect = {
      method: 'error',
      params: {
        error: { message: 'Reconnecting... 3/5' },
        additionalDetails: 'request timed out',
        willRetry: true,
      },
    };
    onUpdate?.(reconnect);
    onUpdate?.(reconnect);
    expect(logs.filter((line) => line.includes('Reconnecting... 3/5'))).toHaveLength(1);
    expect(logs.join('')).toContain('[codex] Reconnecting... 3/5（request timed out）［将自动重试］');

    onUpdate?.({ method: 'warning', params: { message: 'Falling back from WebSockets to HTTPS transport.' } });
    expect(logs.join('')).toContain('[codex] Falling back from WebSockets to HTTPS transport.');

    codexMock.reject?.(new Error('boom'));
    await expect(done).resolves.toBe('failed');
  });

  it('内容类通知不受影响：delta 仍然只上行正文', async () => {
    const { logs, done } = await start();
    codexMock.opts?.onUpdate?.({ method: 'item/agentMessage/delta', params: { delta: 'BANANA42' } });
    expect(logs.join('')).toContain('BANANA42');
    expect(logs.join('')).not.toContain('[codex]');
    codexMock.reject?.(new Error('boom'));
    await done;
  });
});

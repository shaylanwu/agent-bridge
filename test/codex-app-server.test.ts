import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { codexAppServerArgs, codexChildEnv, codexTurnError, runCodexPrompt } from '../src/adapters/codex-app-server.js';

const { spawnCliProcess } = vi.hoisted(() => ({ spawnCliProcess: vi.fn() }));
vi.mock('../src/adapters/agent-adapters.js', () => ({
  spawnCliProcess,
  killCliProcess: vi.fn(),
}));

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  pid: number;
  kill: () => void;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.kill = () => child.emit('close', 0);
  return child;
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Codex App Server adapter', () => {
  it('使用已验证的 app-server stdio 入口', () => {
    expect(codexAppServerArgs()).toEqual(['app-server', '--stdio']);
  });

  it('只有明确的 completed 算成功；failed/interrupted/未知状态均保留失败语义', () => {
    expect(codexTurnError('completed')).toBeUndefined();
    expect(codexTurnError('failed', { message: 'boom' })?.message).toContain('boom');
    expect(codexTurnError('interrupted')?.message).toContain('interrupted');
    expect(codexTurnError('unknown')?.message).toContain('unknown');
  });

  it('子进程环境：清掉宿主会话上下文，并按声明注入外部代理', () => {
    const env = codexChildEnv({
      PATH: '/usr/bin',
      CODEBUDDY_SESSION_ID: 'host-session',
      CODEBUDDY_MCP_CONFIG: '{}',
      AGENT_BRIDGE_EXTERNAL_PROXY: 'http://127.0.0.1:7897',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.CODEBUDDY_SESSION_ID).toBeUndefined();
    expect(env.CODEBUDDY_MCP_CONFIG).toBeUndefined();
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    expect(env.http_proxy).toBe('http://127.0.0.1:7897');
  });

  it('stderr 必须被读走：旁路转发给 onStderr，并作为失败消息的诊断后缀', async () => {
    const child = fakeChild();
    spawnCliProcess.mockReturnValue(child);
    const seen: string[] = [];
    const running = runCodexPrompt({
      cwd: process.cwd(),
      prompt: 'hi',
      command: 'codex',
      onStderr: (text) => seen.push(text),
    });
    await tick();
    // pipe 缓冲若无人读，子进程会阻塞在 write 上（真实挂死形态）；这里断言确实有订阅方在消费
    child.stderr.write('Reconnecting... 2/5 request timed out\n');
    await tick();
    expect(seen.join('')).toContain('Reconnecting... 2/5');

    // 先挂断言再触发 close：否则同 tick 内先拒后挂会变成 unhandled rejection
    const rejection = expect(running).rejects.toThrow(/Reconnecting\.\.\. 2\/5/);
    child.emit('close', 1);
    await rejection;
  });

  it('没订阅 onStderr 时也不影响回合（stderr 只进诊断尾部）', async () => {
    const child = fakeChild();
    spawnCliProcess.mockReturnValue(child);
    const running = runCodexPrompt({ cwd: process.cwd(), prompt: 'hi', command: 'codex' });
    await tick();
    child.stderr.write('sandbox: warning\n');
    await tick();
    const rejection = expect(running).rejects.toThrow(/Codex app-server 退出（code 0）/);
    child.emit('close', 0);
    await rejection;
  });
});

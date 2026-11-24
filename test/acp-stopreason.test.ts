import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { TaskSupervisor } from '../src/core/task-supervisor.js';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import type { TaskFinishInfo, TaskStatus } from '../src/protocol.js';

/**
 * ACP stopReason 的完整结算路径（tasks.md 5.3 / 7.2）：
 *
 * 只有 `end_turn` 记成功；`cancelled` → cancelled；`max_tokens` / `max_turn_requests` /
 * `refusal`（以及一切未知值）→ failed（agent_error）**且 feedIncomplete: true** ——
 * 回合没有正常结束，canonical feed 必然不完整，不能让 UI 当完整历史。
 * 未知 stopReason 不写进受限字段（收敛到受控枚举）。
 *
 * 结算发生在 supervisor 的 launchAcp 终态分支 —— 这里用真 spawn 的 fake ACP
 * （脚本按 argv 决定 stopReason）走生产同一条路径。
 */
const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const restores: Array<() => void> = [];
afterEach(() => {
  for (const fn of restores.splice(0)) fn();
});

const FAKE_ACP = String.raw`
const mode = process.argv[2];
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
    return;
  }
  if (m.method === 'session/new') {
    send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'sess_stop' } });
    return;
  }
  if (m.method === 'session/prompt') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: 'sess_stop',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
    }});
    send({ jsonrpc: '2.0', id: m.id, result: { stopReason: mode, text: 'partial' } });
    return;
  }
  if (m.method === 'session/cancel') process.exit(0);
});
`;

function fakeAcpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-stopreason-'));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放滞后 */
    }
  });
  const script = join(dir, 'fake-acp.cjs');
  writeFileSync(script, FAKE_ACP);
  return script;
}

function stubKimi(): void {
  const def = agentDefOf('kimi-code');
  if (!def) throw new Error('kimi-code 定义缺失');
  const before = def.bin;
  def.bin = 'node';
  restores.push(() => {
    def.bin = before;
  });
}

async function runWithStopReason(
  stopReason: string,
): Promise<{ status: TaskStatus; info: TaskFinishInfo | undefined }> {
  stubKimi();
  const script = fakeAcpPath();
  const sv = new TaskSupervisor();
  let info: TaskFinishInfo | undefined;
  const status = await new Promise<TaskStatus>((resolve) => {
    sv.submit(
      {
        taskId: `t_stop_${stopReason}`,
        agentType: 'kimi-code',
        cwd: tmpdir(),
        args: [],
        acp: true,
        acpSpec: { command: process.execPath, args: [script, stopReason] },
      },
      {
        onLog: () => undefined,
        onStatus: (s, i) => {
          if (s !== 'running') {
            info = i;
            resolve(s);
          }
        },
      },
    );
  });
  return { status, info };
}

describe('ACP stopReason 结算（max_tokens / refusal / 未知值）', () => {
  it('max_tokens → failed + agent_error + feedIncomplete（不假成功）', async () => {
    const { status, info } = await runWithStopReason('max_tokens');
    expect(status).toBe('failed');
    expect(info).toMatchObject({ errorCode: 'agent_error', feedIncomplete: true });
  });

  it('refusal → failed + agent_error + feedIncomplete', async () => {
    const { status, info } = await runWithStopReason('refusal');
    expect(status).toBe('failed');
    expect(info).toMatchObject({ errorCode: 'agent_error', feedIncomplete: true });
  });

  it('max_turn_requests → failed + feedIncomplete', async () => {
    const { status, info } = await runWithStopReason('max_turn_requests');
    expect(status).toBe('failed');
    expect(info).toMatchObject({ feedIncomplete: true });
  });

  it('未知 stopReason 不写进受限字段（收敛：stopReason 省略，仍是 failed + feedIncomplete）', async () => {
    const { status, info } = await runWithStopReason('some_future_reason');
    expect(status).toBe('failed');
    expect(info).toMatchObject({ feedIncomplete: true });
    expect(info?.stopReason).toBeUndefined();
  });

  it('end_turn 对照组 → success（只有它记成功）', async () => {
    const { status, info } = await runWithStopReason('end_turn');
    expect(status).toBe('success');
    expect(info).toMatchObject({ exitCode: 0, result: 'partial' });
    expect(info?.feedIncomplete).toBeUndefined();
  });
});

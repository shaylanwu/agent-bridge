import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TaskSupervisor } from '../src/core/task-supervisor.js';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
/**
 * `{{prompt}}` 必须被替换 —— **两条来源都要覆盖**。
 *
 * 曾经的 bug：supervisor 只在「请求没带 args」时才替换占位符。于是
 *  ① 平台自己传 `args: ['--x', '{{prompt}}']`（协议明写可用占位）→ 字面量进了 CLI；
 *  ② 会话续接时 bridge 自己拼的 `resumeArgs` 里也有 `{{prompt}}` → 模型收到字面量，
 *     用户这一轮说的话根本没进去，而任务照样报 success（最坏的那种静默失败）。
 *
 * 判据不靠读代码，而是让假 CLI 把自己的 argv 写出来。
 */
const FAKE = String.raw`
const { writeFileSync } = require('node:fs');
writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));
process.exit(0);
`;

const restores: Array<() => void> = [];
afterEach(() => {
  for (const fn of restores.splice(0)) fn();
});

function stubAgent(): { dir: string; script: string; outFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-argv-'));
  const script = join(dir, 'fake-cli.cjs');
  const outFile = join(dir, 'argv.json');
  writeFileSync(script, FAKE);

  const def = agentDefOf('kimi-code');
  if (!def) throw new Error('kimi-code 定义缺失');
  const before = { bin: def.bin, taskArgs: def.taskArgs, steps: def.steps };
  // bin 指向真实 node，argv 交给假脚本 —— 这样 spawn 走的是生产同一条路径
  def.bin = 'node';
  def.taskArgs = [script, outFile, '{{prompt}}'];
  def.steps = undefined;
  restores.push(() => {
    def.bin = before.bin;
    def.taskArgs = before.taskArgs;
    def.steps = before.steps;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows 句柄释放可能滞后 */
    }
  });
  return { dir, script, outFile };
}

async function runAndRead(
  args: string[],
  prompt: string | undefined,
  outFile: string,
  extra: {
    internalArgs?: string[];
    permissionPolicy?: 'default' | 'allow-full' | 'full';
    permissionMode?: 'default' | 'full';
  } = {},
): Promise<unknown> {
  const sv = new TaskSupervisor();
  await new Promise<void>((done) => {
    sv.submit(
      {
        taskId: `t-${Math.random().toString(36).slice(2)}`,
        agentType: 'kimi-code',
        cwd: tmpdir(),
        args,
        ...(prompt === undefined ? {} : { prompt }),
        ...extra,
      },
      {
        onLog: () => undefined,
        onStatus: (status) => {
          if (status !== 'running') done();
        },
      },
    );
  });
  return JSON.parse(readFileSync(outFile, 'utf8'));
}

describe('headless 终态收尾', () => {
  it('最后一条错误 JSON 无换行且未传 onStep，仍在 close 时 flush 并结算 failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-eof-'));
    const script = join(dir, 'error-without-newline.cjs');
    writeFileSync(
      script,
      `process.stdout.write(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,error:'no model'}));process.exit(0);`,
    );
    const def = agentDefOf('kimi-code')!;
    const before = { bin: def.bin, taskArgs: def.taskArgs, steps: def.steps };
    def.bin = 'node';
    def.taskArgs = [script];
    def.steps = 'claude-json';
    restores.push(() => {
      def.bin = before.bin;
      def.taskArgs = before.taskArgs;
      def.steps = before.steps;
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 句柄释放可能滞后 */
      }
    });

    const sv = new TaskSupervisor();
    let terminal: string | undefined;
    let error = '';
    const handle = sv.submit(
      {
        taskId: 't_eof_error',
        agentType: 'kimi-code',
        cwd: dir,
        args: [],
      },
      {
        onLog: () => undefined,
        onStatus: (status, info) => {
          if (status !== 'running') {
            terminal = status;
            error = info?.error ?? '';
          }
        },
      },
    );
    await handle.done;
    expect(terminal).toBe('failed');
    expect(error).toContain('no model');
  });
});

describe('{{prompt}} 占位替换', () => {
  it('请求不带 args 时用 adapter 模板并替换占位', async () => {
    const { outFile } = stubAgent();
    expect(await runAndRead([], 'hello world', outFile)).toEqual(['hello world']);
  });

  it('请求自带 args 且含占位（平台传参 / 续会话 resumeArgs）→ 仍然替换', async () => {
    const { script, outFile } = stubAgent();
    // 这正是 conversation.ts 续接时传的形状：sessionId 已替换，prompt 还是占位
    const args = [script, outFile, '--resume', 'sess_123', '{{prompt}}'];
    expect(await runAndRead(args, 'second turn words', outFile)).toEqual([
      '--resume',
      'sess_123',
      'second turn words',
    ]);
  });

  it('allow-full 下 default 会话的内部 resumeArgs 与平台 args 分离，仍执行并替换 prompt', async () => {
    const { script, outFile } = stubAgent();
    const internalArgs = [script, outFile, '--resume', 'sess_123', '{{prompt}}'];
    expect(
      await runAndRead([], 'second turn words', outFile, {
        internalArgs,
        permissionPolicy: 'allow-full',
        permissionMode: 'default',
      }),
    ).toEqual(['--resume', 'sess_123', 'second turn words']);
  });

  it('请求自带 args 但没有占位 → 原样传递（不破坏平台自定义参数）', async () => {
    const { script, outFile } = stubAgent();
    const args = [script, outFile, '--verbose', 'literal prompt'];
    expect(await runAndRead(args, 'ignored', outFile)).toEqual(['--verbose', 'literal prompt']);
  });
});

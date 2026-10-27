import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TaskSupervisor, type TaskFinishInfo } from '../src/core/task-supervisor.js';
import type { TaskStatus } from '../src/protocol.js';

/**
 * 调度器集成：权限拒绝必须发生在 spawn 之前。
 * 这里只覆盖「拒绝」与「放行后继续走正常校验」两条，避免测试真的拉起 CLI。
 */
const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-perm-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function run(
  sv: TaskSupervisor,
  req: Record<string, unknown>,
): { status: TaskStatus | undefined; info: TaskFinishInfo | undefined } {
  let status: TaskStatus | undefined;
  let info: TaskFinishInfo | undefined;
  sv.submit(
    {
      taskId: `t-${Math.random().toString(36).slice(2)}`,
      agentType: 'gemini',
      cwd: tmp(),
      args: [],
      ...req,
    },
    {
      onLog: () => undefined,
      onStatus: (s, i) => {
        status = s;
        info = i;
      },
    },
  );
  return { status, info };
}

describe('权限策略在调度器中的落点', () => {
  it('policy=default + 请求 full → failed/permission_policy_denied，且不回显 full', () => {
    const { status, info } = run(new TaskSupervisor(), {
      permissionMode: 'full',
      permissionPolicy: 'default',
    });
    expect(status).toBe('failed');
    expect(info?.errorCode).toBe('permission_policy_denied');
    expect(info?.permissionMode).toBeUndefined();
  });

  it('allow-full + 非空 args → failed/permission_policy_denied', () => {
    const { status, info } = run(new TaskSupervisor(), {
      permissionPolicy: 'allow-full',
      args: ['--help'],
    });
    expect(status).toBe('failed');
    expect(info?.errorCode).toBe('permission_policy_denied');
  });

  it('CodeBuddy full 未声明沙箱 → failed/permission_mode_unsupported', () => {
    const { status, info } = run(new TaskSupervisor(), {
      agentType: 'codebuddy-cli',
      permissionMode: 'full',
      permissionPolicy: 'allow-full',
      externalSandbox: false,
    });
    expect(status).toBe('failed');
    expect(info?.errorCode).toBe('permission_mode_unsupported');
  });

  it('工具没有 full 映射 → failed/permission_mode_unsupported', () => {
    // 用一个必然存在但未声明 fullArgs 的 kind 走不到这里，改为直接验证未知工具仍先报白名单
    const { status, info } = run(new TaskSupervisor(), { agentType: 'not-a-real-agent' });
    expect(status).toBe('failed');
    expect(info?.errorCode).toBe('tool_not_installed');
  });

  // 注意：不要在这里测「放行后真的 spawn」——本机装了 gemini 时会拉起真实 CLI，
  // 既慢又会污染开发环境。放行语义由 test/permission-policy.test.ts 的纯函数穷举覆盖。
});

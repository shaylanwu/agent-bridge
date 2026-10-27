import { describe, expect, it } from 'vitest';
import { decidePermissionMode, permissionEnvFor } from '../src/core/permission-policy.js';

/**
 * 权限策略矩阵（design.md §6.1）。
 * 这里穷举是因为「静默降级」是这块最危险的失败模式：请求 full 却按 default 跑，
 * 平台会以为拿到了完全权限，实际每一步都在等审批。
 */
describe('决定权限模式：策略矩阵', () => {
  const base = { args: [] as string[], fullArgs: ['--yolo'] as string[], kind: 'gemini', externalSandbox: false };

  it('policy=default + 未指定 → default', () => {
    expect(decidePermissionMode({ ...base, policy: 'default' })).toEqual({ ok: true, mode: 'default' });
  });

  it('policy=default + 请求 default → default', () => {
    expect(decidePermissionMode({ ...base, policy: 'default', requested: 'default' })).toEqual({
      ok: true,
      mode: 'default',
    });
  });

  it('policy=default + 请求 full → 拒绝（不降级）', () => {
    const decision = decidePermissionMode({ ...base, policy: 'default', requested: 'full' });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe('permission_policy_denied');
  });

  it('policy=allow-full + 未指定 → default（只有显式请求才放开）', () => {
    expect(decidePermissionMode({ ...base, policy: 'allow-full' })).toEqual({ ok: true, mode: 'default' });
  });

  it('policy=allow-full + 请求 full → full', () => {
    expect(decidePermissionMode({ ...base, policy: 'allow-full', requested: 'full' })).toEqual({
      ok: true,
      mode: 'full',
    });
  });

  it('policy=full + 未指定 → full（有意提升旧平台任务）', () => {
    expect(decidePermissionMode({ ...base, policy: 'full' })).toEqual({ ok: true, mode: 'full' });
  });

  it('policy=full + 请求 default → default（可降级）', () => {
    expect(decidePermissionMode({ ...base, policy: 'full', requested: 'default' })).toEqual({
      ok: true,
      mode: 'default',
    });
  });

  it('policy 缺省等同 default', () => {
    const decision = decidePermissionMode({ ...base, requested: 'full' });
    expect(decision.ok).toBe(false);
  });
});

describe('受管参数模式', () => {
  const base = { fullArgs: ['--yolo'] as string[], kind: 'gemini' };

  it('allow-full 下非空 args 被拒（不因参数看似普通而放行）', () => {
    const decision = decidePermissionMode({ ...base, policy: 'allow-full', args: ['--help'] });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe('permission_policy_denied');
  });

  it('full 下非空 args 被拒', () => {
    const decision = decidePermissionMode({ ...base, policy: 'full', args: ['x'] });
    expect(decision.ok).toBe(false);
  });

  it('default 策略保留 legacy args 行为（不拦）', () => {
    expect(decidePermissionMode({ ...base, policy: 'default', args: ['-p', 'hi'] })).toEqual({
      ok: true,
      mode: 'default',
    });
  });
});

describe('full 准入', () => {
  it('没有 full 映射的工具 → permission_mode_unsupported', () => {
    const decision = decidePermissionMode({
      policy: 'allow-full',
      requested: 'full',
      args: [],
      fullArgs: undefined,
      kind: 'some-cli',
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe('permission_mode_unsupported');
  });

  it('空数组是合法映射（Kimi 明确不追加参数）', () => {
    expect(
      decidePermissionMode({ policy: 'allow-full', requested: 'full', args: [], fullArgs: [], kind: 'kimi-code' }),
    ).toEqual({ ok: true, mode: 'full' });
  });

  it('CodeBuddy full 未声明 external_sandbox → 拒绝', () => {
    const decision = decidePermissionMode({
      policy: 'allow-full',
      requested: 'full',
      args: [],
      fullArgs: ['-y'],
      kind: 'codebuddy-cli',
      externalSandbox: false,
    });
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.code).toBe('permission_mode_unsupported');
  });

  it('CodeBuddy full + external_sandbox=true → 放行', () => {
    expect(
      decidePermissionMode({
        policy: 'allow-full',
        requested: 'full',
        args: [],
        fullArgs: ['-y'],
        kind: 'codebuddy-cli',
        externalSandbox: true,
      }),
    ).toEqual({ ok: true, mode: 'full' });
  });

  it('其他工具的 full 不受 external_sandbox 影响', () => {
    expect(
      decidePermissionMode({
        policy: 'allow-full',
        requested: 'full',
        args: [],
        fullArgs: ['--yolo'],
        kind: 'gemini',
        externalSandbox: false,
      }),
    ).toEqual({ ok: true, mode: 'full' });
  });
});

describe('固定注入的环境变量', () => {
  it('CodeBuddy full 注入 CODEBUDDY_IS_SANDBOX=1', () => {
    expect(permissionEnvFor('codebuddy-cli', 'full')).toEqual({ CODEBUDDY_IS_SANDBOX: '1' });
  });

  it('default 模式不注入任何变量', () => {
    expect(permissionEnvFor('codebuddy-cli', 'default')).toBeUndefined();
  });

  it('其他工具 full 也不注入', () => {
    expect(permissionEnvFor('gemini', 'full')).toBeUndefined();
  });
});

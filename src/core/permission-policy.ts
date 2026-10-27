/**
 * 权限策略决策（1.0 Phase 2）—— 纯函数，不碰文件系统、不 spawn。
 *
 * 为什么单独抽出来：这是「平台请求的权限」与「本机允许的权限」交汇处，最容易写出
 * 静默降级（请求 full 却偷偷按 default 跑）。放在 core 里做成纯函数，单测可以直接穷举矩阵。
 *
 * 口径（见 openspec/changes/add-task-execution-control/design.md §6.1）：
 * | permission_policy | 未指定 | 请求 default | 请求 full |
 * | default           | default| default      | 拒绝      |
 * | allow-full        | default| default      | 满足条件则 full |
 * | full              | full   | default      | 满足条件则 full |
 *
 * ⚠️ full 只是 bridge 选择用哪套 argv，**不是** OS 提权、配置隔离或环境沙箱的证明。
 */

import type { PermissionMode } from '../protocol.js';

/** 本机策略；与 `src/infra/config.ts` 的 PermissionPolicy 同源（此处避免反向依赖） */
export type PermissionPolicyName = 'default' | 'allow-full' | 'full';

export type PermissionDenyCode = 'permission_mode_unsupported' | 'permission_policy_denied';

export interface PermissionDecisionInput {
  /** 本机策略（缺省 default） */
  policy?: PermissionPolicyName;
  /** 平台显式请求的模式；缺省表示「未指定」，由策略决定 */
  requested?: PermissionMode;
  /** 平台下发的 args（受管参数模式下必须为空） */
  args: readonly string[];
  /** 适配器声明的 full 追加参数；`undefined` = 该工具没有已验证的 full 入口 */
  fullArgs?: readonly string[];
  /** 适配器 kind（CodeBuddy 需要外部沙箱声明） */
  kind: string;
  /** 本机是否声明运行在外部沙箱内 */
  externalSandbox?: boolean;
}

export type PermissionDecision =
  | { ok: true; mode: PermissionMode }
  | { ok: false; code: PermissionDenyCode; message: string };

/** 只有 CodeBuddy 的 full 需要外部沙箱声明（唯一固定 env 例外） */
const SANDBOX_REQUIRED_KINDS = new Set(['codebuddy-cli']);

/**
 * 该工具在当前机器条件下**是否有资格**按 full 运行（不看本机策略）。
 * 与 decidePermissionMode 的第 4/5 步共用同一判据 —— 上报的 executionModes 必须和实际准入一致，
 * 否则平台会看到一个声明了 full 却必然被拒的工具。
 */
export function fullModeAdmitted(input: {
  kind: string;
  fullArgs?: readonly string[];
  externalSandbox?: boolean;
}): boolean {
  if (input.fullArgs === undefined) return false;
  if (SANDBOX_REQUIRED_KINDS.has(input.kind) && input.externalSandbox !== true) return false;
  return true;
}

export function decidePermissionMode(input: PermissionDecisionInput): PermissionDecision {
  const policy = input.policy ?? 'default';
  const requested = input.requested;

  // 1) 本机策略不放行时直接拒绝 —— 不允许以 default 代替执行（不静默降级）
  if (requested === 'full' && policy === 'default') {
    return {
      ok: false,
      code: 'permission_policy_denied',
      message: `本机 permission_policy 为 default，不允许请求 full 权限`,
    };
  }

  // 2) 受管参数模式：allow-full / full 下 argv 必须完全由 bridge 决定
  if (policy !== 'default' && input.args.length > 0) {
    return {
      ok: false,
      code: 'permission_policy_denied',
      message: `本机 permission_policy 为 ${policy}，任务只能使用适配器默认参数（args 必须为空）`,
    };
  }

  // 3) 计算本次生效模式：未指定时 full 策略才默认 full
  const mode: PermissionMode =
    requested === 'full' ? 'full' : requested === 'default' ? 'default' : policy === 'full' ? 'full' : 'default';

  if (mode === 'default') return { ok: true, mode };

  // 4) full 准入：工具必须有已验证的映射（CodeBuddy 还需外部沙箱声明）
  if (!fullModeAdmitted({ kind: input.kind, fullArgs: input.fullArgs, externalSandbox: input.externalSandbox })) {
    const needsSandbox = SANDBOX_REQUIRED_KINDS.has(input.kind) && input.externalSandbox !== true;
    return {
      ok: false,
      code: 'permission_mode_unsupported',
      message: needsSandbox
        ? `${input.kind} 的 full 模式需要本机声明 external_sandbox = true`
        : `${input.kind} 没有已验证的 full 权限映射，无法按 full 执行`,
    };
  }

  return { ok: true, mode };
}

/** full 模式下需要固定注入的环境变量（目前只有 CodeBuddy 一例） */
export function permissionEnvFor(kind: string, mode: PermissionMode): Record<string, string> | undefined {
  if (mode !== 'full') return undefined;
  return kind === 'codebuddy-cli' ? { CODEBUDDY_IS_SANDBOX: '1' } : undefined;
}

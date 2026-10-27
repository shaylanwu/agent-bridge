/**
 * 1.0 执行侧契约：executionModes / 事件缺口 / stopReason 收敛 / get_artifact 帧校验。
 *
 * 这几项的共同风险是「文档说有、实际不可用」：
 * 平台照着 executionModes 请求 full，bridge 却必然拒绝；或快照缺号却不声明。
 * 所以断言的是**代码事实**，不是文案。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENTS, agentCanContinue, canContinue, executionModesFor } from '../src/adapters/agent-adapters.js';
import { SessionStore } from '../src/core/session-store.js';
import { knownStopReason } from '../src/core/task-supervisor.js';
import { assertServerMessage, ProtocolError } from '../src/protocol.js';
import type { ContinuationKind, ExecutionModeCapability } from '../src/protocol.js';

const stores: SessionStore[] = [];
const dirs: string[] = [];

function open(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-exec-'));
  dirs.push(dir);
  const store = new SessionStore(join(dir, 'state.db'));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('executionModes', () => {
  it('12 个适配器都声明 headless 能力', () => {
    expect(AGENTS).toHaveLength(12);
    for (const def of AGENTS) {
      const modes = executionModesFor(def);
      expect(modes[0].mode).toBe('headless');
      expect(modes[0].permissionModes).toContain('default');
    }
  });

  it('有 ACP 入口的工具额外声明 acp-stdio，且只支持 default + 原生交互', () => {
    const acpAgents = AGENTS.filter((def) => def.acp);
    expect(acpAgents.length).toBeGreaterThan(0);
    for (const def of acpAgents) {
      const acp = executionModesFor(def).find((mode) => mode.mode === 'acp-stdio');
      expect(acp).toBeDefined();
      // ACP 走原生 permission 交互，不给「跳过审批」的 full
      expect(acp?.permissionModes).toEqual(['default']);
      // 逐工具如实声明：缺省 permission+form，dsh 实测 automation-only 故为空
      expect(acp?.interactionKinds).toEqual(def.acpInteractionKinds ?? ['permission', 'form']);
    }
  });

  it('dsh 的 ACP 声明为零交互种类（实测从不回问权限，声明了平台就会干等）', () => {
    const def = AGENTS.find((agent) => agent.kind === 'ds-harness');
    expect(def?.acp).toEqual({ command: 'dsh', args: ['--profile', 'acp'] });
    const acp = executionModesFor(def!).find((mode) => mode.mode === 'acp-stdio');
    expect(acp?.interactionKinds).toEqual([]);
  });

  it('CodeBuddy 未声明 external_sandbox 时不声明 full，声明后才声明', () => {
    const def = AGENTS.find((agent) => agent.kind === 'codebuddy-cli');
    expect(def).toBeDefined();
    const without = executionModesFor(def!, false)[0];
    const withSandbox = executionModesFor(def!, true)[0];
    expect(without.permissionModes).toEqual(['default']);
    expect(withSandbox.permissionModes).toEqual(['default', 'full']);
  });

  it('feedKinds 只在真有步骤解析器时含 steps（不虚报）', () => {
    for (const def of AGENTS) {
      const headless = executionModesFor(def)[0];
      expect(headless.feedKinds.includes('steps')).toBe(def.steps !== undefined);
      expect(headless.feedKinds).toContain('messages');
    }
  });

  it('每个模式都声明 continuation，且 12/12 至少到 replay-session 底线', () => {
    const allowed: ContinuationKind[] = ['native-session', 'resume-session', 'replay-session', 'single-turn'];
    for (const def of AGENTS) {
      for (const mode of executionModesFor(def)) {
        expect(allowed).toContain(mode.continuation);
        // single-turn 只有在 CLI 物理上接不了后续 prompt 时才允许声明，目前一个都没有
        expect(mode.continuation).not.toBe('single-turn');
      }
    }
  });

  it('headless 的续接方式与 resumeArgs 一一对应', () => {
    for (const def of AGENTS) {
      const headless = executionModesFor(def)[0];
      // 有原生续接参数 → 接上同一个会话；没有 → 把完整 transcript 当 prompt 重放
      expect(headless.continuation).toBe(def.resumeArgs ? 'resume-session' : 'replay-session');
    }
    expect(AGENTS.filter((def) => def.resumeArgs).map((def) => def.kind).sort()).toEqual([
      'claude-code',
      'codebuddy-cli',
      'ds-harness',
      'qoder-cli',
    ]);
  });

  it('ACP 模式一律 native-session（会话在 agent 侧，bridge 只回传 ID）', () => {
    for (const def of AGENTS.filter((agent) => agent.acp)) {
      const acp = executionModesFor(def).find((mode) => mode.mode === 'acp-stdio');
      expect(acp?.continuation).toBe('native-session');
    }
  });

  it('canContinue：任一模式可续即可续，全 single-turn 才算不可续', () => {
    const cap = (continuation: ContinuationKind): ExecutionModeCapability => ({
      mode: 'headless',
      permissionModes: ['default'],
      interactionKinds: [],
      feedKinds: ['messages'],
      continuation,
    });
    expect(canContinue([cap('replay-session')])).toBe(true);
    expect(canContinue([cap('native-session')])).toBe(true);
    expect(canContinue([cap('single-turn')])).toBe(false);
    // headless 单轮但 ACP 能续 —— 平台只给 agentType，取任一模式可续才是如实回答
    expect(canContinue([cap('single-turn'), cap('native-session')])).toBe(true);
    expect(canContinue([])).toBe(false);
  });

  it('agentCanContinue：真实工具都可续，未知工具返回 false 交给调用方单独报错', () => {
    for (const def of AGENTS) expect(agentCanContinue(def.kind)).toBe(true);
    expect(agentCanContinue('no-such-tool')).toBe(false);
  });
});

describe('eventGaps', () => {
  it('序号连续时 gaps 为空', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_gap_a', mode: 'task', agentType: 'codex', cwd: '/tmp/work' });
    store.appendEvent({ sessionId: 'bt_gap_a', type: 'task_status', payload: { n: 1 } });
    store.appendEvent({ sessionId: 'bt_gap_a', type: 'task_status', payload: { n: 2 } });
    expect(store.eventGaps('bt_gap_a')).toEqual([]);
  });

  it('序号有缺口时如实报告区间', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_gap_b', mode: 'task', agentType: 'codex', cwd: '/tmp/work' });
    store.appendEvent({ sessionId: 'bt_gap_b', type: 'task_status', payload: { n: 1 } });
    store.appendEvent({ sessionId: 'bt_gap_b', type: 'task_status', payload: { n: 2 } });
    store.appendEvent({ sessionId: 'bt_gap_b', type: 'task_status', payload: { n: 3 } });
    // 模拟 retention 删掉中间一条：直接删 DB 行，制造真实缺口
    const raw = store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } };
    raw.db.prepare('DELETE FROM events WHERE session_id = ? AND event_seq = 2').run('bt_gap_b');
    expect(store.eventGaps('bt_gap_b')).toEqual([{ from: 2, to: 2 }]);
  });
});

describe('stopReason 收敛', () => {
  it('只认受控枚举，其他值一律丢弃（不写进受限字段）', () => {
    for (const ok of ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled']) {
      expect(knownStopReason(ok)).toBe(ok);
    }
    expect(knownStopReason('unknown')).toBeUndefined();
    expect(knownStopReason(undefined)).toBeUndefined();
    expect(knownStopReason(42)).toBeUndefined();
  });
});

describe('get_artifact 帧校验', () => {
  it('缺 artifactId 直接拒帧', () => {
    expect(() => assertServerMessage({ type: 'get_artifact', taskId: 'bt_1' })).toThrow(ProtocolError);
  });

  it('正常帧透传 requestId 与服务身份字段', () => {
    const msg = assertServerMessage({
      type: 'get_artifact',
      taskId: 'bt_1',
      artifactId: 'art_1',
      requestId: 'req_1',
      requestedBy: 'svc:test',
      purpose: 'repair',
    });
    expect(msg).toMatchObject({
      type: 'get_artifact',
      taskId: 'bt_1',
      artifactId: 'art_1',
      requestId: 'req_1',
      requestedBy: 'svc:test',
    });
  });
});

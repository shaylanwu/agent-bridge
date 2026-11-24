/**
 * A2A 映射层（tasks 1.1 / 1.2 / 1.4）—— 纯函数，测「翻译表」本身：
 * 状态映射、版本协商（两套拼写家族）、消息/附件映射、task_log 只作调试扩展。
 */

import { describe, expect, it } from 'vitest';
import {
  A2A_STYLE_V03,
  A2A_STYLE_V1,
  isA2aTerminalState,
  negotiateA2aVersion,
  toA2aMessageFromEvent,
  toA2aTask,
  toA2aTaskState,
  toA2aArtifact,
} from '../src/transport/a2a-mapping.js';
import type { ArtifactRecord, SessionEvent, SessionRecord } from '../src/core/session-store.js';

const ev = (eventSeq: number, type: string, payload: Record<string, unknown>): SessionEvent => ({
  eventSeq,
  type,
  payload,
  createdAt: '2026-11-18T12:00:00.000Z',
});

describe('TaskStatus ↔ A2A TaskState（task 1.1）', () => {
  it('全分支映射表', () => {
    expect(toA2aTaskState('success')).toBe('TASK_STATE_COMPLETED');
    expect(toA2aTaskState('failed')).toBe('TASK_STATE_FAILED');
    // A2A 没有超时态：归 FAILED，真实原因放 metadata
    expect(toA2aTaskState('timeout')).toBe('TASK_STATE_FAILED');
    expect(toA2aTaskState('cancelled')).toBe('TASK_STATE_CANCELED');
    expect(toA2aTaskState('running', 'queued')).toBe('TASK_STATE_SUBMITTED');
    expect(toA2aTaskState('running', 'running')).toBe('TASK_STATE_WORKING');
    expect(toA2aTaskState('running', 'waiting_interaction')).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(toA2aTaskState('running', 'waiting_user')).toBe('TASK_STATE_INPUT_REQUIRED');
    expect(toA2aTaskState('running')).toBe('TASK_STATE_WORKING');
  });

  it('终态判定：四个 A2A 终态', () => {
    expect(isA2aTerminalState('TASK_STATE_COMPLETED')).toBe(true);
    expect(isA2aTerminalState('TASK_STATE_FAILED')).toBe(true);
    expect(isA2aTerminalState('TASK_STATE_CANCELED')).toBe(true);
    expect(isA2aTerminalState('TASK_STATE_REJECTED')).toBe(true);
    expect(isA2aTerminalState('TASK_STATE_WORKING')).toBe(false);
    expect(isA2aTerminalState('TASK_STATE_INPUT_REQUIRED')).toBe(false);
    expect(isA2aTerminalState('TASK_STATE_SUBMITTED')).toBe(false);
  });
});

describe('A2A-Version 协商', () => {
  it('空/缺省按 0.3（规范规定）', () => {
    expect(negotiateA2aVersion(undefined)).toBe('0.3');
    expect(negotiateA2aVersion('')).toBe('0.3');
    expect(negotiateA2aVersion('   ')).toBe('0.3');
  });
  it('1.0 家族（patch 不参与）', () => {
    expect(negotiateA2aVersion('1.0')).toBe('1.0');
    expect(negotiateA2aVersion('1.0.1')).toBe('1.0');
  });
  it('其它版本不支持（不猜语义）', () => {
    expect(negotiateA2aVersion('2.0')).toBe('unsupported');
    expect(negotiateA2aVersion('0.2')).toBe('unsupported');
    expect(negotiateA2aVersion('abc')).toBe('unsupported');
  });
});

describe('两套拼写家族（style）', () => {
  it('v1.0：TASK_STATE_* + kind 判别 + ROLE_*', () => {
    expect(A2A_STYLE_V1.state('TASK_STATE_WORKING')).toBe('TASK_STATE_WORKING');
    expect(A2A_STYLE_V1.taskKindDiscriminator).toBe(false);
    expect(A2A_STYLE_V1.partDiscriminator).toBe('kind');
    expect(A2A_STYLE_V1.role('user')).toBe('ROLE_USER');
    expect(A2A_STYLE_V1.role('agent')).toBe('ROLE_AGENT');
  });
  it('0.3：连字符小写 + type 判别 + 小写 role', () => {
    expect(A2A_STYLE_V03.state('TASK_STATE_WORKING')).toBe('working');
    expect(A2A_STYLE_V03.state('TASK_STATE_INPUT_REQUIRED')).toBe('input-required');
    expect(A2A_STYLE_V03.state('TASK_STATE_CANCELED')).toBe('canceled');
    // 0.3 没有稳定 auth-required 拼写：不编造规范值
    expect(A2A_STYLE_V03.state('TASK_STATE_AUTH_REQUIRED')).toBe('unknown');
    expect(A2A_STYLE_V03.taskKindDiscriminator).toBe(true);
    expect(A2A_STYLE_V03.partDiscriminator).toBe('type');
    expect(A2A_STYLE_V03.role('user')).toBe('user');
  });
});

describe('task_message → A2A Message（task 1.2）', () => {
  it('complete 消息映射为 Message', () => {
    const m = toA2aMessageFromEvent(
      'bt_x',
      ev(3, 'task_message', { messageId: 'm1', role: 'agent', state: 'complete', text: 'hi' }),
      A2A_STYLE_V1,
    );
    expect(m).toMatchObject({
      role: 'ROLE_AGENT',
      messageId: 'm1',
      taskId: 'bt_x',
      parts: [{ kind: 'text', text: 'hi' }],
    });
  });
  it('delta 是流式增量，不进快照消息', () => {
    expect(
      toA2aMessageFromEvent(
        'bt_x',
        ev(3, 'task_message', { messageId: 'm1', role: 'agent', state: 'delta', text: 'hi' }),
        A2A_STYLE_V1,
      ),
    ).toBeUndefined();
  });
  it('system role 归 agent 侧（A2A 只有两方）', () => {
    const m = toA2aMessageFromEvent(
      'bt_x',
      ev(3, 'task_message', { messageId: 'm1', role: 'system', state: 'complete', text: 'err' }),
      A2A_STYLE_V1,
    );
    expect(m?.role).toBe('ROLE_AGENT');
  });
  it('非 task_message 事件不映射', () => {
    expect(toA2aMessageFromEvent('bt_x', ev(3, 'task_status', { status: 'running' }), A2A_STYLE_V1)).toBeUndefined();
  });
});

describe('task_artifact → A2A Artifact（task 1.2）', () => {
  const artifact: ArtifactRecord = {
    tenantId: 'default',
    artifactId: 'ar_1',
    sessionId: 'bt_x',
    name: 'report.md',
    mimeType: 'text/markdown',
    size: 42,
    sha256: 'abc123',
    kind: 'file',
    storageKey: 'default/bt_x/ar_1',
    createdAt: '2026-11-18T12:00:00.000Z',
  };
  it('file part 指向控制面下载端点，sha256/size 在 metadata', () => {
    const a = toA2aArtifact(artifact, A2A_STYLE_V1, 'http://127.0.0.1:8787/v1/sessions/bt_x/artifacts/ar_1');
    expect(a.artifactId).toBe('ar_1');
    expect(a.name).toBe('report.md');
    expect(a.parts[0]).toMatchObject({ kind: 'file', file: { uri: 'http://127.0.0.1:8787/v1/sessions/bt_x/artifacts/ar_1', mimeType: 'text/markdown' } });
    expect(a.metadata).toMatchObject({ size: 42, sha256: 'abc123', kind: 'file' });
  });
});

describe('SessionSnapshot → A2A Task（tasks 1.2 / 1.4）', () => {
  const session: SessionRecord = {
    tenantId: 'default',
    sessionId: 'bt_x',
    contextId: 'ctx_1',
    mode: 'task',
    status: 'success',
    phase: 'settled',
    agentType: 'claude-code',
    cwd: 'C:/work',
    createdAt: '2026-11-18T11:00:00.000Z',
    updatedAt: '2026-11-18T12:00:00.000Z',
  };
  const events: SessionEvent[] = [
    ev(1, 'task_status', { status: 'running' }),
    ev(2, 'task_message', { messageId: 'm1', role: 'agent', state: 'complete', text: 'done' }),
    ev(3, 'task_message', { messageId: 'm2', role: 'agent', state: 'delta', text: 'partial' }),
    ev(4, 'task_log', { stream: 'stdout', data: 'raw log line' }),
  ];

  it('history 只收 complete 消息；task_log 不冒充消息/附件（task 1.4）', () => {
    const task = toA2aTask({ session, events, artifacts: [], style: A2A_STYLE_V1, baseUrl: 'http://127.0.0.1:8787' });
    expect(task.history).toHaveLength(1);
    expect(task.history?.[0]?.messageId).toBe('m1');
    expect(task.artifacts).toBeUndefined();
    // task_log 只在 metadata 里给调试指引
    expect((task.metadata?.['bridge'] as Record<string, unknown>)['taskLogEndpoint']).toBe(
      'http://127.0.0.1:8787/v1/tasks/bt_x/events',
    );
  });

  it('0.3 拼写：state 连字符 + kind 判别字段', () => {
    const task = toA2aTask({ session, events, artifacts: [], style: A2A_STYLE_V03, baseUrl: 'http://127.0.0.1:8787' });
    expect(task.status.state).toBe('completed');
    expect(task.kind).toBe('task');
    expect(task.history?.[0]?.role).toBe('agent');
  });

  it('v1.0 拼写：TASK_STATE_*，无 kind 判别字段', () => {
    const task = toA2aTask({ session, events, artifacts: [], style: A2A_STYLE_V1, baseUrl: 'http://127.0.0.1:8787' });
    expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    expect(task.kind).toBeUndefined();
  });

  it('timeout 归 FAILED 且 metadata 带真实归因（平台不用猜）', () => {
    const t8: SessionRecord = { ...session, status: 'timeout' };
    const task = toA2aTask({ session: t8, events, artifacts: [], style: A2A_STYLE_V1, baseUrl: 'http://127.0.0.1:8787' });
    expect(task.status.state).toBe('TASK_STATE_FAILED');
    expect((task.metadata?.['bridge'] as Record<string, unknown>)['statusDetail']).toBe('bridge:timeout');
  });
});

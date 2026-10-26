import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, SessionStoreError } from '../src/core/session-store.js';

const stores: SessionStore[] = [];
const dirs: string[] = [];

function open(): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-session-'));
  dirs.push(dir);
  const store = new SessionStore(join(dir, 'state.db'));
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('创建会话并持久化稳定 contextId', () => {
    const store = open();
    const created = store.createSession({
      sessionId: 'bt_1',
      mode: 'conversation',
      agentType: 'codex',
      cwd: '/tmp/work',
    });

    expect(created.created).toBe(true);
    expect(created.session.contextId).toMatch(/^[0-9a-f-]{36}$/);
    const again = store.createSession({
      sessionId: 'bt_1',
      mode: 'conversation',
      agentType: 'codex',
      cwd: '/tmp/work',
    });
    expect(again.created).toBe(false);
    expect(again.session.contextId).toBe(created.session.contextId);
  });

  it('持久化 native session id，供 resume/展示', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_native', mode: 'conversation', agentType: 'codex', cwd: '/tmp/work' });
    store.updateSession('bt_native', { nativeSessionId: 'sess_abc123' });
    expect(store.getSession('bt_native')?.nativeSessionId).toBe('sess_abc123');
    expect(store.snapshot('bt_native').session.nativeSessionId).toBe('sess_abc123');
  });

  it('form 交互可持久化、提交、幂等响应并拒绝二次响应', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_form', mode: 'conversation', agentType: 'claude-code', cwd: '/tmp/work' });
    const turn = store.createTurn({ sessionId: 'bt_form', status: 'running' });
    const request = store.requestInteraction({
      sessionId: 'bt_form',
      requestId: 'ir_form_1',
      turnId: turn.turnId,
      kind: 'form',
      payload: {
        title: 'Deploy target',
        schema: { type: 'object', properties: { env: { type: 'string' } }, required: ['env'] },
      },
    });
    expect(request).toMatchObject({ kind: 'form', state: 'pending' });

    const submitted = store.resolveInteraction({
      sessionId: 'bt_form',
      requestId: 'ir_form_1',
      state: 'submitted',
      responseId: 'resp_1',
      resultSeq: 1,
      resultPayload: { env: 'staging' },
    });
    expect(submitted).toMatchObject({
      state: 'submitted',
      responseId: 'resp_1',
      resultSeq: 1,
      resultPayload: { env: 'staging' },
    });
    expect(
      store.resolveInteraction({
        sessionId: 'bt_form',
        requestId: 'ir_form_1',
        state: 'submitted',
        responseId: 'resp_1',
        resultSeq: 1,
        resultPayload: { env: 'staging' },
      }),
    ).toMatchObject({ state: 'submitted', responseId: 'resp_1' });
    expect(() =>
      store.resolveInteraction({
        sessionId: 'bt_form',
        requestId: 'ir_form_1',
        state: 'resolved',
        responseId: 'resp_2',
        resultSeq: 2,
      }),
    ).toThrow(SessionStoreError);
  });

  it('auth-url 交互拒绝把完整 URL 写进 SQLite', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_auth', mode: 'conversation', agentType: 'codex', cwd: '/tmp/work' });
    expect(() =>
      store.requestInteraction({
        sessionId: 'bt_auth',
        requestId: 'ir_auth_1',
        kind: 'auth-url',
        payload: { url: 'https://example.test/auth?token=secret' },
      }),
    ).toThrow(/InteractionUrlVault/);
    expect(
      store.requestInteraction({
        sessionId: 'bt_auth',
        requestId: 'ir_auth_2',
        kind: 'auth-url',
        payload: { provider: 'example', hint: 'open the browser' },
      }).kind,
    ).toBe('auth-url');
  });

  it('eventSeq 单调递增且重复事件幂等', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_2', mode: 'task', agentType: 'codex', cwd: '/tmp/work' });
    const first = store.appendEvent({ sessionId: 'bt_2', type: 'task_status', payload: { phase: 'running' } });
    const second = store.appendEvent({ sessionId: 'bt_2', type: 'task_message', payload: { text: 'hi' } });

    expect(first.eventSeq).toBe(1);
    expect(second.eventSeq).toBe(2);
    expect(
      store.appendEvent({ sessionId: 'bt_2', type: 'task_status', payload: { phase: 'running' }, eventSeq: 1 }),
    ).toEqual(first);
  });

  it('同一 eventSeq 内容不同时拒绝覆盖', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_3', mode: 'task', agentType: 'codex', cwd: '/tmp/work' });
    store.appendEvent({ sessionId: 'bt_3', type: 'task_status', payload: { phase: 'running' } });

    expect(() =>
      store.appendEvent({ sessionId: 'bt_3', type: 'task_status', payload: { phase: 'waiting_user' }, eventSeq: 1 }),
    ).toThrowError(SessionStoreError);
  });

  it('Turn 顺序、交互与 artifact 可恢复', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_4', mode: 'conversation', agentType: 'codex', cwd: '/tmp/work' });
    const t1 = store.createTurn({ sessionId: 'bt_4' });
    const t2 = store.createTurn({ sessionId: 'bt_4' });
    expect([t1.ordinal, t2.ordinal]).toEqual([1, 2]);

    store.requestInteraction({
      sessionId: 'bt_4',
      requestId: 'ir_1',
      turnId: t1.turnId,
      kind: 'permission',
      payload: { title: 'write file' },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const resolved = store.resolveInteraction({
      sessionId: 'bt_4',
      requestId: 'ir_1',
      state: 'accepted',
      responseId: 'resp_1',
      resultSeq: 1,
      resultPayload: { ok: true },
    });
    expect(resolved.state).toBe('accepted');
    expect(resolved.responseId).toBe('resp_1');

    store.putArtifact({
      tenantId: 'default',
      artifactId: 'art_1',
      sessionId: 'bt_4',
      name: 'a.txt',
      mimeType: 'text/plain',
      size: 2,
      sha256: 'abc',
      kind: 'attachment',
      storageKey: 'artifacts/default/abc',
    });
    const snapshot = store.snapshot('bt_4');
    expect(snapshot.turns).toHaveLength(2);
    expect(snapshot.interactions[0]?.state).toBe('accepted');
    expect(snapshot.artifacts[0]?.artifactId).toBe('art_1');
  });

  it('关闭后写 tombstone，同 ID 不可复用', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_5', mode: 'task', agentType: 'codex', cwd: '/tmp/work' });
    store.closeSession('bt_5', 'success', 'done');

    expect(store.getTombstone('bt_5')?.reason).toBe('done');
    expect(() =>
      store.createSession({ sessionId: 'bt_5', mode: 'task', agentType: 'codex', cwd: '/tmp/work' }),
    ).toThrowError(SessionStoreError);
  });

  it('启动恢复把中断的 task 关闭、conversation 留 waiting_user', () => {
    const store = open();
    store.createSession({ sessionId: 'bt_task', mode: 'task', agentType: 'codex', cwd: '/tmp/work' });
    store.createTurn({ sessionId: 'bt_task', status: 'running' });
    store.createSession({ sessionId: 'bt_conv', mode: 'conversation', agentType: 'codex', cwd: '/tmp/work' });
    store.createTurn({ sessionId: 'bt_conv', status: 'running' });

    expect(store.recoverInterrupted()).toBe(2);
    expect(store.getSession('bt_task')).toMatchObject({ status: 'failed', phase: 'settled' });
    expect(store.getTombstone('bt_task')).toBeDefined();
    expect(store.getSession('bt_conv')).toMatchObject({ status: 'running', phase: 'waiting_user' });
    expect(store.listTurns('bt_conv')[0]?.status).toBe('failed');
  });

  it('重新打开数据库后历史仍在', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-session-'));
    dirs.push(dir);
    const path = join(dir, 'state.db');
    const first = new SessionStore(path);
    first.createSession({ sessionId: 'bt_6', mode: 'task', agentType: 'codex', cwd: '/tmp/work' });
    first.appendEvent({ sessionId: 'bt_6', type: 'task_message', payload: { text: 'persisted' } });
    first.close();

    const second = new SessionStore(path);
    stores.push(second);
    expect(second.getSession('bt_6')?.sessionId).toBe('bt_6');
    expect(second.listEvents('bt_6')).toHaveLength(1);
  });
});

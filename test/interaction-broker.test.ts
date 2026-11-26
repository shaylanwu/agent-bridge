import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Emitter } from '../src/core/emitter.js';
import { SessionStore } from '../src/core/session-store.js';
import { TaskSupervisor, type InteractionAnswer, type TaskFinishInfo, type TaskHandle } from '../src/core/task-supervisor.js';
import { agentDefOf } from '../src/adapters/agent-adapters.js';
import type { TaskStatus } from '../src/protocol.js';
import { toCloudEvent, type ClientMessage, type InteractionResponseCommand } from '../src/protocol.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function harness(deliver?: (taskId: string, requestId: string, answer?: InteractionAnswer) => Promise<boolean>) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-broker-'));
  const store = new SessionStore(join(dir, 'state.db'));
  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.createSession({ sessionId: 'sess_broker', mode: 'task', agentType: 'codebuddy-cli', cwd: dir });
  const sent: ClientMessage[] = [];
  const emitter = new Emitter({ sink: (msg) => sent.push(msg as ClientMessage) });
  const supervisor = new TaskSupervisor();
  const deliverMock = vi.fn(deliver ?? (async () => true));
  supervisor.interactions.bind({
    store,
    emit: (msg) => emitter.emit(msg),
    deliver: deliverMock,
  });
  return { store, supervisor, broker: supervisor.interactions, deliver: deliverMock, sent };
}

function openPermission(broker: ReturnType<typeof harness>['broker'], requestId = 'ir_one') {
  broker.open({
    sessionId: 'sess_broker',
    requestId,
    kind: 'permission',
    payload: {
      toolCall: { kind: 'execute', title: 'Run' },
      options: [
        { optionId: 'allow', kind: 'allow_once' },
        { optionId: 'deny', kind: 'reject_once' },
      ],
    },
  });
}

function response(responseId: string, optionId = 'allow'): InteractionResponseCommand {
  return {
    type: 'task_interaction_response',
    taskId: 'sess_broker',
    requestId: 'ir_one',
    responseId,
    state: 'accepted',
    payload: { optionId },
  };
}

describe('InteractionBroker occurrence 与独立 resultSeq', () => {
  it('invalid 可修正；同 responseId 重放原 occurrence；result 不占 eventSeq', async () => {
    const { broker, store, deliver, sent } = harness();
    openPermission(broker);
    const invalid = await broker.respond(response('rs_bad', 'not-offered'));
    expect(invalid).toMatchObject({ ok: false, errorCode: 'interaction_invalid_response', resultSeq: 1 });
    expect(store.getInteraction('sess_broker', 'ir_one')).toMatchObject({ state: 'pending' });
    expect(deliver).not.toHaveBeenCalled();

    const replay = await broker.respond(response('rs_bad', 'not-offered'));
    expect(replay).toMatchObject({ ok: false, resultSeq: 1 });
    const accepted = await broker.respond(response('rs_good'));
    expect(accepted).toMatchObject({ ok: true, state: 'accepted', resultSeq: 2 });
    expect(store.getInteraction('sess_broker', 'ir_one')).toMatchObject({ state: 'resolved' });
    expect(store.getLatestEvent('sess_broker', 'task_interaction_result')).toBeUndefined();
    const result = sent.find((msg) => msg.type === 'task_interaction_result');
    expect(result).toMatchObject({ requestState: 'pending', responseStatus: 'invalid', resultSeq: 1 });
    expect(result).not.toHaveProperty('eventSeq');
  });

  it('resolved 后相同答案 duplicate、不同答案 conflict，且各自产生新序号', async () => {
    const { broker, store, deliver } = harness();
    openPermission(broker);
    expect(await broker.respond(response('rs_one'))).toMatchObject({ ok: true, resultSeq: 1 });
    const duplicate = await broker.respond(response('rs_two'));
    expect(duplicate).toMatchObject({ ok: true, state: 'accepted', resultSeq: 2 });
    expect(duplicate.result).toMatchObject({ responseStatus: 'duplicate', requestState: 'resolved' });
    const conflict = await broker.respond(response('rs_three', 'deny'));
    expect(conflict).toMatchObject({ ok: false, errorCode: 'interaction_response_conflict', resultSeq: 3 });
    expect(conflict.result).toMatchObject({ responseStatus: 'invalid', requestState: 'resolved' });
    expect(await broker.respond(response('rs_three', 'deny'))).toMatchObject({ resultSeq: 3 });
    expect(store.listLatestInteractionResults('sess_broker')).toHaveLength(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await broker.respond(response('rs_one'))).toMatchObject({ resultSeq: 1 });
  });

  it('submitting 同 responseId 共享 flight；其他 responseId 只产生 duplicate/conflict', async () => {
    let release!: (delivered: boolean) => void;
    const { broker, deliver } = harness(async () => new Promise<boolean>((resolve) => { release = resolve; }));
    openPermission(broker);
    const first = broker.respond(response('rs_flight'));
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    const same = broker.respond(response('rs_flight'));
    const duplicate = await broker.respond(response('rs_duplicate'));
    expect(duplicate).toMatchObject({ ok: true, resultSeq: 1 });
    expect(duplicate.result).toMatchObject({ requestState: 'submitting', responseStatus: 'duplicate' });
    const conflict = await broker.respond(response('rs_conflict', 'deny'));
    expect(conflict).toMatchObject({ ok: false, errorCode: 'interaction_response_conflict', resultSeq: 2 });
    release(true);
    expect(await first).toMatchObject({ ok: true, resultSeq: 3 });
    expect(await same).toMatchObject({ ok: true, resultSeq: 3 });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('Form 指纹忽略对象键顺序，持久化与结果均不含 content 原文', async () => {
    const { broker, store, deliver } = harness();
    broker.open({
      sessionId: 'sess_broker',
      requestId: 'ir_form',
      kind: 'form',
      payload: { requestedSchema: { type: 'object' } },
    });
    const formResponse = (responseId: string, content: Record<string, unknown>): InteractionResponseCommand => ({
      type: 'task_interaction_response', taskId: 'sess_broker', requestId: 'ir_form', responseId,
      state: 'accepted', payload: { content },
    });
    expect(await broker.respond(formResponse('rs_form', { a: 1, b: 2 }))).toMatchObject({ ok: true });
    expect(await broker.respond(formResponse('rs_form_duplicate', { b: 2, a: 1 }))).toMatchObject({ ok: true });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(store.getInteraction('sess_broker', 'ir_form')?.resultPayload).toEqual({
      action: 'accept',
      fieldNames: ['a', 'b'],
    });
    const persisted = store.listLatestInteractionResults('sess_broker');
    expect(JSON.stringify(persisted)).not.toContain('content');
  });

  it('同一 request/result occurrence 的 CloudEvents source+id 在重放时稳定', async () => {
    const { broker, sent } = harness();
    openPermission(broker);
    const request = sent.find((msg) => msg.type === 'task_interaction_request');
    expect(request).toBeDefined();
    const requestEventA = toCloudEvent(request!, 'urn:agent-bridge:device:test', 1, new Date('2026-01-01T00:00:00Z'));
    const requestEventB = toCloudEvent(request!, 'urn:agent-bridge:device:test', 99, new Date('2026-01-02T00:00:00Z'));
    expect(requestEventA.id).toBe('interaction:sess_broker:ir_one');
    expect(requestEventB.id).toBe(requestEventA.id);

    const accepted = await broker.respond(response('rs_stable'));
    expect(accepted.result).toBeDefined();
    const resultA = toCloudEvent(accepted.result!, 'urn:agent-bridge:device:test', 2, new Date('2026-01-03T00:00:00Z'));
    const replay = await broker.respond(response('rs_stable'));
    const resultB = toCloudEvent(replay.result!, 'urn:agent-bridge:device:test', 100, new Date('2026-01-04T00:00:00Z'));
    expect(resultA.id).toBe('interaction-result:sess_broker:ir_one:1');
    expect(resultB.id).toBe(resultA.id);
    expect(resultB.time).toBe(resultA.time);
    expect(resultB.source).toBe(resultA.source);
  });

  it('重连从 SQLite 回放最新 result，不新增 occurrence、不调用 adapter', async () => {
    const { broker, store } = harness();
    openPermission(broker);
    expect(await broker.respond(response('rs_recover'))).toMatchObject({ ok: true, resultSeq: 1 });
    const replayed: ClientMessage[] = [];
    const emitter = new Emitter({ sink: (msg) => replayed.push(msg as ClientMessage) });
    const second = new TaskSupervisor();
    const deliver = vi.fn(async () => true);
    second.interactions.bind({ store, emit: (msg) => emitter.emit(msg), deliver });
    second.interactions.replayRecoverable();
    const results = replayed.filter((msg) => msg.type === 'task_interaction_result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ responseId: 'rs_recover', resultSeq: 1, requestState: 'resolved' });
    expect(deliver).not.toHaveBeenCalled();
    expect(store.listLatestInteractionResults('sess_broker')).toHaveLength(1);
  });

  it('等待超时会取消 adapter 并产生 expired occurrence，迟到响应不复活', async () => {
    const { broker, store, deliver } = harness();
    broker.open({
      sessionId: 'sess_broker',
      requestId: 'ir_timeout',
      kind: 'permission',
      payload: { options: [{ optionId: 'allow', kind: 'allow_once' }] },
      expiresAt: new Date(Date.now() + 20).toISOString(),
    });
    await vi.waitFor(() => expect(store.getInteraction('sess_broker', 'ir_timeout')?.state).toBe('expired'));
    expect(deliver).toHaveBeenCalledWith('sess_broker', 'ir_timeout', { action: 'cancel' });
    const result = store.listLatestInteractionResults('sess_broker')[0];
    expect(result).toMatchObject({ requestState: 'expired', resultSeq: 1, errorCode: 'interaction_expired' });
    const late = await broker.respond({ ...response('rs_late'), requestId: 'ir_timeout' });
    expect(late).toMatchObject({ ok: false, errorCode: 'interaction_expired', resultSeq: 2 });
    expect(late.result).toMatchObject({ requestState: 'expired', responseStatus: 'late' });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('终态取消按 taskId+requestId 路由，不误结算其他任务的同名交互', () => {
    const { broker, store } = harness();
    store.createSession({ sessionId: 'sess_other', mode: 'task', agentType: 'codex', cwd: process.cwd() });
    openPermission(broker, 'ir_shared');
    broker.open({
      sessionId: 'sess_other', requestId: 'ir_shared', kind: 'permission',
      payload: { options: [{ optionId: 'allow', kind: 'allow_once' }] },
    });
    broker.cancelRequest('sess_broker', 'default', 'ir_shared');
    expect(store.getInteraction('sess_broker', 'ir_shared')?.state).toBe('cancelled');
    expect(store.getInteraction('sess_other', 'ir_shared')?.state).toBe('pending');
  });

  it('supervisor waiting 保留名额并支持幂等重放，交付后才恢复 running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-waiting-'));
    let storeForCleanup: SessionStore | undefined;
    cleanups.push(() => {
      try {
        storeForCleanup?.close();
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows 下 ACP 子进程句柄可能滞后释放 */
      }
    });
    const script = join(dir, 'waiting-acp.cjs');
    writeFileSync(script, String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let promptId;
rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } });
  else if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'native_waiting' } });
  else if (m.method === 'session/prompt') {
    promptId = m.id;
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
      sessionId: 'native_waiting', options: [{ optionId: 'allow_once', kind: 'allow_once' }],
    }});
  } else if (m.id === 900) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
  } else if (m.method === 'session/cancel') process.exit(0);
});
`);
    const def = agentDefOf('codebuddy-cli')!;
    const originalBin = def.bin;
    def.bin = process.execPath;
    const supervisor = new TaskSupervisor(1);
    const store = new SessionStore(join(dir, 'waiting.db'));
    storeForCleanup = store;
    store.createSession({ sessionId: 'task_waiting', mode: 'task', agentType: 'codebuddy-cli', cwd: dir });
    const statuses: Array<{ status: TaskStatus; info?: TaskFinishInfo }> = [];
    const timeline: string[] = [];
    let handle!: TaskHandle;
    supervisor.interactions.bind({
      store,
      emit: (msg) => timeline.push(msg.type),
      deliver: (taskId, requestId, answer) => handle.respondInteraction!(requestId, answer),
      onResolved: (taskId, requestId) => supervisor.completeInteraction(taskId, requestId),
      onFailed: (taskId, requestId) => supervisor.failInteraction(taskId, requestId),
    });
    let interactionId = '';
    const req = {
      taskId: 'task_waiting', agentType: 'codebuddy-cli', cwd: dir, args: [] as string[], prompt: 'wait',
      interactive: true, acp: true,
      acpSpec: { command: process.execPath, args: [script], sanitizeHostEnv: false },
    };
    try {
      handle = supervisor.submit(req, {
        onLog: () => undefined,
        onStatus: (status, info) => {
          statuses.push({ status, info });
          timeline.push(`status:${info?.phase ?? status}`);
        },
        onInteraction: (request) => {
          interactionId = request.requestId;
          supervisor.interactions.open({
            sessionId: 'task_waiting',
            requestId: request.requestId,
            kind: request.kind,
            payload: request.payload,
            expiresAt: request.expiresAt,
          });
        },
      });
      // 这里等的是**真实子进程**跑完 ACP 握手并发出交互请求；vi.waitFor 默认只有 1s，
      // 在跑满 66 个测试文件的 Windows CI runner 上会假失败（2026-11-27 实测 30s 总时长里超时）。
      await vi.waitFor(() => expect(interactionId).not.toBe(''), { timeout: 15_000, interval: 50 });
      expect(supervisor.runningCount).toBe(1);
      expect(statuses.at(-1)?.info).toMatchObject({ phase: 'waiting_interaction', interactionId });
      const replay: TaskFinishInfo[] = [];
      supervisor.submit(req, { onLog: () => undefined, onStatus: (_s, info) => { if (info) replay.push(info); } });
      expect(replay.at(-1)).toMatchObject({ phase: 'waiting_interaction', interactionId });
      expect(supervisor.runningCount).toBe(1);
      await expect(supervisor.interactions.respond({
        type: 'task_interaction_response',
        taskId: 'task_waiting',
        requestId: interactionId,
        responseId: 'rs_waiting',
        state: 'accepted',
        payload: { optionId: 'allow_once' },
      })).resolves.toMatchObject({ ok: true, state: 'accepted' });
      await expect(handle.done).resolves.toBe('success');
      expect(statuses.some((entry) => entry.info?.phase === 'running')).toBe(true);
      expect(timeline.indexOf('task_interaction_result')).toBeLessThan(timeline.lastIndexOf('status:running'));
      expect(supervisor.runningCount).toBe(0);
    } finally {
      def.bin = originalBin;
    }
  });
});

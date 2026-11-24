/**
 * Codex App Server adapter (JSON-RPC over stdio).
 *
 * Verified against codex-cli 0.163.0:
 *   codex app-server --stdio
 *   initialize -> thread/start -> turn/start -> turn/completed
 *
 * Approval requests arrive as server-initiated JSON-RPC requests:
 *   item/commandExecution/requestApproval
 *   item/fileChange/requestApproval
 *   item/tool/requestUserInput
 * They pause the turn until the client replies.
 */

import { createInterface } from 'node:readline';
import { killCliProcess, spawnCliProcess } from './agent-adapters.js';

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodexApprovalRequest {
  requestId: number | string;
  method: string;
  kind: 'command' | 'file-change' | 'user-input' | 'permission';
  payload: Record<string, unknown>;
  /** 内部交付确认：审批结果写入 app-server stdio 后 resolve。 */
  delivery: Promise<boolean>;
}

export interface CodexPromptOptions {
  cwd: string;
  prompt: string;
  /** 可执行文件路径；缺省 'codex'。调用方应传 resolveBin 出来的绝对路径 */
  command?: string;
  /** 已有 Codex thread id：优先 thread/resume */
  nativeThreadId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (notification: Record<string, unknown>) => void;
  onApproval?: (request: CodexApprovalRequest) => Promise<string | undefined> | string | undefined;
  /** turn/start 完成后暴露 thread/turn 与 same-turn steer 能力 */
  onTurn?: (turn: {
    threadId: string;
    turnId: string;
    steer: (text: string) => Promise<void>;
  }) => void;
}

export interface CodexPromptResult {
  threadId: string;
  text: string;
  status: string;
}

export function codexAppServerArgs(): string[] {
  return ['app-server', '--stdio'];
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null ? (value as JsonObject) : {};
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof (value as JsonObject)['message'] === 'string') {
    return String((value as JsonObject)['message']);
  }
  return JSON.stringify(value);
}

export function codexTurnError(status: string, error?: unknown): Error | undefined {
  if (status === 'completed') return undefined;
  const detail = error === undefined ? '' : errorText(error);
  return new Error(`Codex turn ${status || 'unknown'}${detail ? `：${detail}` : ''}`);
}

function deliveryFuture(): { promise: Promise<boolean>; settle: (delivered: boolean) => void } {
  let settle!: (delivered: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
}

export async function runCodexPrompt(opts: CodexPromptOptions): Promise<CodexPromptResult> {
  const child = spawnCliProcess(opts.command ?? 'codex', codexAppServerArgs(), {
    cwd: opts.cwd,
    env: process.env,
  });

  let nextId = 1;
  let threadId = '';
  let turnId = '';
  let text = '';
  let closed = false;
  let turnSettled = false;
  const responseWaiters = new Set<(delivered: boolean) => void>();
  const settleResponseWaiters = (): void => {
    for (const finish of responseWaiters) finish(false);
    responseWaiters.clear();
  };
  let resolveTurn: (() => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  const turnDone = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  const pending = new Map<number, Pending>();

  const send = (message: JsonObject): boolean => {
    if (closed || !child.stdin.writable || child.stdin.destroyed) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      // false 仅表示背压，数据已被流接受；不能据此误判成交付失败。
      return true;
    } catch {
      return false;
    }
  };

  const request = (method: string, params: JsonObject, timeoutMs = 15_000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const writeResponse = (message: JsonObject): Promise<boolean> => {
    if (closed || !child.stdin.writable) return Promise.resolve(false);
    return new Promise<boolean>((resolvePromise) => {
      let finished = false;
      const finish = (delivered: boolean): void => {
        if (finished) return;
        finished = true;
        responseWaiters.delete(finish);
        resolvePromise(delivered);
      };
      responseWaiters.add(finish);
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, (error) => finish(!error));
      } catch {
        finish(false);
      }
    });
  };
  const respond = (id: unknown, result: unknown): Promise<boolean> => {
    if (typeof id !== 'number' && typeof id !== 'string') return Promise.resolve(false);
    return writeResponse({ jsonrpc: '2.0', id, result });
  };
  const respondError = (id: unknown, code: number, message: string): Promise<boolean> => {
    if (typeof id !== 'number' && typeof id !== 'string') return Promise.resolve(false);
    return writeResponse({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const failAll = (error: Error): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  const handleServerRequest = async (message: JsonObject): Promise<void> => {
    const delivery = deliveryFuture();
    const method = String(message['method'] ?? '');
    const params = asObject(message['params']);
    const kind: CodexApprovalRequest['kind'] =
      method === 'item/fileChange/requestApproval'
        ? 'file-change'
        : method === 'item/tool/requestUserInput'
          ? 'user-input'
          : method === 'item/permissions/requestApproval'
            ? 'permission'
            : 'command';
    try {
      const decision = opts.onApproval
        ? await opts.onApproval({
            requestId: (message['id'] as number | string | undefined) ?? '',
            method,
            kind,
            payload: params,
            delivery: delivery.promise,
          })
        : undefined;
      if (method === 'item/tool/requestUserInput') {
        // The caller returns a JSON string or undefined; undefined means cancel the turn.
        if (decision) {
          try {
            delivery.settle(await respond(message['id'], JSON.parse(decision)));
          } catch {
            delivery.settle(await respond(message['id'], { answers: {} }));
          }
        } else {
          delivery.settle(await respondError(message['id'], -32000, 'user input cancelled'));
        }
        return;
      }
      delivery.settle(await respond(message['id'], { decision: decision ?? 'decline' }));
    } catch {
      delivery.settle(false);
      await respond(message['id'], { decision: 'decline' });
    }
  };

  const handleNotification = (message: JsonObject): void => {
    const method = String(message['method'] ?? '');
    const params = asObject(message['params']);
    opts.onUpdate?.({ method, params });
    if (method === 'item/agentMessage/delta') {
      const delta = params['delta'];
      if (typeof delta === 'string') text += delta;
      return;
    }
    if (method === 'turn/completed') {
      if (turnSettled) return;
      turnSettled = true;
      const turn = asObject(params['turn']);
      const status = String(turn['status'] ?? 'unknown');
      const error = codexTurnError(status, turn['error']);
      if (error) rejectTurn?.(error);
      else resolveTurn?.();
      return;
    }
  };

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let message: JsonObject;
    try {
      message = JSON.parse(trimmed) as JsonObject;
    } catch {
      return;
    }
    const id = message['id'];
    if (typeof id === 'number' && pending.has(id)) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (message['error']) p.reject(new Error(errorText(message['error'])));
      else p.resolve(message['result']);
      return;
    }
    if (message['method']) {
      if (id !== undefined) void handleServerRequest(message);
      else {
        try {
          handleNotification(message);
        } catch (error) {
          failAll(error as Error);
          killCliProcess(child, opts.command ?? 'codex');
        }
      }
    }
  });

  child.on('error', (error) => {
    settleResponseWaiters();
    failAll(error);
    if (!turnSettled) {
      turnSettled = true;
      rejectTurn?.(error);
    }
  });
  child.on('close', (code) => {
    closed = true;
    settleResponseWaiters();
    const error = new Error(`Codex app-server 退出（code ${code ?? 'null'}）`);
    failAll(error);
    if (!turnSettled) {
      turnSettled = true;
      rejectTurn?.(error);
    }
  });

  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const cancel = (): void => {
    if (threadId && turnId) {
      void request('turn/interrupt', { threadId, turnId }, 3000).catch(() => undefined);
    }
    killCliProcess(child, opts.command ?? 'codex');
  };
  const timer = setTimeout(cancel, timeoutMs);
  const onAbort = (): void => cancel();
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await request('initialize', {
      clientInfo: { name: 'agent-bridge', version: '1.0.0' },
    });

    if (opts.nativeThreadId) {
      try {
        const resumed = (await request('thread/resume', {
          threadId: opts.nativeThreadId,
        })) as JsonObject;
        threadId = String(asObject(resumed['thread'])['id'] ?? opts.nativeThreadId);
      } catch {
        threadId = '';
      }
    }
    if (!threadId) {
      const started = (await request('thread/start', {
        cwd: opts.cwd,
        approvalPolicy: 'on-request',
      })) as JsonObject;
      threadId = String(asObject(started['thread'])['id'] ?? '');
    }
    if (!threadId) throw new Error('Codex thread/start 未返回 thread id');

    const startedTurn = (await request('turn/start', {
      threadId,
      input: [{ type: 'text', text: opts.prompt }],
    })) as JsonObject;
    turnId = String(asObject(startedTurn['turn'])['id'] ?? '');
    if (!turnId) throw new Error('Codex turn/start 未返回 turn id');
    opts.onTurn?.({
      threadId,
      turnId,
      steer: async (text: string) => {
        await request('turn/steer', {
          threadId,
          expectedTurnId: turnId,
          input: [{ type: 'text', text }],
        });
      },
    });

    await turnDone;
    return { threadId, text, status: 'completed' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    killCliProcess(child, opts.command ?? 'codex');
  }
}

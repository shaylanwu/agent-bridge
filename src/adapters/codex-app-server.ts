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

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export type CodexApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface CodexApprovalRequest {
  requestId: number | string;
  method: string;
  kind: 'command' | 'file-change' | 'user-input' | 'permission';
  payload: Record<string, unknown>;
}

export interface CodexPromptOptions {
  cwd: string;
  prompt: string;
  /** 已有 Codex thread id：优先 thread/resume */
  nativeThreadId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (notification: Record<string, unknown>) => void;
  onApproval?: (request: CodexApprovalRequest) => Promise<string | undefined> | string | undefined;
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

export async function runCodexPrompt(opts: CodexPromptOptions): Promise<CodexPromptResult> {
  const child = spawn('codex', codexAppServerArgs(), {
    cwd: opts.cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let nextId = 1;
  let threadId = '';
  let turnId = '';
  let text = '';
  let closed = false;
  let turnSettled = false;
  let resolveTurn: (() => void) | undefined;
  let rejectTurn: ((error: Error) => void) | undefined;
  const turnDone = new Promise<void>((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  const pending = new Map<number, Pending>();

  const send = (message: JsonObject): void => {
    if (closed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
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

  const respond = (id: unknown, result: unknown): void => {
    if (typeof id !== 'number' && typeof id !== 'string') return;
    send({ jsonrpc: '2.0', id, result });
  };

  const failAll = (error: Error): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };

  const handleServerRequest = async (message: JsonObject): Promise<void> => {
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
    const decision = opts.onApproval
      ? await opts.onApproval({
          requestId: (message['id'] as number | string | undefined) ?? '',
          method,
          kind,
          payload: params,
        })
      : undefined;
    if (method === 'item/tool/requestUserInput') {
      // The caller returns a JSON string or undefined; undefined means cancel the turn.
      if (decision) {
        try {
          respond(message['id'], JSON.parse(decision));
        } catch {
          respond(message['id'], { answers: {} });
        }
      } else {
        send({
          jsonrpc: '2.0',
          id: message['id'],
          error: { code: -32000, message: 'user input cancelled' },
        });
      }
      return;
    }
    respond(message['id'], { decision: decision ?? 'decline' });
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
      const status = String(turn['status'] ?? 'completed');
      if (status === 'failed') {
        rejectTurn?.(new Error(`Codex turn failed：${errorText(turn['error'])}`));
      } else {
        resolveTurn?.();
      }
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
          child.kill();
        }
      }
    }
  });

  child.on('error', (error) => {
    failAll(error);
    if (!turnSettled) {
      turnSettled = true;
      rejectTurn?.(error);
    }
  });
  child.on('close', (code) => {
    closed = true;
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
    child.kill();
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

    await turnDone;
    return { threadId, text, status: 'completed' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    child.kill();
  }
}

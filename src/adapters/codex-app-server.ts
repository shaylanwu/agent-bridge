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
import { externalProxyEnv } from '../infra/proxy-env.js';
import { killCliProcess, spawnCliProcess } from './agent-adapters.js';
import { withoutHostEnv } from './host-env.js';

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
  /**
   * 子进程环境；缺省 `externalProxyEnv(withoutHostEnv(process.env))`。
   *
   * 缺省值不是 `process.env`：直接继承有两处实测问题 —— ①宿主会话上下文
   * （CODEBUDDY_SESSION_ID 等）冒充宿主会话；②桌面/终端启动的 bridge 没有代理变量，
   * 而 codex 0.171 的 responses WebSocket 直连会被丢，每回合先空转 ~113s 才回退 HTTPS。
   */
  env?: NodeJS.ProcessEnv;
  /** 已有 Codex thread id：优先 thread/resume */
  nativeThreadId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: (notification: Record<string, unknown>) => void;
  onApproval?: (request: CodexApprovalRequest) => Promise<string | undefined> | string | undefined;
  /** stderr 的实时旁路（诊断用，已截断）；stderr 无论有没有订阅方都必须被读走 */
  onStderr?: (text: string) => void;
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

/** stderr 尾部保留上限：与 ACP 通道同量级，够看清最后一条错误栈又不塞满错误消息 */
export const CODEX_STDERR_TAIL_LIMIT = 4 * 1024;

export function codexChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return externalProxyEnv(withoutHostEnv(base));
}

/**
 * 把 codex 的「非内容型」通知压成一行给人看的文本（`error` / `warning` / `configWarning`）。
 *
 * 这些通知不承载对话内容，却常常是**唯一能解释「回合为什么不动」**的信息：
 * 2026-11-27 复盘到的 113s 静默就是 `error` 里的一串 `Reconnecting... n/5`。返回 undefined
 * 表示这条通知不该上行。
 */
export function codexNoticeText(notification: Record<string, unknown>): string | undefined {
  const method = String(notification['method'] ?? '');
  const params = asObject(notification['params']);
  if (method === 'warning' || method === 'configWarning') {
    const text = params['message'] ?? params['summary'];
    return typeof text === 'string' && text.trim() ? text.trim() : undefined;
  }
  if (method !== 'error') return undefined;
  const error = asObject(params['error']);
  const message =
    typeof error['message'] === 'string' ? error['message'] : Object.keys(error).length ? JSON.stringify(error) : '';
  const detail = typeof params['additionalDetails'] === 'string' ? params['additionalDetails'] : '';
  const suffix = params['willRetry'] === true ? '［将自动重试］' : '';
  const body = `${message}${detail ? `（${detail}）` : ''}`.trim();
  return body || suffix ? `${body}${suffix}`.trim() : undefined;
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
    env: opts.env ?? codexChildEnv(),
  });

  /**
   * stderr 必须持续读走：codex app-server 会往这里写配置告警、重连/回退提示与失败栈。
   * 不读有两个后果 —— ①失败只剩一个退出码，用户无法自查；②pipe 缓冲（64 KiB）写满后
   * 子进程阻塞在 write 上，协议流彻底停摆，外部只看得到 heartbeat（2026-11-27 复盘到的
   * 「交互模式回合挂死」就是这么被误判的）。尾部同时用于错误消息后缀。
   */
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderrTail = (stderrTail + text).slice(-CODEX_STDERR_TAIL_LIMIT);
    try {
      opts.onStderr?.(text);
    } catch {
      /* 诊断旁路不得影响回合 */
    }
  });
  const withStderr = (message: string): string => {
    const tail = stderrTail.trim();
    return tail ? `${message}\n[stderr] ${tail}` : message;
  };

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
  // 握手阶段（initialize/thread/start/turn/start）失败时 turnDone 永远不会被 await，
  // 它的 rejection 会变成未处理拒绝（Node 默认直接终止进程）。先挂一个空 catch 标记已处理；
  // 后面 `await turnDone` 仍然正常抛错，语义不变。
  void turnDone.catch(() => undefined);
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
        reject(new Error(withStderr(`Codex ${method} 超时（${timeoutMs}ms）`)));
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
      if (error) rejectTurn?.(new Error(withStderr(error.message)));
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
      if (message['error']) p.reject(new Error(withStderr(errorText(message['error']))));
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
    const error = new Error(withStderr(`Codex app-server 退出（code ${code ?? 'null'}）`));
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

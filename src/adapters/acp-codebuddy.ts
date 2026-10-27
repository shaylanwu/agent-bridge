/**
 * CodeBuddy ACP (v1) adapter.
 *
 * Verified against CodeBuddy 2.174.0:
 *   codebuddy --serve --acp --port 0
 *   -> initialize / session/new / session/prompt over NDJSON stdio.
 *
 * Important: WorkBuddy's own CodeBuddy process sets SERVER__PORT (e.g. 61899).
 * If inherited, the ACP child tries to bind the same port and dies with EADDRINUSE.
 * The adapter therefore always starts from a sanitized env and requires an explicit
 * CODEBUDDY_AUTH_TOKEN; encrypted host credentials are never read or decrypted.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { resolveCodeBuddyAuthToken } from './acp-auth.js';

export class AcpAuthRequiredError extends Error {
  constructor(message = 'CodeBuddy ACP 需要 CODEBUDDY_AUTH_TOKEN（宿主未注入登录态）') {
    super(message);
    this.name = 'AcpAuthRequiredError';
  }
}

const HOST_COLLISION_ENV = [
  'SERVER__PORT',
  'CODEBUDDY_SERVICE_PROXY_URL',
  'CODEBUDDY_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CODEBUDDY_TOOL_CALL_ID',
  'CODEBUDDY_ARTIFACTS',
  'CODEBUDDY_ROOT_REQUEST_ID',
  'CODEBUDDY_CONVERSATION_REQUEST_ID',
  'CODEBUDDY_CONVERSATION_MESSAGE_ID',
] as const;

export function codebuddyAcpArgs(): string[] {
  return ['--serve', '--acp', '--port', '0'];
}

export const CODEBUDDY_ACP_SPEC: AcpAgentSpec = {
  command: 'codebuddy',
  args: codebuddyAcpArgs(),
  authEnv: 'CODEBUDDY_AUTH_TOKEN',
  sanitizeHostEnv: true,
};

export function canRunAcp(spec: AcpAgentSpec | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!spec) return false;
  if (!spec.authEnv) return true;
  if (spec.authEnv === 'CODEBUDDY_AUTH_TOKEN') return hasCodebuddyAcpAuth(env);
  const token = env[spec.authEnv];
  return typeof token === 'string' && token.trim() !== '';
}

export function codebuddyAcpEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source };
  for (const key of HOST_COLLISION_ENV) delete env[key];
  const token = env['CODEBUDDY_AUTH_TOKEN'] || resolveCodeBuddyAuthToken();
  if (token) env['CODEBUDDY_AUTH_TOKEN'] = token;
  return env;
}

export function hasCodebuddyAcpAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const token = env['CODEBUDDY_AUTH_TOKEN'];
  if (typeof token === 'string' && token.trim() !== '') return true;
  return resolveCodeBuddyAuthToken() !== undefined;
}

export interface AcpPermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: unknown;
  options: AcpPermissionOption[];
}

export interface AcpFormRequest {
  sessionId: string;
  requestId: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  expiresAt?: string;
}

export type AcpFormResponse =
  | { action: 'accept'; content: Record<string, unknown> }
  | { action: 'decline' }
  | { action: 'cancel' };

export interface AcpPromptResult {
  sessionId: string;
  text: string;
  stopReason: string;
}

export interface AcpAgentSpec {
  command: string;
  args: string[];
  /** 该 ACP 入口要求的环境变量（如 CodeBuddy 的 CODEBUDDY_AUTH_TOKEN） */
  authEnv?: string;
  /** ACP authenticate methodId（如 Grok 的 cached_token） */
  authMethod?: string;
  /** 是否清理 WorkBuddy 宿主的 SERVER__PORT 等冲突变量 */
  sanitizeHostEnv?: boolean;
}

export interface AcpPromptOptions {
  cwd: string;
  prompt: string;
  spec?: AcpAgentSpec;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 已存在的 native session：优先 session/load，失败再 session/new */
  nativeSessionId?: string;
  signal?: AbortSignal;
  onUpdate?: (update: Record<string, unknown>) => void;
  onPermission?: (request: AcpPermissionRequest) => Promise<string | undefined> | string | undefined;
  /** ACP Form 扩展：session/request_form → 结构化 content */
  onForm?: (request: AcpFormRequest) => Promise<AcpFormResponse> | AcpFormResponse;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function isUnder(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s);
  const fc = fold(c);
  const fp = fold(p);
  return fc === fp || fc.startsWith(fp.endsWith(sep) ? fp : fp + sep);
}

export async function runAcpPrompt(opts: AcpPromptOptions): Promise<AcpPromptResult> {
  const spec = opts.spec ?? CODEBUDDY_ACP_SPEC;
  const env = spec.sanitizeHostEnv ? codebuddyAcpEnv(opts.env) : { ...(opts.env ?? process.env) };
  if (spec.authEnv && !canRunAcp(spec, env)) {
    throw new AcpAuthRequiredError(`ACP 需要 ${spec.authEnv}，未设置时不会启动无认证子进程`);
  }

  const child = spawn(spec.command, spec.args, {
    cwd: opts.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let nextId = 1;
  const pending = new Map<number, Pending>();
  let sessionId = '';
  let text = '';
  let stopReason = 'unknown';
  let closed = false;
  let timedOut = false;
  let aborted = false;

  const send = (message: Record<string, unknown>): void => {
    if (closed || !child.stdin.writable) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const request = (method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const respond = (id: unknown, result: unknown): void => {
    if (typeof id !== 'number') return;
    send({ jsonrpc: '2.0', id, result });
  };

  const respondError = (id: unknown, code: number, message: string): void => {
    if (typeof id !== 'number') return;
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const handleAgentRequest = async (message: Record<string, unknown>): Promise<void> => {
    const method = String(message['method'] ?? '');
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    if (method === 'session/request_permission') {
      const options = Array.isArray(params['options']) ? (params['options'] as AcpPermissionOption[]) : [];
      const selected = opts.onPermission
        ? await opts.onPermission({
            sessionId: String(params['sessionId'] ?? sessionId),
            toolCall: params['toolCall'],
            options,
          })
        : undefined;
      if (selected) {
        respond(message['id'], { outcome: { outcome: 'selected', optionId: selected } });
      } else {
        respond(message['id'], { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    // 表单有两个入口，语义一致（accept/decline/cancel + content），只是来源不同：
    //  - `session/request_form`：CodeBuddy 扩展方法，可能带 expiresAt 与自带 requestId；
    //  - `elicitation/create`：标准 ACP elicitation，requestId 只能由我们生成。
    // 之前只认前者，等于把「标准 ACP 的工具能弹表单」这件事说成了已支持 —— 现在两条都收。
    if (method === 'session/request_form' || method === 'elicitation/create') {
      const requestId =
        typeof params['requestId'] === 'string' && params['requestId']
          ? params['requestId']
          : `ir_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const requestedSchema =
        typeof params['requestedSchema'] === 'object' && params['requestedSchema'] !== null
          ? (params['requestedSchema'] as Record<string, unknown>)
          : {};
      const response = opts.onForm
        ? await opts.onForm({
            sessionId: String(params['sessionId'] ?? sessionId),
            requestId,
            message: String(params['message'] ?? ''),
            requestedSchema,
            ...(typeof params['expiresAt'] === 'string' ? { expiresAt: params['expiresAt'] } : {}),
          })
        : { action: 'cancel' as const };
      respond(message['id'], response);
      return;
    }
    if (method === 'fs/read_text_file') {
      const path = String(params['path'] ?? '');
      if (!isUnder(path, opts.cwd)) {
        respondError(message['id'], -32602, 'path outside cwd');
        return;
      }
      try {
        const content = await readFile(path, 'utf8');
        respond(message['id'], { content });
      } catch (error) {
        respondError(message['id'], -32000, (error as Error).message);
      }
      return;
    }
    if (method === 'fs/write_text_file') {
      const path = String(params['path'] ?? '');
      if (!isUnder(path, opts.cwd)) {
        respondError(message['id'], -32602, 'path outside cwd');
        return;
      }
      try {
        await writeFile(path, String(params['content'] ?? ''), 'utf8');
        respond(message['id'], {});
      } catch (error) {
        respondError(message['id'], -32000, (error as Error).message);
      }
      return;
    }
    // Unsupported client capability: answer with a JSON-RPC error instead of hanging the agent.
    if (message['id'] !== undefined) {
      respondError(message['id'], -32601, `unsupported client method: ${method}`);
    }
  };

  const handleMessage = (message: Record<string, unknown>): void => {
    const id = message['id'];
    if (typeof id === 'number' && pending.has(id) && (message['result'] !== undefined || message['error'])) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (message['error']) p.reject(new Error(JSON.stringify(message['error'])));
      else p.resolve(message['result']);
      return;
    }
    if (message['method']) {
      if (id !== undefined) void handleAgentRequest(message);
      return;
    }
    if (id !== undefined) {
      // Unexpected response shape: never leave the peer waiting.
      send({ jsonrpc: '2.0', id, result: {} });
    }
  };

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return; // HTTP server banner / logs
    try {
      const message = JSON.parse(trimmed) as Record<string, unknown>;
      if (message['method'] === 'session/update') {
        const params = (message['params'] ?? {}) as Record<string, unknown>;
        const update = (params['update'] ?? {}) as Record<string, unknown>;
        opts.onUpdate?.(update);
        if (update['sessionUpdate'] === 'agent_message_chunk') {
          const content = update['content'] as Record<string, unknown> | undefined;
          if (content?.['type'] === 'text' && typeof content['text'] === 'string') text += content['text'];
        }
        return;
      }
      handleMessage(message);
    } catch {
      /* non-JSON line */
    }
  });

  const failAll = (error: Error): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  child.on('error', (error) => failAll(error));
  child.on('close', (code) => {
    closed = true;
    failAll(
      new Error(
        timedOut
          ? 'CodeBuddy ACP 超时，进程已终止'
          : aborted
            ? 'CodeBuddy ACP 已取消'
            : `CodeBuddy ACP 进程退出（code ${code ?? 'null'}）`,
      ),
    );
  });

  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const cancel = (): void => {
    if (sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    child.kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    cancel();
  }, timeoutMs);
  const onAbort = (): void => {
    aborted = true;
    cancel();
  };
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const initialized = (await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'agent-bridge', version: '1.0.0' },
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        // 只有真正接了表单回调（= 本机交互开关打开且任务允许交互）才声明 elicitation。
        // 声明了却回不了，agent 会发出 elicitation 然后拿到 cancel —— 不如一开始不声明。
        ...(opts.onForm ? { elicitation: {} } : {}),
      },
    })) as { authMethods?: Array<{ id?: string }> };
    const methods = new Set(
      (initialized.authMethods ?? [])
        .map((method) => method.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const authMethod =
      spec.authMethod ??
      (spec.command === 'grok' && env['XAI_API_KEY'] ? 'xai.api_key' : undefined);
    if (authMethod && methods.has(authMethod)) {
      await request('authenticate', { methodId: authMethod, _meta: { headless: true } });
    }
    if (opts.nativeSessionId) {
      // 续会话有两条路，且不是所有 agent 两条都认（实测）：
      //  - ACP 标准 `session/load`（codebuddy/gemini/opencode/… 认）；
      //  - `dsh` 自家 `session/resume`，标准 load 回 -32601 Method not found。
      // 先试标准再试 resume：否则 dsh 会「静默退化成全新会话」——历史丢了却看不出来。
      const attempts: Array<{ method: string; params: Record<string, unknown> }> = [
        { method: 'session/load', params: { sessionId: opts.nativeSessionId, cwd: resolve(opts.cwd), mcpServers: [] } },
        { method: 'session/resume', params: { sessionId: opts.nativeSessionId, cwd: resolve(opts.cwd), mcpServers: [] } },
      ];
      for (const attempt of attempts) {
        try {
          const resumed = (await request(attempt.method, attempt.params)) as { sessionId?: string } | null;
          sessionId = resumed?.sessionId ?? opts.nativeSessionId;
          break;
        } catch {
          // 这个方法不被支持（或会话已过期）：试下一条，最后退回新会话
          sessionId = '';
        }
      }
    }
    if (!sessionId) {
      const newSession = (await request('session/new', {
        cwd: resolve(opts.cwd),
        mcpServers: [],
      })) as { sessionId?: string };
      sessionId = newSession.sessionId ?? '';
    }
    if (!sessionId) throw new Error('ACP session/new 未返回 sessionId');
    const result = (await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: opts.prompt }] },
      timeoutMs,
    )) as { stopReason?: string; _meta?: Record<string, unknown> };
    stopReason = result.stopReason ?? 'end_turn';
    const errorMessage = result._meta?.['codebuddy.ai/errorMessage'];
    if (typeof errorMessage === 'string' && /authentication required/i.test(errorMessage)) {
      throw new AcpAuthRequiredError('CodeBuddy ACP 登录态失效，请重新登录或注入 CODEBUDDY_AUTH_TOKEN');
    }
    return { sessionId, text, stopReason };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    try {
      if (sessionId && !closed) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    } catch {
      /* closing */
    }
    child.kill();
    // ACP 子进程常年驻留（--serve）；必须主动断开三条管道，否则调用方进程会被句柄拖住。
    child.stdin.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  }
}

/** 向后兼容入口：CodeBuddy 固定启动参数与认证门禁 */
export function runCodeBuddyAcpPrompt(opts: AcpPromptOptions): Promise<AcpPromptResult> {
  return runAcpPrompt({ ...opts, spec: CODEBUDDY_ACP_SPEC });
}

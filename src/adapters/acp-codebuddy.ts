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

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { resolveCodeBuddyAuthToken } from './acp-auth.js';
import { killCliProcess, spawnCliProcess } from './agent-adapters.js';
import { withoutHostEnv } from './host-env.js';
import { redactDiagnostic } from '../core/redact.js';
import { externalProxyEnv } from '../infra/proxy-env.js';

export class AcpAuthRequiredError extends Error {
  constructor(message = 'CodeBuddy ACP 需要 CODEBUDDY_AUTH_TOKEN（宿主未注入登录态）') {
    super(message);
    this.name = 'AcpAuthRequiredError';
  }
}

export function codebuddyAcpArgs(): string[] {
  return ['--serve', '--acp', '--port', '0'];
}

export const CODEBUDDY_ACP_SPEC: AcpAgentSpec = {
  command: 'codebuddy',
  args: codebuddyAcpArgs(),
  label: 'CodeBuddy',
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
  // 清宿主注入变量（清单见 adapters/host-env.ts，与 headless 通道共用同一张表），再补认证令牌
  const env = withoutHostEnv(source);
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
  /** 内部交付确认：respond 写入 stdio 后 resolve；不是权限回答本身。 */
  delivery: Promise<boolean>;
}

export interface AcpFormRequest {
  sessionId: string;
  requestId: string;
  message: string;
  requestedSchema: Record<string, unknown>;
  expiresAt?: string;
  /** 内部交付确认：Form 结果写入 stdio 后 resolve。 */
  delivery: Promise<boolean>;
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
  /**
   * 用户可见的产品名，只用于错误文案（"<label> 进程退出（code 1）"）。
   *
   * 这个 runner 是 12 个工具里 9 个共用的通用 ACP 实现，**不是 CodeBuddy 专属**；
   * 缺了它就只能写死一个产品名，于是 opencode / trae 的失败会被冠上别人的名字，
   * 排查时直接被带偏。缺省回落到 'ACP'，绝不猜。
   */
  label?: string;
  /** 该 ACP 入口要求的环境变量（如 CodeBuddy 的 CODEBUDDY_AUTH_TOKEN） */
  authEnv?: string;
  /** ACP authenticate methodId（如 Grok 的 grok.com） */
  authMethod?: string;
  /** 环境变量 → authMethodId；仅当该 env 有值时才用（如 XAI_API_KEY → xai.api_key） */
  authEnvMethods?: Record<string, string>;
  /**
   * 该工具交互式登录的命令（来自 `AgentDef.credential.loginCommand`）。
   * 失败时直接告诉用户「跑哪条命令」，比只报「需要认证」有用得多。
   */
  loginCommand?: string;
  /** 是否清理 WorkBuddy 宿主的 SERVER__PORT 等冲突变量 */
  sanitizeHostEnv?: boolean;
  /** 外部服务需使用显式/系统代理，而不是可能不可用的宿主代理 */
  preferSystemProxy?: boolean;
}

export interface AcpPromptOptions {
  cwd: string;
  prompt: string;
  spec?: AcpAgentSpec;
  /** 覆盖 spec.label（调用方有更准的名字时用，如 AgentDef.display） */
  label?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** 已存在的 native session：优先 session/load，失败再 session/new */
  nativeSessionId?: string;
  /**
   * 续会话**没成功**时的兜底 prompt（通常是完整 transcript）。
   * 不传就沿用 `prompt` —— 但那意味着「新会话里只剩这一轮说的那句话」，历史静默丢失。
   */
  replayPrompt?: string;
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

/** stderr 尾部保留上限：够看清最后一条错误栈，又不至于把整份日志塞进错误消息 */
export const ACP_STDERR_TAIL_LIMIT = 4 * 1024;

/**
 * ACP 帧的行长上限（接收侧，tasks.md 5.2 / design「有界解析防 DoS」）：
 * readline 没有行长限制 —— 恶意/异常 agent 发一条永不换行的超长流会把缓冲撑到无界。
 * 超限帧整帧丢弃并计数，后续正常行不受影响；上限取 1 MiB（交互 wire 上限 64 KiB 的
 * 同量级放宽，容纳 transcript 重放类大 prompt 帧）。
 */
export const ACP_MAX_LINE_BYTES = 1024 * 1024;

export interface BoundedLineReader {
  /** 喂入新数据（跨 chunk 半行重组），返回其中完整且未超限的行 */
  feed(chunk: string | Buffer): string[];
  /** EOF：交出未换行的尾部（超限丢弃态除外） */
  flush(): string[];
  /** 被丢弃的超限帧数（观测/诊断用） */
  droppedFrames(): number;
}

export function createBoundedLineReader(limit = ACP_MAX_LINE_BYTES): BoundedLineReader {
  let buf = '';
  let dropped = 0;
  let dropping = false;
  return {
    feed(chunk) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const out: string[] = [];
      let data = buf + text;
      let nl: number;
      while ((nl = data.indexOf('\n')) >= 0) {
        const line = data.slice(0, nl);
        data = data.slice(nl + 1);
        if (dropping) {
          // 上一帧超限被丢弃：这个换行是它的结束，本身不产出
          dropping = false;
          continue;
        }
        if (line.length > limit) {
          dropped += 1;
          continue;
        }
        out.push(line);
      }
      buf = data;
      if (buf.length > limit) {
        // 未终止帧已超限（无换行的持续流）：丢弃累积并进入丢弃态直到换行
        if (!dropping) dropped += 1;
        dropping = true;
        buf = '';
      }
      return out;
    },
    flush() {
      if (dropping || !buf) {
        buf = '';
        return [];
      }
      const rest = buf.length > limit ? [] : [buf];
      buf = '';
      return rest;
    },
    droppedFrames() {
      return dropped;
    },
  };
}

/** 只保留末尾 limit 个字符（纯函数，便于单测） */
export function tailOf(text: string, limit = ACP_STDERR_TAIL_LIMIT): string {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

/**
 * 子进程 stderr 尾部缓冲。
 *
 * 为什么必须读而不是 destroy：ACP agent（尤其 opencode/mimo 这类 Bun 编译的二进制）
 * 会往 stderr 打配置错误、认证提示、模型缺失等**唯一可解释失败原因**的信息。
 * 不读有两个后果：①失败只剩一个退出码，用户无法自查；②pipe 缓冲写满后子进程会阻塞在
 * write 上，表现为「挂住不动」——这比报错难查得多。
 */
function deliveryFuture(): { promise: Promise<boolean>; settle: (delivered: boolean) => void } {
  let settle!: (delivered: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    settle = resolvePromise;
  });
  return { promise, settle };
}

export function createStderrTail(limit = ACP_STDERR_TAIL_LIMIT): {
  push: (chunk: Buffer | string) => void;
  text: () => string;
} {
  let tail = '';
  return {
    push: (chunk) => {
      tail = tailOf(tail + (typeof chunk === 'string' ? chunk : chunk.toString('utf8')), limit);
    },
    text: () => tail,
  };
}

export async function runAcpPrompt(opts: AcpPromptOptions): Promise<AcpPromptResult> {
  const spec = opts.spec ?? CODEBUDDY_ACP_SPEC;
  const baseEnv = spec.sanitizeHostEnv ? codebuddyAcpEnv(opts.env) : { ...(opts.env ?? process.env) };
  const env = spec.preferSystemProxy ? externalProxyEnv(baseEnv) : baseEnv;
  if (spec.authEnv && !canRunAcp(spec, env)) {
    throw new AcpAuthRequiredError(`ACP 需要 ${spec.authEnv}，未设置时不会启动无认证子进程`);
  }

  // Windows 的 npm 垫片（.cmd/.bat）不能直接 spawn（CreateProcess 报 EINVAL）；
  // 垫片处理统一收敛在 agent-adapters 的 spawnCliProcess（唯一被门禁放行的位置）。
  const child = spawnCliProcess(spec.command, spec.args, { cwd: opts.cwd, env });

  const label = opts.label ?? spec.label ?? 'ACP';
  const stderrTail = createStderrTail();
  child.stderr?.on('data', (chunk: Buffer) => stderrTail.push(chunk));
  /** 是否成功走过 authenticate；initialize 之后才有结论 */
  let authenticated = false;
  /** 需要登录但没登录的提示，只在失败时追加 */
  let authHint = '';
  /** 错误消息的「为什么」后缀：有 stderr 就带上尾部，没有就不加噪音 */
  const why = (): string => {
    const tail = redactDiagnostic(stderrTail.text().trim());
    return `${tail ? `：${tail}` : ''}${authHint}`;
  };

  let nextId = 1;
  const pending = new Map<number, Pending>();
  let sessionId = '';
  let text = '';
  // session/load 可重放历史 chunk（agy 1.5.9 实测）；只有本轮 prompt 发出后才收集结果文本。
  let collectAgentText = false;
  let stopReason = 'unknown';
  let closed = false;
  let timedOut = false;
  let aborted = false;
  /** 已调用 write、等待 callback 的响应；进程关闭/错误必须立即以失败唤醒。 */
  const responseWaiters = new Set<(delivered: boolean) => void>();
  const settleResponseWaiters = (): void => {
    for (const finish of responseWaiters) finish(false);
    responseWaiters.clear();
  };

  const send = (message: Record<string, unknown>): boolean => {
    if (closed || !child.stdin.writable || child.stdin.destroyed) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      // write() 的 false 只是背压（数据已进入缓冲区），不是交付失败；异常/关闭才是不确定。
      return true;
    } catch {
      return false;
    }
  };

  const request = (method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> =>
    new Promise((resolvePromise, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label} ${method} 超时（${timeoutMs}ms）${why()}`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });

  const respond = (id: unknown, result: unknown): Promise<boolean> => {
    if ((typeof id !== 'number' && typeof id !== 'string') || closed || !child.stdin.writable) {
      return Promise.resolve(false);
    }
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
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`, (error) => {
          finish(!error);
        });
      } catch {
        finish(false);
      }
    });
  };

  const respondError = (id: unknown, code: number, message: string): void => {
    if (typeof id !== 'number' && typeof id !== 'string') return;
    send({ jsonrpc: '2.0', id, error: { code, message } });
  };

  const handleAgentRequest = async (message: Record<string, unknown>): Promise<void> => {
    const method = String(message['method'] ?? '');
    const params = (message['params'] ?? {}) as Record<string, unknown>;
    if (method === 'session/request_permission') {
      const delivery = deliveryFuture();
      const options = Array.isArray(params['options']) ? (params['options'] as AcpPermissionOption[]) : [];
      try {
        const selected = opts.onPermission
          ? await opts.onPermission({
              sessionId: String(params['sessionId'] ?? sessionId),
              toolCall: params['toolCall'],
              options,
              delivery: delivery.promise,
            })
          : undefined;
        delivery.settle(
          await (selected
            ? respond(message['id'], { outcome: { outcome: 'selected', optionId: selected } })
            : respond(message['id'], { outcome: { outcome: 'cancelled' } })),
        );
      } catch {
        delivery.settle(false);
        await respond(message['id'], { outcome: { outcome: 'cancelled' } });
      }
      return;
    }
    // 表单有两个入口，语义一致（accept/decline/cancel + content），只是来源不同：
    //  - `session/request_form`：CodeBuddy 扩展方法，可能带 expiresAt 与自带 requestId；
    //  - `elicitation/create`：标准 ACP elicitation，requestId 只能由我们生成。
    // 之前只认前者，等于把「标准 ACP 的工具能弹表单」这件事说成了已支持 —— 现在两条都收。
    if (method === 'session/request_form' || method === 'elicitation/create') {
      const delivery = deliveryFuture();
      const requestId =
        typeof params['requestId'] === 'string' && params['requestId']
          ? params['requestId']
          : `ir_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const requestedSchema =
        typeof params['requestedSchema'] === 'object' && params['requestedSchema'] !== null
          ? (params['requestedSchema'] as Record<string, unknown>)
          : {};
      try {
        const response = opts.onForm
          ? await opts.onForm({
              sessionId: String(params['sessionId'] ?? sessionId),
              requestId,
              message: String(params['message'] ?? ''),
              requestedSchema,
              ...(typeof params['expiresAt'] === 'string' ? { expiresAt: params['expiresAt'] } : {}),
              delivery: delivery.promise,
            })
          : { action: 'cancel' as const };
        delivery.settle(await respond(message['id'], response));
      } catch {
        delivery.settle(false);
        await respond(message['id'], { action: 'cancel' });
      }
      return;
    }
    // fs/terminal 等 client 能力默认不开放；即使 agent 忽略 initialize 声明直接调用，
    // 也统一返回 UnsupportedOperation，绝不能在这里绕过任务权限策略读写文件或执行命令。
    if (message['id'] !== undefined) {
      respondError(message['id'], -32601, `UnsupportedOperation: ${method}`);
    }
  };

  const handleMessage = (message: Record<string, unknown>): void => {
    const id = message['id'];
    if (typeof id === 'number' && pending.has(id) && (message['result'] !== undefined || message['error'])) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      if (message['error']) {
        // agent 用 JSON-RPC error 表达「未登录 / 模型缺失 / 配置非法」这类**唯一可解释**的原因，
        // 原样 JSON.stringify 会把 message 埋进结构里；这里取 message 并补上 label。
        const err = message['error'] as { code?: unknown; message?: unknown };
        const detail = typeof err.message === 'string' ? err.message : JSON.stringify(err);
        const code = typeof err.code === 'number' ? err.code : '?';
        p.reject(new Error(`${label} 返回错误（${code}）：${detail}${why()}`));
      } else p.resolve(message['result']);
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

  // 有界行读取（5.2 帧上限）：跨 chunk 半行重组 + 超限帧整帧丢弃（防无换行超长流的内存 DoS）
  const lineReader = createBoundedLineReader();
  const onLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return; // HTTP server banner / logs
    try {
      const message = JSON.parse(trimmed) as Record<string, unknown>;
      if (message['method'] === 'session/update') {
        const params = (message['params'] ?? {}) as Record<string, unknown>;
        const update = (params['update'] ?? {}) as Record<string, unknown>;
        opts.onUpdate?.(update);
        if (collectAgentText && update['sessionUpdate'] === 'agent_message_chunk') {
          const content = update['content'] as Record<string, unknown> | undefined;
          if (content?.['type'] === 'text' && typeof content['text'] === 'string') text += content['text'];
        }
        return;
      }
      handleMessage(message);
    } catch {
      /* non-JSON line */
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const line of lineReader.feed(chunk)) onLine(line);
  });
  child.stdout?.on('close', () => {
    for (const line of lineReader.flush()) onLine(line);
  });

  const failAll = (error: Error): void => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  };
  child.on('error', (error) => {
    settleResponseWaiters();
    failAll(error);
  });
  child.on('close', (code) => {
    closed = true;
    settleResponseWaiters();
    // 三条文案都必须带 label：这是 9 个工具共用的 runner，
    // 写死成 CodeBuddy 会让 opencode/trae/grok 的失败被误判成另一个产品的问题。
    failAll(
      new Error(
        timedOut
          ? `${label} 超时，进程已终止${why()}`
          : aborted
            ? `${label} 已取消${why()}`
            : `${label} 进程退出（code ${code ?? 'null'}）${why()}`,
      ),
    );
  });

  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const cancel = (): void => {
    if (sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    killCliProcess(child, spec.command);
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
        fs: { readTextFile: false, writeTextFile: false },
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
    // authMethod 不再按产品名硬编码：spec 里写明，或按「环境变量有值才用」的映射挑一个。
    // 顺序上先试显式配置，不在列表里才看环境变量映射 —— 实测 grok 只声明 grok.com，
    // 而写死 cached_token 时永远匹配不到，authenticate 就被静默跳过了。
    const candidates = [
      spec.authMethod,
      ...Object.entries(spec.authEnvMethods ?? {})
        .filter(([key]) => (env[key] ?? '').trim() !== '')
        .map(([, methodId]) => methodId),
    ].filter((methodId): methodId is string => typeof methodId === 'string' && methodId !== '');
    const authMethod = candidates.find((methodId) => methods.has(methodId));
    if (authMethod) {
      try {
        // 认证给短超时：有的 agent 把 authenticate 当**交互登录入口**（grok.com 要开浏览器），
        // headless 下不响应。原来用 15s 全局超时会白等，且失败就等于整个任务失败。
        await request('authenticate', { methodId: authMethod, _meta: { headless: true } }, 5_000);
        authenticated = true;
      } catch (error) {
        // 认证没走通 ≠ 不能跑：很多 agent 靠自身已登录态照样能工作。
        // 这里只记下原因、继续 session/new，让 agent 自己给出更准的错误。
        const how = spec.loginCommand ? `，请先运行 \`${spec.loginCommand}\`` : '';
        authHint = `（认证 ${authMethod} 未完成${how}：${(error as Error).message}）`;
      }
    }
    // 声明了认证方式却没走成（未配 method / 配的 method 不在列表里）：记下来，
    // 失败时追加到错误文案。**不在这里抛错** —— mimo 这类工具会列 opencode-login，
    // 但它靠自身已登录态照样能跑，硬失败会把能用的工具判死。
    if (methods.size > 0 && !authenticated && !authHint) {
      // 同时给「跑哪条命令」和「agent 声明的认证方式」：前者可操作，后者是证据。
      const how = spec.loginCommand ? `请先运行 \`${spec.loginCommand}\` 完成登录；` : '';
      authHint = `（${how}该工具声明了认证方式 ${[...methods].join(' / ')}）`;
    }
    if (opts.nativeSessionId) {
      // 续会话有两条路，且不是所有 agent 两条都认（实测）：
      //  - ACP 标准 `session/load`（codebuddy/opencode/mimo/grok/kimi/minimax/trae 认）；
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
    // 续上了的会话用「本轮新说的话」；**试过续但没续上**就必须把完整历史塞进首轮 prompt，
    // 否则新会话看着像正常回合，实际把之前所有上下文丢了 —— 这种失败看不出来。
    const attemptedResume = Boolean(opts.nativeSessionId);
    const resumedOk = Boolean(sessionId);
    if (!sessionId) {
      const newSession = (await request('session/new', {
        cwd: resolve(opts.cwd),
        mcpServers: [],
      })) as { sessionId?: string };
      sessionId = newSession.sessionId ?? '';
    }
    if (!sessionId) throw new Error('ACP session/new 未返回 sessionId');
    const promptText =
      !attemptedResume || resumedOk ? opts.prompt : (opts.replayPrompt ?? opts.prompt);
    collectAgentText = true;
    const result = (await request(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: promptText }] },
      timeoutMs,
    )) as { stopReason?: string; _meta?: Record<string, unknown> };
    stopReason = result.stopReason ?? 'end_turn';
    const errorMessage = result._meta?.['codebuddy.ai/errorMessage'];
    if (typeof errorMessage === 'string' && /authentication required/i.test(errorMessage)) {
      throw new AcpAuthRequiredError(`${label} 登录态失效，请重新登录或注入 CODEBUDDY_AUTH_TOKEN`);
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
    killCliProcess(child, spec.command);
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

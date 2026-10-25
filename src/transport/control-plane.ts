/**
 * 本地回环控制面（扩展能力，默认关闭）
 *
 * 服务对象是**本机上的其它程序**（IDE 插件、本机脚本、MCP server、CI runner），
 * **不是**远程平台 —— 远程平台永远走那条出站 WebSocket，控制面是**另一条**通道，两者互不干扰。
 *
 * 安全红线（护栏 `protocol-boundary-check` 硬校验，本文件必须同时满足三条）：
 *  1. 只绑回环 `127.0.0.1` / `::1`；
 *  2. 有 `enabled` 开关且默认关闭（不配置就一个端口都不监听）；
 *  3. 绝不返回 CORS 头（浏览器侧脚本无法静默调用本机端口）。
 *
 * 另外：端点一律要求 scoped Bearer（复用 P0-8 的 `abs_<kid>_<secret>`，不引入第二套身份体系），
 * 每次调用落审计；任务统一走 `TaskSupervisor`，并发上限与队列对两条通道**同时**生效。
 *
 * 零新增运行时依赖：`node:http` 手写路由。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { extname, resolve as resolvePath, sep } from 'node:path';
import { Emitter, type Upstream } from '../core/emitter.js';
import { isBridgeErrorCode, toProblem, type BridgeErrorCode } from '../core/errors.js';
import type { SessionLog } from '../app/session-log.js';
import type { TaskRegistry } from '../app/task-registry.js';
import type { SessionStore } from '../core/session-store.js';
import type { ArtifactTransferManager } from '../core/artifact-transfer.js';
import { DASHBOARD_HTML } from './control-plane-page.js';
import { SESSIONS_HTML } from './control-plane-sessions-page.js';
import { OFFICE_MIME_TYPES, renderOfficePreview } from './office-preview.js';
import type { ClientMessage, AgentListItem, TaskPhase } from '../protocol.js';
import {
  verifyServiceToken,
  type ServiceTokenRecord,
  type ServiceScope,
  type VerifyResult,
} from '../infra/service-token.js';
import { writeAudit } from '../infra/audit.js';
import type { RunTaskRequest, TaskFinishInfo, TaskHandle, TaskHooks } from '../core/task-supervisor.js';
import type { TaskStatus } from '../protocol.js';

/** 请求体上限：控制面只收任务参数，1 MB 足够，超了直接 413 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 幂等键上限（有界，插入顺序淘汰） */
const MAX_IDEMPOTENCY_KEYS = 1000;

export interface ControlPlaneDeps {
  /** 唯一上行出口：控制面**订阅**它来看全部任务事件，不另开一条出口 */
  emitter: Emitter;
  /** 任务提交（注入 `TaskSupervisor.submit`，便于单测替换） */
  startTask: (req: RunTaskRequest, hooks: TaskHooks) => TaskHandle;
  /** 任务注册表（与终端面板共享同一视图） */
  registry: TaskRegistry;
  /** 持久 Session/Turn/Event 权威源（只读查询） */
  store: SessionStore;
  /** 附件 TTL 管理 */
  artifacts: ArtifactTransferManager;
  scan: (opts: { fresh?: boolean }) => Promise<AgentListItem[]>;
  log: SessionLog;
  /** 能力清单（与 `hello.capabilities` 同源） */
  capabilities: readonly string[];
  version: string;
  /** 任务默认参数（并发/队列/diff 上限等，来自本地配置） */
  defaults: {
    allowedCwd?: string[];
    maxConcurrent: number;
    maxQueued: number;
    diffMaxBytes: number;
    captureDiffByDefault: boolean;
  };
  /** 令牌校验器（默认 `infra/service-token`；注入以便单测） */
  verify?: (token: string | undefined, scope: ServiceScope) => VerifyResult;
}

export interface ControlPlaneSettings {
  /**
   * 总开关（**默认关闭**）。显式传 false 时 `startControlPlane` 直接拒绝启动 ——
   * 不配置就不监听任何端口，"零入站"卖点不受影响。护栏强制本文件保留该字段。
   */
  enabled?: boolean;
  host: string;
  port: number;
  /** 要求 scope 令牌（默认 true；关掉 = 本机任意程序可调用） */
  requireToken?: boolean;
}

export interface ControlPlaneInstance {
  port: number;
  url: string;
  close: () => void;
}

interface TaskRecord {
  taskId: string;
  agentType: string;
  cwd: string;
  state: TaskStatus;
  phase?: TaskPhase;
  queuePosition?: number;
  exitCode?: number;
  error?: string;
  errorCode?: BridgeErrorCode;
  diff?: string;
  changedFiles?: string[];
  diffTruncated?: boolean;
  requestedBy?: string;
  purpose?: string;
  createdAt: string;
  updatedAt: string;
  /** 只有控制面下发的任务才有句柄（平台下发的任务由会话持有，控制面只能看不能杀） */
  handle?: TaskHandle;
}

interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
  scope?: ServiceScope;
}

const json = (res: ServerResponse, status: number, payload: unknown): void => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 不返回 CORS 头：浏览器脚本不得静默调用本机控制面
    'cache-control': 'no-store',
  });
  res.end(body);
};

const problem = (res: ServerResponse, status: number, code: BridgeErrorCode, detail?: string): void => {
  const body = JSON.stringify(toProblem(code, { status, detail }));
  res.writeHead(status, {
    'content-type': 'application/problem+json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
};

/** 回环判定：`::ffff:127.0.0.1`（IPv4-mapped）也算回环 */
function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === 'localhost';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** 对外视图：句柄（含 Promise / 函数）不进 JSON */
const view = (r: TaskRecord): Omit<TaskRecord, 'handle'> => {
  const { handle: _handle, ...rest } = r;
  return rest;
};

export async function startControlPlane(
  settings: ControlPlaneSettings,
  deps: ControlPlaneDeps,
): Promise<ControlPlaneInstance> {
  // 默认关闭：调用方没明确开启就一个端口都不监听（护栏：本文件必须存在 enabled 开关）
  if (settings.enabled === false) {
    throw new Error('控制面未启用（enabled=false）：本次不监听任何端口');
  }
  const requireToken = settings.requireToken !== false;
  const verify = deps.verify ?? verifyServiceToken;

  /** 任务台账：控制面下发的 + 平台下发的（同一进程下都经 emitter，视图统一） */
  const records = new Map<string, TaskRecord>();
  const order: string[] = [];
  const idempotency = new Map<string, string>();

  const remember = (r: TaskRecord): void => {
    if (!records.has(r.taskId)) order.push(r.taskId);
    records.set(r.taskId, r);
  };

  // 订阅上行：平台下发的任务也能在控制面里看到（不另开出口，不重复实现）
  const unsubscribe = deps.emitter.subscribe((msg: Upstream) => {
    const m = msg as ClientMessage;
    if (m.type !== 'task_status') return;
    const existing = records.get(m.taskId);
    const base: TaskRecord =
      existing ??
      {
        taskId: m.taskId,
        agentType: 'unknown',
        cwd: '',
        state: m.status,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    remember({
      ...base,
      state: m.status,
      phase: m.phase ?? undefined,
      queuePosition: m.queuePosition ?? undefined,
      exitCode: m.exitCode,
      error: m.error,
      // wire 上的 errorCode 是 string（前向兼容未知码）：只在受控枚举内才落到台账
      errorCode: isBridgeErrorCode(m.errorCode) ? m.errorCode : undefined,
      diff: m.diff ?? base.diff,
      changedFiles: m.changedFiles ?? base.changedFiles,
      diffTruncated: m.diffTruncated ?? base.diffTruncated,
      requestedBy: m.requestedBy ?? base.requestedBy,
      updatedAt: new Date().toISOString(),
    });
  });

  const authorize = (ctx: RouteContext, scope: ServiceScope): boolean => {
    if (!requireToken) return true;
    const header = ctx.req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    let token = raw?.startsWith('Bearer ') ? raw.slice(7).trim() : undefined;
    // EventSource 无法自定义请求头：回环面板允许 ?token= 兜底（仅本机回环，文档写明勿外发）
    if (!token) {
      const q = ctx.url.searchParams.get('token');
      token = q && q.trim() ? q.trim() : undefined;
    }
    const res = verify(token, scope);
    const at = new Date().toISOString();
    if (res.ok) {
      writeAudit({
        at,
        action: 'control_plane',
        outcome: 'allowed',
        purpose: `${ctx.req.method} ${ctx.url.pathname}`,
        serviceId: res.record?.id,
        scopes: res.record?.scopes,
      });
      return true;
    }
    const reason = res.reason ?? 'missing';
    const code: BridgeErrorCode =
      reason === 'missing' || reason === 'malformed'
        ? 'unauthorized'
        : reason === 'scope'
          ? 'insufficient_scope'
          : reason === 'expired' || reason === 'revoked'
            ? 'token_expired'
            : 'invalid_token';
    writeAudit({
      at,
      action: 'control_plane',
      outcome: 'denied',
      purpose: `${ctx.req.method} ${ctx.url.pathname}`,
      serviceId: res.record?.id,
      reason: res.message,
    });
    problem(ctx.res, code === 'insufficient_scope' ? 403 : 401, code, res.message ?? `需要 scope: ${scope}`);
    return false;
  };

  // ---------- 路由 ----------

  const handleHealth = (ctx: RouteContext): void => {
    json(ctx.res, 200, {
      status: 'ok',
      version: deps.version,
      controlPlane: { host: settings.host, port: settings.port, requireToken },
      // readiness：任务并发是否还有余量（CI 用它判断"现在能不能下发"）
      ready: true,
      tasks: { tracked: records.size },
    });
  };

  const handleCapabilities = (ctx: RouteContext): void => {
    json(ctx.res, 200, {
      capabilities: [...deps.capabilities],
      protocolVersion: 1,
      scopes: ['task:create', 'task:cancel', 'task:read', 'device:read'],
      endpoints: [
        '/v1/health',
        '/v1/capabilities',
        '/v1/agents',
        '/v1/agents:scan',
        '/v1/board',
        '/v1/tasks',
        '/v1/tasks/{id}',
        '/v1/tasks/{id}:cancel',
        '/v1/tasks/{id}/events',
        '/v1/tasks/{id}/diff',
      ],
    });
  };

  const handleAgents = async (ctx: RouteContext): Promise<void> => {
    const agents = await deps.scan({ fresh: ctx.url.searchParams.get('fresh') === 'true' });
    json(ctx.res, 200, { agents, scannedAt: new Date().toISOString() });
  };

  const handleCreateTask = (ctx: RouteContext): void => {
    const body = (ctx.body ?? {}) as Record<string, unknown>;
    const agentType = str(body['agentType']);
    const cwd = str(body['cwd']);
    if (!agentType || !cwd) {
      problem(ctx.res, 400, 'protocol_incompatible', '缺 agentType 或 cwd');
      return;
    }

    // 幂等：同一 key 重复提交返回同一 taskId（网络重试不至于跑两遍）
    const idemRaw = ctx.req.headers['idempotency-key'];
    const idem = Array.isArray(idemRaw) ? idemRaw[0] : idemRaw;
    if (idem) {
      const known = idempotency.get(idem);
      if (known) {
        const rec = records.get(known);
        if (rec) {
          json(ctx.res, 200, { ...view(rec), idempotentReplay: true });
          return;
        }
      }
    }

    const taskId = `bt_${randomBytes(6).toString('hex')}`;
    const record: TaskRecord = {
      taskId,
      agentType,
      cwd,
      state: 'running',
      requestedBy: str(body['requestedBy']),
      purpose: str(body['purpose']),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    remember(record);
    deps.registry.register(taskId, { agentType, cwd, source: 'control-plane' });
    if (idem) {
      idempotency.set(idem, taskId);
      if (idempotency.size > MAX_IDEMPOTENCY_KEYS) {
        const oldest = idempotency.keys().next().value;
        if (oldest !== undefined) idempotency.delete(oldest);
      }
    }

    const captureDiff = body['captureDiff'] === true || deps.defaults.captureDiffByDefault;
    const handle = deps.startTask(
      {
        taskId,
        agentType,
        cwd,
        args: Array.isArray(body['args']) ? body['args'].filter((a): a is string => typeof a === 'string') : [],
        prompt: str(body['prompt']),
        timeoutMs: typeof body['timeoutMs'] === 'number' ? body['timeoutMs'] : undefined,
        allowedCwd: deps.defaults.allowedCwd,
        maxConcurrent: deps.defaults.maxConcurrent,
        maxQueued: deps.defaults.maxQueued,
        captureDiff,
        diffMaxBytes: deps.defaults.diffMaxBytes,
      },
      {
        onLog: (_stream, data) =>
          deps.emitter.emit({ type: 'task_log', taskId, stream: _stream, data, isAnsi: true }),
        // 步骤流（B 批次）：控制面任务与平台任务同口径上行
        onStep: (step) => {
          deps.registry.updateStep(taskId, step);
          deps.emitter.emit({ type: 'task_step', taskId, ...step, at: new Date().toISOString() });
        },
        onPlan: (items) => {
          deps.registry.updatePlan(taskId, items);
        },
        onStatus: (status: TaskStatus, info?: TaskFinishInfo) => {
          deps.registry.updateStatus(taskId, status, info);
          const prev = records.get(taskId) ?? record;
          remember({
            ...prev,
            state: status,
            phase: info?.phase ?? undefined,
            queuePosition: info?.queuePosition ?? undefined,
            exitCode: info?.exitCode,
            error: info?.error,
            errorCode: info?.errorCode,
            diff: info?.diff,
            changedFiles: info?.changedFiles,
            diffTruncated: info?.diffTruncated,
            updatedAt: new Date().toISOString(),
          });
          // 控制面下发的任务同样经 Emitter 上行：平台侧视图不出现"半边失踪"
          deps.emitter.emit({
            type: 'task_status',
            taskId,
            status,
            exitCode: info?.exitCode,
            error: info?.error,
            errorCode: info?.errorCode,
            phase: info?.phase,
            queuePosition: info?.queuePosition,
            diff: info?.diff,
            changedFiles: info?.changedFiles,
            diffTruncated: info?.diffTruncated,
            requestedBy: record.requestedBy,
          });
        },
      },
    );
    void handle.done.then(() => undefined);
    // 以**最新**台账为准：startTask 可能同步就把终态回调了（此时 record 还是 running）
    remember({ ...(records.get(taskId) ?? record), handle });

    const { handle: _handle, ...publicView } = records.get(taskId) ?? record;
    json(ctx.res, 201, { ...publicView, events: `/v1/tasks/${taskId}/events` });
  };

  const handleListTasks = (ctx: RouteContext): void => {
    const limit = Math.min(200, Math.max(1, Number(ctx.url.searchParams.get('limit') ?? 50) || 50));
    const cursor = ctx.url.searchParams.get('cursor');
    const start = cursor ? order.indexOf(cursor) + 1 : 0;
    const slice = order.slice(Math.max(0, start), Math.max(0, start) + limit);
    const items = slice
      .map((id) => records.get(id))
      .filter((r): r is TaskRecord => r !== undefined)
      .map(view);
    const last = items.at(-1)?.taskId;
    json(ctx.res, 200, {
      tasks: items,
      // 游标而非 offset：任务列表会滚动，offset 会漏/重
      nextCursor: slice.length === limit && last ? last : null,
    });
  };

  const handleGetTask = (ctx: RouteContext, id: string): void => {
    const rec = records.get(id);
    if (!rec) {
      problem(ctx.res, 404, 'internal', `未跟踪的任务：${id}`);
      return;
    }
    json(ctx.res, 200, view(rec));
  };

  const handleDiff = (ctx: RouteContext, id: string): void => {
    const rec = records.get(id);
    // 平台任务没有控制面 records 台账：用共享注册表兜底，保证结果页双通道一致
    const viewFromRegistry = deps.registry.get(id);
    if (!rec && !viewFromRegistry) {
      problem(ctx.res, 404, 'internal', `未跟踪的任务：${id}`);
      return;
    }
    json(ctx.res, 200, {
      taskId: id,
      diff: rec?.diff ?? viewFromRegistry?.diff ?? '',
      changedFiles: rec?.changedFiles ?? viewFromRegistry?.changedFiles ?? [],
      diffTruncated: rec?.diffTruncated ?? viewFromRegistry?.diffTruncated ?? false,
    });
  };

  /** 步骤时间线（C 批次）：任务注册表出完整步骤序列 + 最终回答 */
  const handleSteps = (ctx: RouteContext, id: string): void => {
    const v = deps.registry.get(id);
    if (!v) {
      problem(ctx.res, 404, 'internal', `未跟踪的任务：${id}`);
      return;
    }
    json(ctx.res, 200, {
      taskId: id,
      status: v.status,
      phase: v.phase,
      queuePosition: v.queuePosition,
      stepCount: v.stepCount,
      steps: v.steps,
      plan: v.plan,
      finalText: v.finalText,
      error: v.error,
    });
  };

  /** 文件预览（结果查看入口）：只读、锁任务 cwd、≤512KB、按扩展名给 content-type */
  const MAX_FILE_PREVIEW = 512 * 1024;
  const CONTENT_TYPES: Record<string, string> = {
    '.md': 'text/markdown; charset=utf-8',
    '.markdown': 'text/markdown; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.tsv': 'text/tab-separated-values; charset=utf-8',
    '.pdf': 'application/pdf',
    '.docx': OFFICE_MIME_TYPES['.docx']!,
    '.xlsx': OFFICE_MIME_TYPES['.xlsx']!,
    '.pptx': OFFICE_MIME_TYPES['.pptx']!,
  };
  const handleFilePreview = (ctx: RouteContext, id: string): void => {
    const cwd = deps.registry.cwdOf(id);
    if (!cwd) {
      problem(ctx.res, 404, 'internal', `未跟踪的任务：${id}`);
      return;
    }
    const rel = ctx.url.searchParams.get('path') ?? '';
    if (!rel) {
      problem(ctx.res, 400, 'protocol_incompatible', '缺少 path 参数');
      return;
    }
    const abs = resolvePath(cwd, rel);
    // 防穿越：解析后必须仍在任务 cwd 内
    if (abs !== cwd && !abs.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep)) {
      problem(ctx.res, 403, 'cwd_not_allowed', '路径越出任务工作目录');
      return;
    }
    // allowed_cwd 白名单（配置时才生效）——任务提交时已查过，这里纵深再查一次
    const allowed = deps.defaults.allowedCwd;
    if (allowed && allowed.length > 0) {
      const ok = allowed.some((root) => {
        const r = resolvePath(root);
        return abs === r || abs.startsWith(r.endsWith(sep) ? r : r + sep);
      });
      if (!ok) {
        problem(ctx.res, 403, 'cwd_not_allowed', '路径不在 allowed_cwd 范围');
        return;
      }
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      problem(ctx.res, 404, 'internal', `文件不存在：${rel}`);
      return;
    }
    if (!st.isFile()) {
      problem(ctx.res, 400, 'protocol_incompatible', '不是文件');
      return;
    }
    if (st.size > MAX_FILE_PREVIEW) {
      problem(ctx.res, 413, 'internal', `文件超过 512KB 预览上限（${st.size} 字节）`);
      return;
    }
    const ctype = CONTENT_TYPES[extname(abs).toLowerCase()] || 'application/octet-stream';
    const isBinaryPreview = ctype.startsWith('image/') || ctype === 'application/pdf' || ctype.includes('officedocument');
    const maxBytes = isBinaryPreview ? 20 * 1024 * 1024 : MAX_FILE_PREVIEW;
    if (st.size > maxBytes) {
      problem(ctx.res, 413, 'internal', `文件超过 ${maxBytes / 1024 / 1024}MB 预览上限（${st.size} 字节）`);
      return;
    }
    if (ctx.url.searchParams.get('render') === '1') {
      const html = renderOfficePreview(abs);
      if (html) {
        ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        ctx.res.end(html);
        return;
      }
    }
    if (ctx.req.method === 'HEAD') {
      ctx.res.writeHead(200, { 'content-type': ctype, 'content-length': String(st.size), 'cache-control': 'no-store' });
      ctx.res.end();
      return;
    }
    ctx.res.writeHead(200, { 'content-type': ctype, 'content-length': String(st.size), 'cache-control': 'no-store' });
    ctx.res.end(readFileSync(abs));
  };

  const handleCancel = (ctx: RouteContext, id: string): void => {
    const rec = records.get(id);
    if (!rec) {
      problem(ctx.res, 404, 'internal', `未跟踪的任务：${id}`);
      return;
    }
    // 幂等：已终态再取消不报错
    if (rec.state === 'success' || rec.state === 'failed' || rec.state === 'cancelled' || rec.state === 'timeout') {
      json(ctx.res, 200, { ...view(rec), alreadySettled: true });
      return;
    }
    if (!rec.handle) {
      // 平台下发的任务由平台会话持有句柄：控制面只能看，不能替平台做决定
      problem(ctx.res, 409, 'cwd_not_allowed', `任务 ${id} 不是由控制面下发，无法从此通道取消`);
      return;
    }
    // 真正的取消走 supervisor（SIGTERM → 2s → SIGKILL）；终态由它经 Emitter 回传，不在这里代发
    rec.handle.cancel();
    json(ctx.res, 200, view(records.get(id) ?? rec));
  };

  const handleSessions = (ctx: RouteContext): void => {
    if (!authorize(ctx, 'task:read')) return;
    const limitRaw = Number(ctx.url.searchParams.get('limit') ?? '50');
    const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, Math.floor(limitRaw))) : 50;
    json(ctx.res, 200, {
      sessions: deps.store.listSessions().slice(-limit).map((session) => {
        const window = deps.store.eventWindow(session.sessionId);
        return { ...session, ...window };
      }),
    });
  };

  const handleArtifactDownload = (ctx: RouteContext, sessionId: string, artifactId: string): void => {
    if (!authorize(ctx, 'task:read')) return;
    const found = deps.artifacts.artifactPath(sessionId, artifactId);
    if (!found) {
      problem(ctx.res, 404, 'internal', `未找到附件：${artifactId}`);
      return;
    }
    ctx.res.writeHead(200, {
      'content-type': found.artifact.mimeType || 'application/octet-stream',
      'content-length': String(found.artifact.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(found.artifact.name)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    const stream = createReadStream(found.path);
    stream.on('error', () => {
      try {
        ctx.res.destroy();
      } catch {
        /* closed */
      }
    });
    stream.pipe(ctx.res);
  };

  const handleArtifactsGc = (ctx: RouteContext): void => {
    if (!authorize(ctx, 'task:cancel')) return;
    const body = (ctx.body ?? {}) as { ttlDays?: unknown; dryRun?: unknown };
    const ttlDays = typeof body.ttlDays === 'number' ? Math.floor(body.ttlDays) : 30;
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
      problem(ctx.res, 400, 'cwd_not_allowed', 'ttlDays 必须是正整数');
      return;
    }
    const result = deps.artifacts.cleanupArtifacts({
      olderThanMs: ttlDays * 24 * 60 * 60 * 1000,
      dryRun: body.dryRun === true,
    });
    json(ctx.res, 200, { ttlDays, dryRun: body.dryRun === true, ...result });
  };

  const handleSessionSnapshot = (ctx: RouteContext, id: string): void => {
    if (!authorize(ctx, 'task:read')) return;
    try {
      const afterRaw = Number(ctx.url.searchParams.get('afterEventSeq') ?? '0');
      const limitRaw = Number(ctx.url.searchParams.get('limit') ?? '200');
      const snapshot = deps.store.snapshot(id, {
        afterEventSeq: Number.isFinite(afterRaw) ? Math.max(0, Math.floor(afterRaw)) : 0,
        limit: Number.isFinite(limitRaw) ? Math.min(1000, Math.max(1, Math.floor(limitRaw))) : 200,
      });
      json(ctx.res, 200, snapshot);
    } catch {
      problem(ctx.res, 404, 'internal', `未找到会话：${id}`);
    }
  };

  /**
   * 会话 SSE：先回放 SQLite 历史（afterEventSeq 之后），再接实时上行。
   * event: snapshot / event / wire / heartbeat / done
   */
  const handleSessionEvents = (ctx: RouteContext, id: string): void => {
    if (!authorize(ctx, 'task:read')) return;
    let snapshot: ReturnType<SessionStore['snapshot']>;
    try {
      snapshot = deps.store.snapshot(id, { afterEventSeq: 0, limit: 1000 });
    } catch {
      problem(ctx.res, 404, 'internal', `未找到会话：${id}`);
      return;
    }
    const afterRaw = Number(ctx.url.searchParams.get('afterEventSeq') ?? '0');
    const after = Number.isFinite(afterRaw) ? Math.max(0, Math.floor(afterRaw)) : 0;
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const writeEvent = (event: string, data: unknown): void => {
      try {
        ctx.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        /* 客户端已断开 */
      }
    };
    writeEvent('snapshot', {
      session: snapshot.session,
      oldestEventSeq: snapshot.oldestEventSeq,
      latestEventSeq: snapshot.latestEventSeq,
    });

    const replay = deps.store.listEvents(id, { afterEventSeq: after, limit: 1000 });
    for (const item of replay) {
      writeEvent('event', {
        eventSeq: item.eventSeq,
        type: item.type,
        payload: item.payload,
        createdAt: item.createdAt,
      });
    }
    let lastSeq = replay.at(-1)?.eventSeq ?? after;
    if (snapshot.session.status !== 'running') {
      writeEvent('done', { taskId: id, status: snapshot.session.status });
      ctx.res.end();
      return;
    }

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      off();
      clearInterval(heartbeat);
      try {
        ctx.res.end();
      } catch {
        /* already ended */
      }
    };
    const send = (upstream: Upstream): void => {
      if (closed) return;
      const raw = upstream as ClientMessage & { specversion?: string; data?: ClientMessage };
      const msg = raw.specversion && raw.data ? raw.data : raw;
      if (!('taskId' in msg) || msg.taskId !== id) return;
      const seq =
        'eventSeq' in msg && typeof msg.eventSeq === 'number' ? msg.eventSeq : undefined;
      if (seq !== undefined && seq <= lastSeq) return;
      if (seq !== undefined) lastSeq = seq;
      writeEvent('wire', msg);
      const current = deps.store.getSession(id);
      if (!current || current.status !== 'running') {
        writeEvent('done', { taskId: id, status: current?.status ?? 'unknown' });
        cleanup();
      }
    };
    const off = deps.emitter.subscribe(send);
    const heartbeat = setInterval(() => writeEvent('heartbeat', { at: Date.now() }), 15_000);
    heartbeat.unref?.();
    ctx.req.on('close', cleanup);
    ctx.res.on('close', cleanup);
  };

  /** SSE：晚订阅先从环形缓冲补发，再接实时事件 */
  const handleEvents = (ctx: RouteContext, id: string): void => {
    ctx.res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    ctx.res.write(`event: hello\ndata: ${JSON.stringify({ taskId: id })}\n\n`);

    const send = (msg: Upstream): void => {
      const m = msg as ClientMessage;
      const belongs =
        (m.type === 'task_log' || m.type === 'task_status' || m.type === 'task_step') &&
        'taskId' in m &&
        m.taskId === id;
      if (!belongs) return;
      try {
        ctx.res.write(`data: ${JSON.stringify(m)}\n\n`);
      } catch {
        /* 客户端已断开 */
      }
    };
    // 补发：只补本任务的近期事件
    for (const m of deps.emitter.recent(256)) send(m);
    const off = deps.emitter.subscribe(send);
    const bye = (): void => {
      off();
      try {
        ctx.res.end();
      } catch {
        /* 已结束 */
      }
    };
    ctx.req.on('close', bye);
    ctx.res.on('close', bye);
  };

  // ---------- 分发 ----------

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (!isLoopback(req.socket.remoteAddress)) {
          // 绑回环后理论不可能命中；留作纵深防御（例如被端口转发）
          problem(res, 403, 'cwd_not_allowed', '控制面只接受回环来源');
          return;
        }
        const host = req.headers['host'] ?? '127.0.0.1';
        const url = new URL(req.url ?? '/', `http://${host}`);
        const path = url.pathname;

        const raw = ['POST', 'PUT', 'PATCH'].includes(req.method ?? 'GET') ? await readBody(req) : '';
        let body: unknown = undefined;
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            problem(res, 400, 'protocol_incompatible', '请求体不是合法 JSON');
            return;
          }
        }
        const ctx: RouteContext = { req, res, url, body };

        if (path === '/v1/health') return handleHealth(ctx);
        if (path === '/favicon.ico' && req.method === 'GET') {
          ctx.res.writeHead(204);
          ctx.res.end();
          return;
        }
        // Web 任务面板（C 批次）：页面壳免令牌（不含数据），数据仍走带鉴权的 /v1/* 端点
        if (path === '/' && req.method === 'GET') {
          ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          ctx.res.end(DASHBOARD_HTML);
          return;
        }
        if (path === '/sessions' && req.method === 'GET') {
          ctx.res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          ctx.res.end(SESSIONS_HTML);
          return;
        }
        // 面板聚合视图：任务注册表（与终端面板同源）+ 计数 + 容量
        if (path === '/v1/artifacts:gc' && req.method === 'POST') {
          return handleArtifactsGc(ctx);
        }
        if (path === '/v1/sessions' && req.method === 'GET') {
          return handleSessions(ctx);
        }
        const artifactMatch = /^\/v1\/sessions\/([^/]+)\/artifacts\/([^/]+)$/.exec(path);
        if (artifactMatch && req.method === 'GET') {
          return handleArtifactDownload(
            ctx,
            decodeURIComponent(artifactMatch[1] ?? ''),
            decodeURIComponent(artifactMatch[2] ?? ''),
          );
        }
        const sessionEventsMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(path);
        if (sessionEventsMatch && req.method === 'GET') {
          return handleSessionEvents(ctx, decodeURIComponent(sessionEventsMatch[1] ?? ''));
        }
        const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
        if (sessionMatch && req.method === 'GET') {
          return handleSessionSnapshot(ctx, decodeURIComponent(sessionMatch[1] ?? ''));
        }
        if (path === '/v1/board' && req.method === 'GET') {
          if (!authorize(ctx, 'task:read')) return;
          json(ctx.res, 200, {
            counts: deps.registry.counts(),
            capacity: {
              running: deps.registry.counts().running,
              queued: deps.registry.counts().queued,
              maxTasks: deps.defaults.maxConcurrent,
              maxQueued: deps.defaults.maxQueued,
            },
            tasks: deps.registry.list(),
          });
          return;
        }
        if (path === '/v1/capabilities') {
          if (!authorize(ctx, 'device:read')) return;
          return handleCapabilities(ctx);
        }
        if (path === '/v1/agents') {
          if (!authorize(ctx, 'device:read')) return;
          return await handleAgents(ctx);
        }
        if (path === '/v1/agents:scan') {
          if (!authorize(ctx, 'device:read')) return;
          return await handleAgents(ctx);
        }
        if (path === '/v1/tasks' && req.method === 'GET') {
          if (!authorize(ctx, 'task:read')) return;
          return handleListTasks(ctx);
        }
        if (path === '/v1/tasks' && req.method === 'POST') {
          if (!authorize(ctx, 'task:create')) return;
          return handleCreateTask(ctx);
        }
        // id 不含 `/` 与 `:`：否则 `:cancel` 会被贪婪的 id 部分吃掉
        const m = path.match(/^\/v1\/tasks\/([^/:]+)(:cancel|\/events|\/diff|\/steps|\/file)?$/);
        if (m) {
          const id = decodeURIComponent(m[1] as string);
          const suffix = m[2] ?? '';
          if (suffix === '/events') {
            if (!authorize(ctx, 'task:read')) return;
            return handleEvents(ctx, id);
          }
          if (suffix === '/steps') {
            if (!authorize(ctx, 'task:read')) return;
            return handleSteps(ctx, id);
          }
          if (suffix === '/file') {
            if (!authorize(ctx, 'task:read')) return;
            return handleFilePreview(ctx, id);
          }
          if (suffix === ':cancel' && req.method === 'POST') {
            if (!authorize(ctx, 'task:cancel')) return;
            return handleCancel(ctx, id);
          }
          if (suffix === '/diff') {
            if (!authorize(ctx, 'task:read')) return;
            return handleDiff(ctx, id);
          }
          if (!suffix && req.method === 'GET') {
            if (!authorize(ctx, 'task:read')) return;
            return handleGetTask(ctx, id);
          }
        }
        problem(res, 404, 'protocol_incompatible', `未知端点：${req.method} ${path}`);
      } catch (e) {
        deps.log('error', `[control-plane] ${(e as Error).message}`);
        if (!res.headersSent) problem(res, 500, 'internal', (e as Error).message);
      }
    })();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : settings.port;
      deps.log('info', `[control-plane] 回环控制面已启动 http://${settings.host}:${port}`);
      resolve({
        port,
        url: `http://${settings.host}:${port}`,
        close: () => {
          unsubscribe();
          server.close();
        },
      });
    });
  });
}

/**
 * Persistent Session/Turn/Event store (1.0).
 *
 * SQLite is the authority: eventSeq allocation, idempotency, snapshots and tombstones all commit
 * in one transaction. Wire types live in src/protocol.ts; this module is the durable domain model.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  InteractionKind,
  InteractionRequestState,
  InteractionResponseStatus,
} from '../protocol.js';
import type { ApprovalRecord } from './permission-ledger.js';

export type SessionMode = 'task' | 'conversation';
export type SessionPhase = 'queued' | 'running' | 'waiting_interaction' | 'waiting_user' | 'settled';
export type SessionTerminalStatus = 'success' | 'failed' | 'cancelled' | 'timeout';
export type SessionStatus = 'running' | SessionTerminalStatus;
export type TurnStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';
// 交互种类是 wire 语义（平台按它决定渲染），真源在 protocol；这里只做同值转出，避免两处漂移
export type { InteractionKind };
export type InteractionState = InteractionRequestState | 'accepted' | 'declined';

const SCHEMA_VERSION = 6;
export const DEFAULT_TENANT = 'default';

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalJson(child)]),
    );
  }
  return value;
}

export function fingerprintIdempotency(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function containsUrlKey(value: unknown, depth = 0): boolean {
  if (depth > 8 || !value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => containsUrlKey(item, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => key.toLowerCase() === 'url' || containsUrlKey(child, depth + 1),
  );
}

export class SessionStoreError extends Error {
  constructor(
    readonly code:
      | 'session_not_found'
      | 'session_deleted'
      | 'session_conflict'
      | 'event_conflict'
      | 'idempotency_conflict'
      | 'turn_not_found'
      | 'interaction_not_found'
      | 'artifact_not_found'
      | 'invalid_input',
    message: string,
  ) {
    super(message);
    this.name = 'SessionStoreError';
  }
}

export interface SessionRecord {
  tenantId: string;
  sessionId: string;
  contextId: string;
  mode: SessionMode;
  status: SessionStatus;
  phase: SessionPhase;
  agentType: string;
  cwd: string;
  permissionMode?: string;
  /** CLI 原生 session/thread/conversation id（用于展示与后续 resume） */
  nativeSessionId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export interface TurnExecutionSnapshot {
  args: string[];
  prompt?: string;
  timeoutMs?: number;
  allowInteractive?: boolean;
  captureDiff?: boolean;
  permissionMode?: 'default' | 'full';
  requestedBy?: string;
  purpose?: string;
}

export interface TurnRecord {
  tenantId: string;
  sessionId: string;
  turnId: string;
  ordinal: number;
  status: TurnStatus;
  stopReason?: string;
  startedAt?: string;
  finishedAt?: string;
  enqueuedAt?: string;
  /** 恢复 queued Turn 所需的原始业务参数；绝不包含 serviceToken。 */
  execution?: TurnExecutionSnapshot;
}

export interface SessionEvent {
  tenantId: string;
  sessionId: string;
  eventSeq: number;
  type: string;
  payload: unknown;
  createdAt: string;
}

export interface MessageRecord {
  tenantId: string;
  sessionId: string;
  messageId: string;
  turnId?: string;
  eventSeq: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  createdAt: string;
}

export interface InteractionRecord {
  tenantId: string;
  sessionId: string;
  requestId: string;
  turnId?: string;
  kind: InteractionKind;
  state: InteractionState;
  requestEventSeq?: number;
  payload: unknown;
  expiresAt?: string;
  responseId?: string;
  responseFingerprint?: string;
  resolvedFingerprint?: string;
  resolution?: Record<string, unknown>;
  resultSeq?: number;
  resultPayload?: unknown;
  createdAt: string;
}

export interface InteractionResultRecord {
  tenantId: string;
  sessionId: string;
  requestId: string;
  resultSeq: number;
  responseId?: string;
  responseFingerprint?: string;
  responseAnchor: boolean;
  requestState: InteractionRequestState;
  responseStatus?: InteractionResponseStatus;
  state: 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';
  resolution?: Record<string, unknown>;
  errorCode?: string;
  at: string;
}

export interface ArtifactRecord {
  tenantId: string;
  artifactId: string;
  sessionId: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  kind: string;
  storageKey: string;
  createdAt: string;
}

export type ArtifactTransferState = 'uploading' | 'committed' | 'aborted';

export interface ArtifactTransferRecord {
  tenantId: string;
  transferId: string;
  sessionId: string;
  operationId: string;
  artifactId: string;
  direction: 'upload' | 'download';
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  chunkSize: number;
  nextOffset: number;
  tempPath?: string;
  state: ArtifactTransferState;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSnapshot {
  session: SessionRecord;
  turns: TurnRecord[];
  events: SessionEvent[];
  interactions: InteractionRecord[];
  artifacts: ArtifactRecord[];
  oldestEventSeq?: number;
  latestEventSeq?: number;
  /** 是否还有比本次窗口更旧的事件（回翻用；false = 已经到最旧） */
  hasMoreBefore?: boolean;
  /** 已被 retention 裁掉的最高序号（0/缺省 = 没有裁剪过） */
  prunedThrough?: number;
}

interface SessionRow {
  tenant_id: string;
  session_id: string;
  context_id: string;
  mode: SessionMode;
  status: SessionStatus;
  phase: SessionPhase;
  agent_type: string;
  cwd: string;
  permission_mode: string | null;
  native_session_id: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

interface TurnRow {
  tenant_id: string;
  session_id: string;
  turn_id: string;
  ordinal: number;
  status: TurnStatus;
  stop_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  enqueued_at: string | null;
  execution_json: string | null;
}

interface EventRow {
  tenant_id: string;
  session_id: string;
  event_seq: number;
  type: string;
  payload: string;
  created_at: string;
}

interface MessageRow {
  tenant_id: string;
  session_id: string;
  message_id: string;
  turn_id: string | null;
  event_seq: number;
  role: 'user' | 'agent' | 'system';
  text: string;
  created_at: string;
}

interface InteractionRow {
  tenant_id: string;
  session_id: string;
  request_id: string;
  turn_id: string | null;
  kind: InteractionKind;
  state: InteractionState;
  request_event_seq: number | null;
  payload: string;
  expires_at: string | null;
  response_id: string | null;
  response_fingerprint: string | null;
  resolved_fingerprint: string | null;
  resolution: string | null;
  result_seq: number | null;
  result_payload: string | null;
  created_at: string;
}

interface InteractionResultRow {
  tenant_id: string;
  session_id: string;
  request_id: string;
  result_seq: number;
  response_id: string | null;
  response_fingerprint: string | null;
  response_anchor: number;
  request_state: InteractionRequestState;
  response_status: InteractionResponseStatus | null;
  state: 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';
  resolution: string | null;
  error_code: string | null;
  created_at: string;
}

interface ArtifactTransferRow {
  tenant_id: string;
  transfer_id: string;
  session_id: string;
  operation_id: string;
  artifact_id: string;
  direction: 'upload' | 'download';
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  chunk_size: number;
  next_offset: number;
  temp_path: string | null;
  state: ArtifactTransferState;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  tenant_id: string;
  artifact_id: string;
  session_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  kind: string;
  storage_key: string;
  created_at: string;
}

interface ApprovalRow {
  tenant_id: string;
  approval_id: string;
  principal_id: string;
  agent_type: string;
  tool: string;
  action: string;
  resource: string;
  scope: string;
  fingerprint: string;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
}

const now = (): string => new Date().toISOString();

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    tenantId: row.tenant_id,
    approvalId: row.approval_id,
    principalId: row.principal_id,
    agentType: row.agent_type,
    tool: row.tool,
    action: row.action,
    resource: row.resource,
    scope: row.scope,
    fingerprint: row.fingerprint,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? undefined,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    contextId: row.context_id,
    mode: row.mode,
    status: row.status,
    phase: row.phase,
    agentType: row.agent_type,
    cwd: row.cwd,
    permissionMode: row.permission_mode ?? undefined,
    nativeSessionId: row.native_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at ?? undefined,
  };
}

function toTurn(row: TurnRow): TurnRecord {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    status: row.status,
    stopReason: row.stop_reason ?? undefined,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    enqueuedAt: row.enqueued_at ?? undefined,
    execution: row.execution_json ? parseJson(row.execution_json) : undefined,
  };
}

function toEvent(row: EventRow): SessionEvent {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    eventSeq: row.event_seq,
    type: row.type,
    payload: parseJson(row.payload),
    createdAt: row.created_at,
  };
}

function toMessage(row: MessageRow): MessageRecord {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    messageId: row.message_id,
    turnId: row.turn_id ?? undefined,
    eventSeq: row.event_seq,
    role: row.role,
    text: row.text,
    createdAt: row.created_at,
  };
}

function toInteraction(row: InteractionRow): InteractionRecord {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    turnId: row.turn_id ?? undefined,
    kind: row.kind,
    state: row.state,
    requestEventSeq: row.request_event_seq ?? undefined,
    payload: parseJson(row.payload),
    expiresAt: row.expires_at ?? undefined,
    responseId: row.response_id ?? undefined,
    responseFingerprint: row.response_fingerprint ?? undefined,
    resolvedFingerprint: row.resolved_fingerprint ?? undefined,
    resolution: row.resolution ? parseJson(row.resolution) : undefined,
    resultSeq: row.result_seq ?? undefined,
    resultPayload: row.result_payload ? parseJson(row.result_payload) : undefined,
    createdAt: row.created_at,
  };
}

function toInteractionResult(row: InteractionResultRow): InteractionResultRecord {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    requestId: row.request_id,
    resultSeq: row.result_seq,
    responseId: row.response_id ?? undefined,
    responseFingerprint: row.response_fingerprint ?? undefined,
    responseAnchor: row.response_anchor === 1,
    requestState: row.request_state,
    responseStatus: row.response_status ?? undefined,
    state: row.state,
    resolution: row.resolution ? parseJson(row.resolution) : undefined,
    errorCode: row.error_code ?? undefined,
    at: row.created_at,
  };
}

function toTransfer(row: ArtifactTransferRow): ArtifactTransferRecord {
  return {
    tenantId: row.tenant_id,
    transferId: row.transfer_id,
    sessionId: row.session_id,
    operationId: row.operation_id,
    artifactId: row.artifact_id,
    direction: row.direction,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    chunkSize: row.chunk_size,
    nextOffset: row.next_offset,
    tempPath: row.temp_path ?? undefined,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toArtifact(row: ArtifactRow): ArtifactRecord {
  return {
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    sessionId: row.session_id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    sha256: row.sha256,
    kind: row.kind,
    storageKey: row.storage_key,
    createdAt: row.created_at,
  };
}

export interface SessionStoreOptions {
  /**
   * 单会话事件保留上限（0/缺省 = 不裁剪）。
   * 裁剪是**惰性**的：每写入 100 条检查一次，不做定时任务 —— 长会话不必等进程重启才瘦身，
   * 也不会因为每条事件都跑一次 DELETE 把热路径拖慢。
   */
  retentionMaxEvents?: number;
  /**
   * per-task 有界 canonical feed（spec「会话快照、预算与终态收尾」）：
   * 200 messages / 200 steps / 50 artifacts、4 MiB 单任务、64 MiB 进程是**默认配置而非产品硬上限**。
   * 未传（undefined）= 整套机制关闭（测试与旧用法兼容）；单维 0 = 该维不启用。
   * 淘汰产生显式 gap（feed_gaps 表，reason = count | task_bytes | global_bytes），
   * 绝不淘汰各会话最新终态 task_status；pending 交互在独立表，天然不受影响。
   */
  feedBudgets?: {
    maxMessages?: number;
    maxSteps?: number;
    maxArtifacts?: number;
    /** 单任务（会话）事件 payload 总字节上限 */
    taskMaxBytes?: number;
    /** 进程全局（全库）事件 payload 总字节上限；检查是惰性的（每会话每 64 条） */
    globalMaxBytes?: number;
  };
  /**
   * 打开时跑一次 `PRAGMA quick_check`（缺省开启）。
   *
   * 为什么必须在**打开时**做：损坏的 SQLite 文件往往能正常 open、也能过 schema 检查，
   * 但会在跑到一半时读页失败 —— 那种故障现场（任务跑了一半报内部错误）几乎无法排查。
   * 自检很快（quick_check 不校验索引一致性），换来的是「启动就拒绝」而不是「中途炸」。
   * 已知需要跳过时（超大库、只读校验场景）显式传 false。
   */
  integrityCheck?: boolean;
}

export class SessionStore {
  private readonly db: Database.Database;
  private readonly retentionMaxEvents: number;
  private readonly feed: {
    maxMessages: number;
    maxSteps: number;
    maxArtifacts: number;
    taskMaxBytes: number;
    globalMaxBytes: number;
  };
  private closed = false;

  constructor(dbPath: string, options: SessionStoreOptions = {}) {
    this.retentionMaxEvents = Math.max(0, Math.floor(options.retentionMaxEvents ?? 0));
    const b = options.feedBudgets;
    this.feed = {
      maxMessages: b ? Math.max(0, Math.floor(b.maxMessages ?? 0)) : 0,
      maxSteps: b ? Math.max(0, Math.floor(b.maxSteps ?? 0)) : 0,
      maxArtifacts: b ? Math.max(0, Math.floor(b.maxArtifacts ?? 0)) : 0,
      taskMaxBytes: b ? Math.max(0, Math.floor(b.taskMaxBytes ?? 0)) : 0,
      globalMaxBytes: b ? Math.max(0, Math.floor(b.globalMaxBytes ?? 0)) : 0,
    };
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    const opened = new Database(dbPath);
    this.db = opened;
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      // 在迁移之前自检：库坏了就当场拒绝，不要让 migrate 用半读得通的页去建表
      if (options.integrityCheck !== false) this.assertIntegrity(dbPath);
      this.migrate();
    } catch (error) {
      // 构造失败必须释放句柄；否则损坏库/权限错误会留下锁，测试和重启都清不掉文件。
      try {
        opened.close();
      } catch {
        /* already closed */
      }
      throw new Error(
        `打开状态库失败（${dbPath}）：${(error as Error).message}；请检查文件是否损坏或权限是否可写`,
      );
    }
  }

  /**
   * `PRAGMA quick_check`：正常返回只有一行 `ok`，有问题时每行一条描述。
   * 内部版直接抛；对外版 `checkIntegrity()` 返回结果，供健康检查与运维排查使用。
   */
  private assertIntegrity(dbPath: string): void {
    const problems = this.integrityProblems();
    if (problems.length === 0) return;
    throw new Error(
      `完整性自检失败（${dbPath}）：${problems.slice(0, 3).join('; ')}` +
        (problems.length > 3 ? ` 等 ${problems.length} 项` : ''),
    );
  }

  private integrityProblems(): string[] {
    const rows = this.db.pragma('quick_check') as Array<Record<string, unknown>>;
    return rows
      .map((row) => String(Object.values(row)[0] ?? ''))
      .filter((text) => text !== '' && text !== 'ok');
  }

  /** 立即跑一次完整性自检（健康检查用）。库已关闭时返回 ok=false 而不是抛 */
  checkIntegrity(): { ok: boolean; detail?: string } {
    try {
      const problems = this.integrityProblems();
      return problems.length === 0 ? { ok: true } : { ok: false, detail: problems.slice(0, 3).join('; ') };
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }

  /**
   * 建表 DDL **每次打开都跑**（整段都是 `CREATE TABLE IF NOT EXISTS`，对已存在的表是 no-op）。
   *
   * ⛔ 不要用 `user_version >= SCHEMA_VERSION` 把这段挡住。2026-10-29 的真实故障就是这么来的：
   * `event_prunes` 是后来追加进这段 DDL 的，而已经升到 `SCHEMA_VERSION = 4` 的老库命中了
   * 「版本号够了就 return」，表永远建不出来；偏偏 `appendEvent()` 无条件
   * `SELECT pruned_through FROM event_prunes`，于是**每一条事件写入都抛 `no such table`**。
   * 现场表现极具误导性：平台侧「已下发，等待第一条输出」，本机面板「暂无任务」，
   * 而被异常打断的位置恰好在 `registry.register()` 之前 —— 任务连面板都进不去。
   *
   * 结论：幂等 DDL 无条件执行（微秒级开销），版本号只做标记；只有**必须看现有列结构才能决定**
   * 的变更（如 `ALTER TABLE ADD COLUMN`）才走结构探测。
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        context_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('task','conversation')),
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        cwd TEXT NOT NULL,
        permission_mode TEXT,
        native_session_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        PRIMARY KEY (tenant_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS turns (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        stop_reason TEXT,
        started_at TEXT,
        finished_at TEXT,
        enqueued_at TEXT,
        execution_json TEXT,
        PRIMARY KEY (tenant_id, session_id, turn_id),
        UNIQUE (tenant_id, session_id, ordinal),
        FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS events (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, event_seq),
        FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_session_seq ON events (tenant_id, session_id, event_seq);
      CREATE TABLE IF NOT EXISTS messages (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        turn_id TEXT,
        event_seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, message_id),
        UNIQUE (tenant_id, session_id, event_seq),
        FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS artifact_transfers (
        tenant_id TEXT NOT NULL,
        transfer_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        chunk_size INTEGER NOT NULL,
        next_offset INTEGER NOT NULL,
        temp_path TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, transfer_id),
        UNIQUE (tenant_id, session_id, operation_id)
      );
      CREATE TABLE IF NOT EXISTS interactions (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        turn_id TEXT,
        kind TEXT NOT NULL,
        state TEXT NOT NULL,
        request_event_seq INTEGER,
        payload TEXT NOT NULL,
        expires_at TEXT,
        response_id TEXT,
        response_fingerprint TEXT,
        resolved_fingerprint TEXT,
        resolution TEXT,
        result_seq INTEGER,
        result_payload TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, request_id),
        FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS interaction_results (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        result_seq INTEGER NOT NULL,
        response_id TEXT,
        response_fingerprint TEXT,
        response_anchor INTEGER NOT NULL DEFAULT 0,
        request_state TEXT NOT NULL,
        response_status TEXT,
        state TEXT NOT NULL,
        resolution TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, request_id, result_seq),
        FOREIGN KEY (tenant_id, session_id, request_id)
          REFERENCES interactions (tenant_id, session_id, request_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS interaction_results_response
        ON interaction_results (tenant_id, session_id, request_id, response_id, response_anchor);
      CREATE TABLE IF NOT EXISTS artifacts (
        tenant_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        kind TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, artifact_id),
        FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS event_prunes (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        pruned_through INTEGER NOT NULL,
        removed INTEGER NOT NULL,
        pruned_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id),
        FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS feed_gaps (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('count','task_bytes','global_bytes')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, from_seq, to_seq)
      );
      CREATE TABLE IF NOT EXISTS session_tombstones (
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        closed_at TEXT NOT NULL,
        reason TEXT,
        PRIMARY KEY (tenant_id, session_id)
      );
      CREATE TABLE IF NOT EXISTS approvals (
        tenant_id TEXT NOT NULL,
        approval_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        tool TEXT NOT NULL,
        action TEXT NOT NULL,
        resource TEXT NOT NULL,
        scope TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (tenant_id, approval_id)
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        tenant_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, scope, key)
      );
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
    // v3 -> v4：老库补列（CREATE TABLE IF NOT EXISTS 不会改已存在的表）
    const columns = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'native_session_id')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN native_session_id TEXT');
    }
    const interactionColumns = this.db.pragma('table_info(interactions)') as Array<{ name: string }>;
    for (const column of ['response_fingerprint', 'resolved_fingerprint', 'resolution', 'request_event_seq']) {
      if (!interactionColumns.some((existing) => existing.name === column)) {
        this.db.exec(`ALTER TABLE interactions ADD COLUMN ${column} TEXT`);
      }
    }
    const turnColumns = this.db.pragma('table_info(turns)') as Array<{ name: string }>;
    for (const column of ['enqueued_at', 'execution_json']) {
      if (!turnColumns.some((existing) => existing.name === column)) {
        this.db.exec(`ALTER TABLE turns ADD COLUMN ${column} TEXT`);
      }
    }
    return;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  createSession(input: {
    sessionId: string;
    tenantId?: string;
    contextId?: string;
    mode: SessionMode;
    agentType: string;
    cwd: string;
    permissionMode?: string;
    nativeSessionId?: string;
    status?: SessionStatus;
    phase?: SessionPhase;
  }): { session: SessionRecord; created: boolean } {
    if (!input.sessionId.trim()) throw new SessionStoreError('invalid_input', 'sessionId 不能为空');
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    if (this.getTombstone(input.sessionId, tenantId)) {
      throw new SessionStoreError('session_deleted', `会话 ${input.sessionId} 已删除且不可复用`);
    }
    const existing = this.getSession(input.sessionId, tenantId);
    if (existing) return { session: existing, created: false };
    const at = now();
    const session: SessionRecord = {
      tenantId,
      sessionId: input.sessionId,
      contextId: input.contextId ?? randomUUID(),
      mode: input.mode,
      status: input.status ?? 'running',
      phase: input.phase ?? 'queued',
      agentType: input.agentType,
      cwd: input.cwd,
      permissionMode: input.permissionMode,
      nativeSessionId: input.nativeSessionId,
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO sessions
           (tenant_id, session_id, context_id, mode, status, phase, agent_type, cwd, permission_mode, native_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.tenantId,
        session.sessionId,
        session.contextId,
        session.mode,
        session.status,
        session.phase,
        session.agentType,
        session.cwd,
        session.permissionMode ?? null,
        session.nativeSessionId ?? null,
        session.createdAt,
        session.updatedAt,
      );
    return { session, created: true };
  }

  getSession(sessionId: string, tenantId = DEFAULT_TENANT): SessionRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE tenant_id = ? AND session_id = ?')
      .get(tenantId, sessionId) as SessionRow | undefined;
    return row ? toSession(row) : undefined;
  }

  listSessions(tenantId = DEFAULT_TENANT): SessionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE tenant_id = ? ORDER BY created_at')
      .all(tenantId) as SessionRow[];
    return rows.map(toSession);
  }

  /** 仅供启动恢复/内部重放使用；外部控制面必须继续走 listSessions(tenant)。 */
  listAllSessions(): SessionRecord[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY created_at').all() as SessionRow[];
    return rows.map(toSession);
  }

  updateSession(
    sessionId: string,
    patch: Partial<
      Pick<SessionRecord, 'status' | 'phase' | 'permissionMode' | 'nativeSessionId' | 'closedAt'>
    >,
    tenantId = DEFAULT_TENANT,
  ): SessionRecord {
    const current = this.getSession(sessionId, tenantId);
    if (!current) throw new SessionStoreError('session_not_found', `会话不存在：${sessionId}`);
    const next = { ...current, ...patch, updatedAt: now() };
    this.db
      .prepare(
        `UPDATE sessions
            SET status = ?, phase = ?, permission_mode = ?, native_session_id = ?, closed_at = ?, updated_at = ?
          WHERE tenant_id = ? AND session_id = ?`,
      )
      .run(
        next.status,
        next.phase,
        next.permissionMode ?? null,
        next.nativeSessionId ?? null,
        next.closedAt ?? null,
        next.updatedAt,
        tenantId,
        sessionId,
      );
    return next;
  }

  closeSession(
    sessionId: string,
    status: SessionTerminalStatus,
    reason?: string,
    tenantId = DEFAULT_TENANT,
  ): SessionRecord {
    const at = now();
    const tx = this.db.transaction(() => {
      const session = this.updateSession(
        sessionId,
        { status, phase: 'settled', closedAt: at },
        tenantId,
      );
      this.db
        .prepare(
          `INSERT INTO session_tombstones (tenant_id, session_id, closed_at, reason)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (tenant_id, session_id) DO UPDATE SET closed_at = excluded.closed_at, reason = excluded.reason`,
        )
        .run(tenantId, sessionId, at, reason ?? null);
      return session;
    });
    return tx();
  }

  getTombstone(sessionId: string, tenantId = DEFAULT_TENANT): { closedAt: string; reason?: string } | undefined {
    const row = this.db
      .prepare('SELECT closed_at, reason FROM session_tombstones WHERE tenant_id = ? AND session_id = ?')
      .get(tenantId, sessionId) as { closed_at: string; reason: string | null } | undefined;
    return row ? { closedAt: row.closed_at, reason: row.reason ?? undefined } : undefined;
  }

  /**
   * 真正删除一个会话及其全部内容（turns / events / messages / interactions / artifacts / transfers）。
   *
   * 这是 `session_deleted` 这个受控码的**唯一产生点**：`close_session` 只写 tombstone、保留历史，
   * 所以「关了」和「没了」在数据层必须分开 —— 前者平台还能 read 快照，后者只能看到 410。
   *
   * 三条纪律：
   *  1. tombstone **保留**（不随会话级联删），它记录「这个 ID 存在过、现在没了、永不复用」；
   *  2. `running` 的会话拒删 —— 删掉正在跑的任务会让平台永远等不到终态；
   *  3. `artifact_transfers` 没有外键，必须显式删，否则会留一批指向空会话的孤儿行。
   */
  deleteSession(
    sessionId: string,
    opts: { tenantId?: string; reason?: string } = {},
  ): { deleted: boolean; events: number; turns: number; reason?: 'not_found' | 'session_running' } {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT;
    const session = this.getSession(sessionId, tenantId);
    if (!session) return { deleted: false, events: 0, turns: 0, reason: 'not_found' };
    if (session.status === 'running') {
      return { deleted: false, events: 0, turns: 0, reason: 'session_running' };
    }
    const tx = this.db.transaction(() => {
      const count = (table: string): number =>
        Number(
          (
            this.db
              .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ? AND session_id = ?`)
              .get(tenantId, sessionId) as { n: number }
          ).n,
        );
      const events = count('events');
      const turns = count('turns');
      this.db.prepare('DELETE FROM artifact_transfers WHERE tenant_id = ? AND session_id = ?').run(tenantId, sessionId);
      // 其余子表靠 ON DELETE CASCADE 带走（连接上已开 foreign_keys = ON）
      this.db.prepare('DELETE FROM sessions WHERE tenant_id = ? AND session_id = ?').run(tenantId, sessionId);
      const at = now();
      this.db
        .prepare(
          `INSERT INTO session_tombstones (tenant_id, session_id, closed_at, reason)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (tenant_id, session_id) DO UPDATE SET closed_at = excluded.closed_at, reason = excluded.reason`,
        )
        .run(tenantId, sessionId, at, opts.reason ?? 'deleted');
      return { events, turns };
    });
    const counts = tx();
    return { deleted: true, ...counts };
  }

  /**
   * 该会话已被 retention 裁掉的最高序号（没有裁剪过 = 0）。
   *
   * 两种用途：
   *  1. 分配新 eventSeq 时的**下界** —— 全被裁掉后 MAX(event_seq) 会退回 0，
   *     不设下界就会从 1 重新发号，与已裁剪的历史撞号；
   *  2. 判断平台请求的游标是否落在已裁剪区间，落了就回 `session_history_pruned`。
   */
  getPrunedThrough(sessionId: string, tenantId = DEFAULT_TENANT): number {
    const row = this.db
      .prepare('SELECT pruned_through FROM event_prunes WHERE tenant_id = ? AND session_id = ?')
      .get(tenantId, sessionId) as { pruned_through: number } | undefined;
    return row?.pruned_through ?? 0;
  }

  /**
   * 按条数裁剪最旧的事件（retention 的最小可用形态：按数量而非时间，无需定时任务）。
   *
   * 只删事件，不删 session/turn/artifact —— 那些是「这个任务发生过」的证据。
   * 裁剪水位写进 `event_prunes`，回翻时据此明确回 `session_history_pruned`，
   * 而不是让平台把「窗口很旧」误读成「任务没有更早的历史」。
   */
  pruneEvents(
    sessionId: string,
    opts: { maxEvents: number; tenantId?: string } = { maxEvents: 0 },
  ): { removed: number; prunedThrough: number } {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT;
    const keep = Math.max(0, Math.floor(opts.maxEvents));
    const floor = this.getPrunedThrough(sessionId, tenantId);
    if (keep <= 0) return { removed: 0, prunedThrough: floor };
    const count = Number(
      (
        this.db
          .prepare('SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND session_id = ?')
          .get(tenantId, sessionId) as { n: number }
      ).n,
    );
    if (count <= keep) return { removed: 0, prunedThrough: floor };
    const cutoffRow = this.db
      .prepare(
        `SELECT event_seq FROM events WHERE tenant_id = ? AND session_id = ?
          ORDER BY event_seq DESC LIMIT 1 OFFSET ?`,
      )
      .get(tenantId, sessionId, keep) as { event_seq: number } | undefined;
    if (!cutoffRow) return { removed: 0, prunedThrough: floor };
    const cutoff = Math.max(cutoffRow.event_seq, floor);
    const tx = this.db.transaction(() => {
      const res = this.db
        .prepare('DELETE FROM events WHERE tenant_id = ? AND session_id = ? AND event_seq <= ?')
        .run(tenantId, sessionId, cutoff);
      this.db
        .prepare(
          `INSERT INTO event_prunes (tenant_id, session_id, pruned_through, removed, pruned_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, session_id) DO UPDATE SET
             pruned_through = MAX(event_prunes.pruned_through, excluded.pruned_through),
             removed = event_prunes.removed + excluded.removed,
             pruned_at = excluded.pruned_at`,
        )
        .run(tenantId, sessionId, cutoff, res.changes, now());
      return res.changes;
    });
    return { removed: tx(), prunedThrough: cutoff };
  }

  // ─────────────────────────────────────────────────────────────────
  // per-task 有界 canonical feed（2.9 / 3.9）
  //
  // 语义分层（与平台的契约）：
  //  - 分类上限（message/step/artifact）：类型交错时产生**窗口内** gap（reason=count）；
  //  - 字节预算（单任务 / 全局）：从最旧删起，删除构成前缀时推进 prunedThrough
  //    （get_task 游标 < 水位 → session_history_pruned），窗口内缺号仍然只用 gaps 表达；
  //  - 保护行：每会话最新终态 task_status 与每会话最新一条事件绝不淘汰；
  //    pending 交互在独立表，天然不受影响。
  // ─────────────────────────────────────────────────────────────────

  private feedEnabled(): boolean {
    const f = this.feed;
    return f.maxMessages > 0 || f.maxSteps > 0 || f.maxArtifacts > 0 || f.taskMaxBytes > 0 || f.globalMaxBytes > 0;
  }

  /** appendEvent 后同步执行：分类上限 + 单任务字节。预算失败不影响写入（下次写入重试）。 */
  private enforceFeedBudgets(sessionId: string, tenantId: string): void {
    if (!this.feedEnabled()) return;
    try {
      const limits: Array<[string, number]> = [
        ['task_message', this.feed.maxMessages],
        ['task_step', this.feed.maxSteps],
        ['task_artifact', this.feed.maxArtifacts],
      ];
      for (const [type, max] of limits) {
        if (max <= 0) continue;
        const count = Number(
          (
            this.db
              .prepare(
                'SELECT COUNT(*) AS n FROM events WHERE tenant_id = ? AND session_id = ? AND type = ?',
              )
              .get(tenantId, sessionId, type) as { n: number }
          ).n,
        );
        if (count <= max) continue;
        const victims = (
          this.db
            .prepare(
              `SELECT event_seq FROM events WHERE tenant_id = ? AND session_id = ? AND type = ?
                 ORDER BY event_seq LIMIT ?`,
            )
            .all(tenantId, sessionId, type, count - max) as Array<{ event_seq: number }>
        ).map((row) => row.event_seq);
        this.deleteEventsAndRecordGap(sessionId, tenantId, victims, 'count');
      }
      if (this.feed.taskMaxBytes > 0) this.enforceSessionByteBudget(sessionId, tenantId);
    } catch {
      /* 预算执行失败不影响写入：下次 append 会再检查 */
    }
  }

  /**
   * 单任务字节预算：payload 总字节（UTF-8）超限时从最旧事件删起。
   * 保护行（最新终态 task_status、该会话最新一条事件）即使仍在超限也不删 ——
   * 预算的目的是防时间线无限膨胀，不是把会话删成空集。
   */
  private enforceSessionByteBudget(sessionId: string, tenantId: string): void {
    const total = this.sessionPayloadBytes(sessionId, tenantId);
    if (total <= this.feed.taskMaxBytes) return;
    const protectedSeqs = new Set<number>();
    const statusRow = this.db
      .prepare(
        `SELECT MAX(event_seq) AS n FROM events
           WHERE tenant_id = ? AND session_id = ? AND type = 'task_status'`,
      )
      .get(tenantId, sessionId) as { n: number | null };
    if (statusRow.n !== null) protectedSeqs.add(statusRow.n);
    const latestRow = this.db
      .prepare(
        'SELECT MAX(event_seq) AS n FROM events WHERE tenant_id = ? AND session_id = ?',
      )
      .get(tenantId, sessionId) as { n: number | null };
    if (latestRow.n !== null) protectedSeqs.add(latestRow.n);

    const rows = this.db
      .prepare(
        `SELECT event_seq, LENGTH(CAST(payload AS BLOB)) AS bytes FROM events
           WHERE tenant_id = ? AND session_id = ? ORDER BY event_seq`,
      )
      .all(tenantId, sessionId) as Array<{ event_seq: number; bytes: number }>;
    let running = total;
    const victims: number[] = [];
    for (const row of rows) {
      if (running <= this.feed.taskMaxBytes) break;
      if (protectedSeqs.has(row.event_seq)) continue;
      victims.push(row.event_seq);
      running -= row.bytes;
    }
    if (victims.length > 0) this.deleteEventsAndRecordGap(sessionId, tenantId, victims, 'task_bytes');
  }

  /**
   * 进程全局字节预算：从**全局最旧**（created_at, tenant, session, seq）删起，
   * 同样保护各会话最新终态与最新一条。
   *
   * 生产路径是**惰性**的（appendEvent 里每会话每 64 条检查一次，全库 SUM 摊销亚毫秒）；
   * 公开为方法是为了运维/测试显式收口（例如清理后手动压一次水位）。
   */
  enforceGlobalFeedBytes(): void {
    const total = Number(
      (this.db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS n FROM events').get() as {
        n: number;
      }).n,
    );
    if (total <= this.feed.globalMaxBytes) return;
    const protectedKeys = new Set<string>();
    for (const row of this.db
      .prepare(
        `SELECT tenant_id, session_id, MAX(event_seq) AS n FROM events GROUP BY tenant_id, session_id`,
      )
      .all() as Array<{ tenant_id: string; session_id: string; n: number }>) {
      protectedKeys.add(`${row.tenant_id}\u0000${row.session_id}\u0000${row.n}`);
    }
    for (const row of this.db
      .prepare(
        `SELECT tenant_id, session_id, MAX(event_seq) AS n FROM events
           WHERE type = 'task_status' GROUP BY tenant_id, session_id`,
      )
      .all() as Array<{ tenant_id: string; session_id: string; n: number }>) {
      protectedKeys.add(`${row.tenant_id}\u0000${row.session_id}\u0000${row.n}`);
    }

    const rows = this.db
      .prepare(
        `SELECT tenant_id, session_id, event_seq, LENGTH(CAST(payload AS BLOB)) AS bytes FROM events
           ORDER BY created_at, tenant_id, session_id, event_seq`,
      )
      .all() as Array<{ tenant_id: string; session_id: string; event_seq: number; bytes: number }>;
    let running = total;
    const bySession = new Map<string, number[]>();
    for (const row of rows) {
      if (running <= this.feed.globalMaxBytes) break;
      if (protectedKeys.has(`${row.tenant_id}\u0000${row.session_id}\u0000${row.event_seq}`)) continue;
      const key = `${row.tenant_id}\u0000${row.session_id}`;
      const list = bySession.get(key) ?? [];
      list.push(row.event_seq);
      bySession.set(key, list);
      running -= row.bytes;
    }
    for (const [key, seqs] of bySession) {
      const sep = key.indexOf('\u0000');
      const tenantId = key.slice(0, sep);
      const sessionId = key.slice(sep + 1);
      this.deleteEventsAndRecordGap(sessionId, tenantId, seqs, 'global_bytes');
    }
  }

  private sessionPayloadBytes(sessionId: string, tenantId: string): number {
    return Number(
      (
        this.db
          .prepare(
            `SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))), 0) AS n FROM events
               WHERE tenant_id = ? AND session_id = ?`,
          )
          .get(tenantId, sessionId) as { n: number }
      ).n,
    );
  }

  /**
   * 删除事件并显式记录 gap 区间（reason），随后推进连续前缀水位。
   * 区间记「本次删除的最小/最大 seq」：eventGaps 扫描出的缺号与之**相交**即取 reason，
   * 相邻批次不合并（匹配语义不依赖端点重合）。
   */
  private deleteEventsAndRecordGap(
    sessionId: string,
    tenantId: string,
    seqs: number[],
    reason: 'count' | 'task_bytes' | 'global_bytes',
  ): void {
    if (seqs.length === 0) return;
    const min = Math.min(...seqs);
    const max = Math.max(...seqs);
    const tx = this.db.transaction(() => {
      const placeholders = seqs.map(() => '?').join(',');
      const res = this.db
        .prepare(
          `DELETE FROM events WHERE tenant_id = ? AND session_id = ? AND event_seq IN (${placeholders})`,
        )
        .run(tenantId, sessionId, ...seqs);
      this.db
        .prepare(
          `INSERT INTO feed_gaps (tenant_id, session_id, from_seq, to_seq, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, session_id, from_seq, to_seq) DO UPDATE SET reason = excluded.reason`,
        )
        .run(tenantId, sessionId, min, max, reason, now());
      this.advancePruneFloor(sessionId, tenantId);
      return res.changes;
    });
    tx();
  }

  /**
   * 重算连续前缀水位：删除后从 floor+1 起的最小现存序号 minRow，
   * [floor+1 .. minRow-1] 全空即可把水位推进到 minRow-1。
   * 事件全删时不推进 —— 发号取 max(MAX(event_seq)=0, floor)+1 = floor+1，天然不会撞历史。
   */
  private advancePruneFloor(sessionId: string, tenantId: string): void {
    const floor = this.getPrunedThrough(sessionId, tenantId);
    const minRow = this.db
      .prepare(
        'SELECT MIN(event_seq) AS n FROM events WHERE tenant_id = ? AND session_id = ?',
      )
      .get(tenantId, sessionId) as { n: number | null };
    if (minRow.n === null || minRow.n <= floor + 1) return;
    const cutoff = minRow.n - 1;
    this.db
      .prepare(
        `INSERT INTO event_prunes (tenant_id, session_id, pruned_through, removed, pruned_at)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (tenant_id, session_id) DO UPDATE SET
           pruned_through = MAX(event_prunes.pruned_through, excluded.pruned_through),
           pruned_at = excluded.pruned_at`,
      )
      .run(tenantId, sessionId, cutoff, now());
  }

  createTurn(input: {
    sessionId: string;
    turnId?: string;
    tenantId?: string;
    status?: TurnStatus;
    startedAt?: string;
    enqueuedAt?: string;
    execution?: TurnExecutionSnapshot;
  }): TurnRecord {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    if (!this.getSession(input.sessionId, tenantId)) {
      throw new SessionStoreError('session_not_found', `会话不存在：${input.sessionId}`);
    }
    const turnId = input.turnId ?? `tn_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const ordinal = Number(
      (
        this.db
          .prepare(
            'SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM turns WHERE tenant_id = ? AND session_id = ?',
          )
          .get(tenantId, input.sessionId) as { next: number }
      ).next,
    );
    const turn: TurnRecord = {
      tenantId,
      sessionId: input.sessionId,
      turnId,
      ordinal,
      status: input.status ?? 'queued',
      startedAt: input.startedAt,
      enqueuedAt: input.enqueuedAt ?? now(),
      execution: input.execution,
    };
    this.db
      .prepare(
        `INSERT INTO turns
          (tenant_id, session_id, turn_id, ordinal, status, started_at, enqueued_at, execution_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        input.sessionId,
        turnId,
        ordinal,
        turn.status,
        turn.startedAt ?? null,
        turn.enqueuedAt ?? null,
        turn.execution === undefined ? null : JSON.stringify(turn.execution),
      );
    return turn;
  }

  updateTurn(
    sessionId: string,
    turnId: string,
    patch: Partial<Pick<TurnRecord, 'status' | 'stopReason' | 'startedAt' | 'finishedAt'>>,
    tenantId = DEFAULT_TENANT,
  ): TurnRecord {
    const current = this.getTurn(sessionId, turnId, tenantId);
    if (!current) throw new SessionStoreError('turn_not_found', `Turn 不存在：${turnId}`);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE turns SET status = ?, stop_reason = ?, started_at = ?, finished_at = ?
          WHERE tenant_id = ? AND session_id = ? AND turn_id = ?`,
      )
      .run(
        next.status,
        next.stopReason ?? null,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        tenantId,
        sessionId,
        turnId,
      );
    return next;
  }

  getTurn(sessionId: string, turnId: string, tenantId = DEFAULT_TENANT): TurnRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM turns WHERE tenant_id = ? AND session_id = ? AND turn_id = ?')
      .get(tenantId, sessionId, turnId) as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  listTurns(sessionId: string, tenantId = DEFAULT_TENANT): TurnRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM turns WHERE tenant_id = ? AND session_id = ? ORDER BY ordinal')
      .all(tenantId, sessionId) as TurnRow[];
    return rows.map(toTurn);
  }

  getActiveTurn(sessionId: string, tenantId = DEFAULT_TENANT): TurnRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM turns
          WHERE tenant_id = ? AND session_id = ? AND status IN ('queued','running')
          ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(tenantId, sessionId) as TurnRow | undefined;
    return row ? toTurn(row) : undefined;
  }

  /** spawn 前的持久化闸门：只有仍为 queued 的 Turn 能进入 running；失败则绝不启动 CLI。 */
  claimTurnForLaunch(sessionId: string, turnId: string, tenantId = DEFAULT_TENANT): boolean {
    const result = this.db
      .prepare(
        `UPDATE turns SET status = 'running', started_at = ?
          WHERE tenant_id = ? AND session_id = ? AND turn_id = ? AND status = 'queued'`,
      )
      .run(now(), tenantId, sessionId, turnId);
    return result.changes === 1;
  }

  listQueuedTurns(tenantId?: string): TurnRecord[] {
    const rows = tenantId === undefined
      ? this.db.prepare(
          `SELECT * FROM turns WHERE status = 'queued' ORDER BY enqueued_at, session_id, ordinal`,
        ).all() as TurnRow[]
      : this.db.prepare(
          `SELECT * FROM turns WHERE tenant_id = ? AND status = 'queued'
            ORDER BY enqueued_at, session_id, ordinal`,
        ).all(tenantId) as TurnRow[];
    return rows.map(toTurn);
  }

  appendEvent(input: {
    sessionId: string;
    type: string;
    payload: unknown;
    eventSeq?: number;
    tenantId?: string;
    createdAt?: string;
  }): SessionEvent {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    if (!this.getSession(input.sessionId, tenantId)) {
      throw new SessionStoreError('session_not_found', `会话不存在：${input.sessionId}`);
    }
    if (!input.type.trim()) throw new SessionStoreError('invalid_input', 'event type 不能为空');
    const tx = this.db.transaction(() => {
      const maxSeq = Number(
        (
          this.db
            .prepare(
              'SELECT COALESCE(MAX(event_seq), 0) AS n FROM events WHERE tenant_id = ? AND session_id = ?',
            )
            .get(tenantId, input.sessionId) as { n: number }
        ).n,
      );
      // 下界必须考虑已裁剪水位：事件被裁光后 MAX 会退回 0，不设下界就会从 1 重新发号撞上历史
      const floor = this.getPrunedThrough(input.sessionId, tenantId);
      const nextSeq = input.eventSeq ?? Math.max(maxSeq, floor) + 1;
      if (!Number.isInteger(nextSeq) || nextSeq <= 0) {
        throw new SessionStoreError('invalid_input', `eventSeq 非法：${String(nextSeq)}`);
      }
      const existing = this.db
        .prepare('SELECT * FROM events WHERE tenant_id = ? AND session_id = ? AND event_seq = ?')
        .get(tenantId, input.sessionId, nextSeq) as EventRow | undefined;
      if (existing) {
        const parsed = toEvent(existing);
        if (parsed.type !== input.type || JSON.stringify(parsed.payload) !== JSON.stringify(input.payload)) {
          throw new SessionStoreError('event_conflict', `eventSeq ${nextSeq} 已存在且内容不同`);
        }
        return parsed;
      }
      const event: SessionEvent = {
        tenantId,
        sessionId: input.sessionId,
        eventSeq: nextSeq,
        type: input.type,
        payload: input.payload,
        createdAt: input.createdAt ?? now(),
      };
      this.db
        .prepare(
          `INSERT INTO events (tenant_id, session_id, event_seq, type, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          input.sessionId,
          event.eventSeq,
          event.type,
          JSON.stringify(event.payload),
          event.createdAt,
        );
      this.db
        .prepare('UPDATE sessions SET updated_at = ? WHERE tenant_id = ? AND session_id = ?')
        .run(event.createdAt, tenantId, input.sessionId);
      return event;
    });
    const event = tx();
    // per-task 有界 feed：分类上限 + 单任务字节每条同步执行（行数受预算约束，检查开销有界）；
    // 全局字节按 64 条粒度惰性检查（全库 SUM 摊销亚毫秒）。
    this.enforceFeedBudgets(input.sessionId, tenantId);
    if (this.feed.globalMaxBytes > 0 && event.eventSeq % 64 === 0) {
      try {
        this.enforceGlobalFeedBytes();
      } catch {
        /* 同 retention：裁剪失败不影响写入 */
      }
    }
    // 惰性 retention：每 100 条检查一次，避免每条事件都跑一次 DELETE
    if (this.retentionMaxEvents > 0 && event.eventSeq % 100 === 0) {
      try {
        this.pruneEvents(input.sessionId, {
          maxEvents: this.retentionMaxEvents,
          tenantId,
        });
      } catch {
        /* 裁剪失败不能影响写入：下个百条会再试 */
      }
    }
    return event;
  }

  /** 某类事件的最新持久快照；终态幂等重放必须读 SQLite，而不是依赖内存句柄是否已清理。 */
  getLatestEvent(sessionId: string, type: string, tenantId = DEFAULT_TENANT): SessionEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
          WHERE tenant_id = ? AND session_id = ? AND type = ?
          ORDER BY event_seq DESC LIMIT 1`,
      )
      .get(tenantId, sessionId, type) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  /** 指定 artifact 的首次/原 canonical 事件；重放旧 transfer 不得借用同 Session 最新附件的 eventSeq。 */
  getArtifactEvent(sessionId: string, artifactId: string, tenantId = DEFAULT_TENANT): SessionEvent | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM events
          WHERE tenant_id = ? AND session_id = ? AND type = 'task_artifact'
            AND json_extract(payload, '$.artifactId') = ?
          ORDER BY event_seq LIMIT 1`,
      )
      .get(tenantId, sessionId, artifactId) as EventRow | undefined;
    return row ? toEvent(row) : undefined;
  }

  listEvents(
    sessionId: string,
    opts: {
      afterEventSeq?: number;
      beforeEventSeq?: number;
      limit?: number;
      tenantId?: string;
    } = {},
  ): SessionEvent[] {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT;
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
    if (opts.beforeEventSeq !== undefined) {
      // 回翻：先取 `< before` 里最新的 limit 条，再翻回升序 —— 平台按 eventSeq 顺序追加即可
      const before = Math.max(0, Math.floor(opts.beforeEventSeq));
      const rows = this.db
        .prepare(
          `SELECT * FROM events WHERE tenant_id = ? AND session_id = ? AND event_seq < ?
            ORDER BY event_seq DESC LIMIT ?`,
        )
        .all(tenantId, sessionId, before, limit) as EventRow[];
      return rows.reverse().map(toEvent);
    }
    const after = Math.max(0, Math.floor(opts.afterEventSeq ?? 0));
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE tenant_id = ? AND session_id = ? AND event_seq > ?
          ORDER BY event_seq LIMIT ?`,
      )
      .all(tenantId, sessionId, after, limit) as EventRow[];
    return rows.map(toEvent);
  }

  appendMessage(input: {
    sessionId: string;
    messageId: string;
    role: 'user' | 'agent' | 'system';
    text: string;
    turnId?: string;
    tenantId?: string;
  }): { message: MessageRecord; duplicate: boolean } {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    if (!this.getSession(input.sessionId, tenantId)) {
      throw new SessionStoreError('session_not_found', `会话不存在：${input.sessionId}`);
    }
    const existing = this.getMessage(input.sessionId, input.messageId, tenantId);
    if (existing) {
      if (existing.text !== input.text || existing.role !== input.role) {
        throw new SessionStoreError('session_conflict', `messageId 已存在且内容不同：${input.messageId}`);
      }
      return { message: existing, duplicate: true };
    }
    const tx = this.db.transaction(() => {
      const event = this.appendEvent({
        sessionId: input.sessionId,
        tenantId,
        type: 'task_message',
        payload: {
          messageId: input.messageId,
          role: input.role,
          state: 'complete',
          text: input.text,
          turnId: input.turnId,
        },
      });
      const message: MessageRecord = {
        tenantId,
        sessionId: input.sessionId,
        messageId: input.messageId,
        turnId: input.turnId,
        eventSeq: event.eventSeq,
        role: input.role,
        text: input.text,
        createdAt: event.createdAt,
      };
      this.db
        .prepare(
          `INSERT INTO messages
             (tenant_id, session_id, message_id, turn_id, event_seq, role, text, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          input.sessionId,
          message.messageId,
          message.turnId ?? null,
          message.eventSeq,
          message.role,
          message.text,
          message.createdAt,
        );
      return { message, duplicate: false };
    });
    return tx();
  }

  getMessage(sessionId: string, messageId: string, tenantId = DEFAULT_TENANT): MessageRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM messages WHERE tenant_id = ? AND session_id = ? AND message_id = ?',
      )
      .get(tenantId, sessionId, messageId) as MessageRow | undefined;
    return row ? toMessage(row) : undefined;
  }

  listMessages(sessionId: string, tenantId = DEFAULT_TENANT): MessageRecord[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM messages WHERE tenant_id = ? AND session_id = ? ORDER BY event_seq',
      )
      .all(tenantId, sessionId) as MessageRow[];
    return rows.map(toMessage);
  }

  eventWindow(sessionId: string, tenantId = DEFAULT_TENANT): { oldest?: number; latest?: number } {
    const row = this.db
      .prepare(
        'SELECT MIN(event_seq) AS oldest, MAX(event_seq) AS latest FROM events WHERE tenant_id = ? AND session_id = ?',
      )
      .get(tenantId, sessionId) as { oldest: number | null; latest: number | null };
    return { oldest: row.oldest ?? undefined, latest: row.latest ?? undefined };
  }

  /**
   * 事件序号缺口（1.0 `eventWindow.gaps`）：retention 或写入失败造成的缺号必须**显式**告诉平台，
   * 否则补洞方会以为「拿到连续窗口」而静默丢内容。空数组 = 完整。
   *
   * `reason`（2.9/3.9）：缺口与 feed_gaps 记录的淘汰区间**相交**时给出淘汰原因
   * （count / task_bytes / global_bytes）；写入失败等无记录来源的缺口不带该字段。
   * 前缀删除不产生窗口内缺口 —— 那由 prunedThrough / session_history_pruned 语义表达。
   */
  eventGaps(
    sessionId: string,
    tenantId = DEFAULT_TENANT,
  ): Array<{ from: number; to: number; reason?: 'count' | 'task_bytes' | 'global_bytes' }> {
    const rows = this.db
      .prepare(
        `SELECT prev + 1 AS gap_from, event_seq - 1 AS gap_to FROM (
           SELECT event_seq, LAG(event_seq) OVER (ORDER BY event_seq) AS prev
             FROM events WHERE tenant_id = ? AND session_id = ?
         ) WHERE prev IS NOT NULL AND event_seq > prev + 1`,
      )
      .all(tenantId, sessionId) as Array<{ gap_from: number; gap_to: number }>;
    if (rows.length === 0) return [];
    const recorded = this.db
      .prepare(
        'SELECT from_seq, to_seq, reason FROM feed_gaps WHERE tenant_id = ? AND session_id = ?',
      )
      .all(tenantId, sessionId) as Array<{ from_seq: number; to_seq: number; reason: string }>;
    return rows.map((row) => {
      const hit = recorded.find(
        (g) => g.from_seq <= row.gap_to && g.to_seq >= row.gap_from,
      );
      const reason = hit?.reason as 'count' | 'task_bytes' | 'global_bytes' | undefined;
      return reason
        ? { from: row.gap_from, to: row.gap_to, reason }
        : { from: row.gap_from, to: row.gap_to };
    });
  }

  requestInteraction(input: {
    sessionId: string;
    requestId: string;
    kind: InteractionKind;
    payload: unknown;
    turnId?: string;
    expiresAt?: string;
    tenantId?: string;
  }): InteractionRecord {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    if (!this.getSession(input.sessionId, tenantId)) {
      throw new SessionStoreError('session_not_found', `会话不存在：${input.sessionId}`);
    }
    // auth-url 的完整 URL 可能含一次性 token，只能进 InteractionUrlVault，不能进 SQLite/snapshot。
    if (input.kind === 'auth-url' && containsUrlKey(input.payload)) {
      throw new SessionStoreError(
        'invalid_input',
        'auth-url payload 不得包含 url；请使用 InteractionUrlVault.register()',
      );
    }
    const record: InteractionRecord = {
      tenantId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      turnId: input.turnId,
      kind: input.kind,
      state: 'pending',
      payload: input.payload,
      expiresAt: input.expiresAt,
      createdAt: now(),
    };
    this.db
      .prepare(
        `INSERT INTO interactions
           (tenant_id, session_id, request_id, turn_id, kind, state, payload, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        record.sessionId,
        record.requestId,
        record.turnId ?? null,
        record.kind,
        record.state,
        JSON.stringify(record.payload),
        record.expiresAt ?? null,
        record.createdAt,
      );
    return record;
  }

  /** pending 与 request 事件同事务创建，并保存可重放的 eventSeq。 */
  openInteraction(input: {
    sessionId: string;
    requestId: string;
    kind: InteractionKind;
    payload: unknown;
    turnId?: string;
    expiresAt?: string;
    tenantId?: string;
  }): { interaction: InteractionRecord; event: SessionEvent } {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const tx = this.db.transaction(() => {
      const interaction = this.requestInteraction({ ...input, tenantId });
      const event = this.appendEvent({
        sessionId: input.sessionId,
        tenantId,
        type: 'task_interaction_request',
        payload: {
          requestId: input.requestId,
          kind: input.kind,
          payload: input.payload,
          expiresAt: input.expiresAt,
        },
      });
      this.db
        .prepare(
          `UPDATE interactions SET request_event_seq = ?
            WHERE tenant_id = ? AND session_id = ? AND request_id = ?`,
        )
        .run(event.eventSeq, tenantId, input.sessionId, input.requestId);
      return { interaction: this.getInteraction(input.sessionId, input.requestId, tenantId)!, event };
    });
    return tx();
  }

  /** 原子占据交互交付 flight；只有 pending 能进入 submitting，调用方随后才可 await adapter。 */
  beginInteractionResponse(input: {
    sessionId: string;
    requestId: string;
    responseId: string;
    responseFingerprint: string;
    tenantId?: string;
  }): InteractionRecord {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const result = this.db
      .prepare(
        `UPDATE interactions SET state = 'submitting', response_id = ?, response_fingerprint = ?
          WHERE tenant_id = ? AND session_id = ? AND request_id = ? AND state = 'pending'`,
      )
      .run(input.responseId, input.responseFingerprint, tenantId, input.sessionId, input.requestId);
    if (result.changes !== 1) {
      throw new SessionStoreError('session_conflict', `交互不在 pending：${input.requestId}`);
    }
    return this.getInteraction(input.sessionId, input.requestId, tenantId) as InteractionRecord;
  }

  resolveInteraction(input: {
    sessionId: string;
    requestId: string;
    state: InteractionState;
    responseId?: string;
    resultSeq?: number;
    resultPayload?: unknown;
    tenantId?: string;
  }): InteractionRecord {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const current = this.getInteraction(input.sessionId, input.requestId, tenantId);
    if (!current) throw new SessionStoreError('interaction_not_found', `交互不存在：${input.requestId}`);
    const resolvable = current.state === 'pending' || current.state === 'submitting';
    if (!resolvable && current.responseId === input.responseId) return current;
    if (!resolvable) {
      throw new SessionStoreError('session_conflict', `交互已结算：${input.requestId}`);
    }
    this.db
      .prepare(
        `UPDATE interactions
            SET state = ?, response_id = ?, result_seq = ?, result_payload = ?
          WHERE tenant_id = ? AND session_id = ? AND request_id = ?`,
      )
      .run(
        input.state,
        input.responseId ?? null,
        input.resultSeq ?? null,
        input.resultPayload === undefined ? null : JSON.stringify(input.resultPayload),
        tenantId,
        input.sessionId,
        input.requestId,
      );
    return this.getInteraction(input.sessionId, input.requestId, tenantId) as InteractionRecord;
  }

  /** 在一个事务内追加响应 occurrence、分配独立 resultSeq 并更新请求投影；不写 canonical events。 */
  recordInteractionResult(input: {
    sessionId: string;
    requestId: string;
    tenantId?: string;
    responseId?: string;
    responseFingerprint?: string;
    responseAnchor?: boolean;
    requestState: InteractionRequestState;
    responseStatus?: InteractionResponseStatus;
    state: 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';
    resolution?: Record<string, unknown>;
    errorCode?: string;
    at?: string;
    transition?: {
      state: InteractionState;
      responseId?: string;
      responseFingerprint?: string;
      resolvedFingerprint?: string;
      resolution?: Record<string, unknown>;
      resultPayload?: unknown;
    };
  }): InteractionResultRecord {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const tx = this.db.transaction(() => {
      const current = this.getInteraction(input.sessionId, input.requestId, tenantId);
      if (!current) throw new SessionStoreError('interaction_not_found', `交互不存在：${input.requestId}`);
      if (input.responseAnchor && input.responseId) {
        const anchor = this.getInteractionResponseAnchor(
          input.sessionId,
          input.requestId,
          input.responseId,
          tenantId,
        );
        if (anchor) throw new SessionStoreError('session_conflict', `responseId 已有锚点：${input.responseId}`);
      }
      const resultSeq = Number(
        (
          this.db
            .prepare(
              `SELECT COALESCE(MAX(result_seq), 0) AS n FROM interaction_results
                WHERE tenant_id = ? AND session_id = ? AND request_id = ?`,
            )
            .get(tenantId, input.sessionId, input.requestId) as { n: number }
        ).n,
      ) + 1;
      const at = input.at ?? now();
      this.db
        .prepare(
          `INSERT INTO interaction_results
            (tenant_id, session_id, request_id, result_seq, response_id, response_fingerprint,
             response_anchor, request_state, response_status, state, resolution, error_code, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tenantId,
          input.sessionId,
          input.requestId,
          resultSeq,
          input.responseId ?? null,
          input.responseFingerprint ?? null,
          input.responseAnchor ? 1 : 0,
          input.requestState,
          input.responseStatus ?? null,
          input.state,
          input.resolution === undefined ? null : JSON.stringify(input.resolution),
          input.errorCode ?? null,
          at,
        );
      const transition = input.transition;
      const resultPayload = transition?.resultPayload ?? input.resolution ?? current.resultPayload ?? null;
      this.db
        .prepare(
          `UPDATE interactions SET state = ?, response_id = ?, response_fingerprint = ?,
             resolved_fingerprint = ?, resolution = ?, result_seq = ?, result_payload = ?
            WHERE tenant_id = ? AND session_id = ? AND request_id = ?`,
        )
        .run(
          transition?.state ?? current.state,
          transition?.responseId ?? current.responseId ?? null,
          transition?.responseFingerprint ?? current.responseFingerprint ?? null,
          transition?.resolvedFingerprint ?? current.resolvedFingerprint ?? null,
          transition?.resolution === undefined
            ? current.resolution === undefined
              ? null
              : JSON.stringify(current.resolution)
            : JSON.stringify(transition.resolution),
          resultSeq,
          resultPayload === null ? null : JSON.stringify(resultPayload),
          tenantId,
          input.sessionId,
          input.requestId,
        );
      const row = this.db
        .prepare(
          `SELECT * FROM interaction_results
            WHERE tenant_id = ? AND session_id = ? AND request_id = ? AND result_seq = ?`,
        )
        .get(tenantId, input.sessionId, input.requestId, resultSeq) as InteractionResultRow;
      return toInteractionResult(row);
    });
    return tx();
  }

  /** 按 responseId+规范化指纹找首次 occurrence，包含 conflict/duplicate，避免冲突重放不断增号。 */
  getInteractionResponseReceipt(
    sessionId: string,
    requestId: string,
    responseId: string,
    responseFingerprint: string,
    tenantId = DEFAULT_TENANT,
  ): InteractionResultRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM interaction_results
          WHERE tenant_id = ? AND session_id = ? AND request_id = ? AND response_id = ? AND response_fingerprint = ?
          ORDER BY result_seq LIMIT 1`,
      )
      .get(tenantId, sessionId, requestId, responseId, responseFingerprint) as InteractionResultRow | undefined;
    return row ? toInteractionResult(row) : undefined;
  }

  getInteractionResponseAnchor(
    sessionId: string,
    requestId: string,
    responseId: string,
    tenantId = DEFAULT_TENANT,
  ): InteractionResultRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM interaction_results
          WHERE tenant_id = ? AND session_id = ? AND request_id = ? AND response_id = ? AND response_anchor = 1`,
      )
      .get(tenantId, sessionId, requestId, responseId) as InteractionResultRow | undefined;
    return row ? toInteractionResult(row) : undefined;
  }

  listLatestInteractionResults(sessionId: string, tenantId = DEFAULT_TENANT): InteractionResultRecord[] {
    const rows = this.db
      .prepare(
        `SELECT r.* FROM interaction_results r
          JOIN (
            SELECT request_id, MAX(result_seq) AS latest FROM interaction_results
             WHERE tenant_id = ? AND session_id = ? GROUP BY request_id
          ) latest ON latest.request_id = r.request_id AND latest.latest = r.result_seq
          WHERE r.tenant_id = ? AND r.session_id = ? ORDER BY r.request_id`,
      )
      .all(tenantId, sessionId, tenantId, sessionId) as InteractionResultRow[];
    return rows.map(toInteractionResult);
  }

  getInteraction(
    sessionId: string,
    requestId: string,
    tenantId = DEFAULT_TENANT,
  ): InteractionRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM interactions WHERE tenant_id = ? AND session_id = ? AND request_id = ?',
      )
      .get(tenantId, sessionId, requestId) as InteractionRow | undefined;
    return row ? toInteraction(row) : undefined;
  }

  /**
   * 按租户有界列交互（控制面 `/v1/interactions` 用）。
   *
   * `state=pending` 是最常见的用法（「现在有哪些问题在等我回答」），所以按 created_at 倒序、
   * 上限 200 条 —— 交互永远是有界的小集合，不需要分页游标。
   */
  queryInteractions(input: {
    tenantId?: string;
    sessionId?: string;
    state?: InteractionState;
    limit?: number;
  } = {}): InteractionRecord[] {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
    const where: string[] = ['tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (input.sessionId) {
      where.push('session_id = ?');
      params.push(input.sessionId);
    }
    if (input.state) {
      where.push('state = ?');
      params.push(input.state);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM interactions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...params, limit) as InteractionRow[];
    return rows.map(toInteraction);
  }

  /**
   * 只凭 requestId 反查交互（`POST /v1/interactions/{requestId}:respond` 的路径里没有 taskId）。
   *
   * requestId 只在 session 内唯一，理论上可能撞；取最新一条（同一 requestId 的重放会落在同一条上，
   * 因为 requestInteraction 用 (tenant,session,request) 做主键）。
   */
  findInteractionByRequestId(
    requestId: string,
    tenantId = DEFAULT_TENANT,
  ): InteractionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM interactions
          WHERE tenant_id = ? AND request_id = ?
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(tenantId, requestId) as InteractionRow | undefined;
    return row ? toInteraction(row) : undefined;
  }

  // ---------- 通用幂等（HTTP operation/Idempotency-Key） ----------

  /**
   * 在同一 SQLite 事务内执行业务写入并保存回执。回调不得 await/spawn/访问网络。
   * 同 key 同指纹返回原结果；不同指纹 fail closed，绝不再次执行业务回调。
   */
  runIdempotent<T>(input: {
    tenantId: string;
    scope: string;
    key: string;
    fingerprint: string;
  }, write: () => T): { value: T; replay: boolean } {
    const tx = this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM idempotency WHERE tenant_id = ? AND scope = ? AND key = ?')
        .get(input.tenantId, input.scope, input.key) as
        | { fingerprint: string; result: string }
        | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) {
          throw new SessionStoreError('idempotency_conflict', `幂等键内容冲突：${input.key}`);
        }
        return { value: parseJson(existing.result) as T, replay: true };
      }
      const value = write();
      this.db
        .prepare(
          `INSERT INTO idempotency (tenant_id, scope, key, fingerprint, result, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.tenantId, input.scope, input.key, input.fingerprint, JSON.stringify(value), now());
      return { value, replay: false };
    });
    return tx();
  }

  // ---------- 持久授权账本（approvals） ----------

  /**
   * 写入一条持久授权。同指纹重复授权时**覆盖旧记录**（重新计时并清除撤销标记），
   * 否则用户「先撤销、再允许一次」会被历史记录反噬。
   */
  addApproval(input: Omit<ApprovalRecord, 'createdAt' | 'revokedAt'> & { createdAt?: string }): ApprovalRecord {
    const createdAt = input.createdAt ?? now();
    this.db
      .prepare(
        `INSERT INTO approvals
           (tenant_id, approval_id, principal_id, agent_type, tool, action, resource, scope,
            fingerprint, expires_at, created_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (tenant_id, approval_id) DO UPDATE SET
           expires_at = excluded.expires_at,
           created_at = excluded.created_at,
           revoked_at = NULL`,
      )
      .run(
        input.tenantId,
        input.approvalId,
        input.principalId,
        input.agentType,
        input.tool,
        input.action,
        input.resource,
        input.scope,
        input.fingerprint,
        input.expiresAt ?? null,
        createdAt,
      );
    const saved = this.getApproval(input.tenantId, input.approvalId);
    if (!saved) throw new SessionStoreError('session_conflict', `授权写入失败：${input.approvalId}`);
    return saved;
  }

  getApproval(tenantId: string, approvalId: string): ApprovalRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM approvals WHERE tenant_id = ? AND approval_id = ?')
      .get(tenantId, approvalId) as ApprovalRow | undefined;
    return row ? toApproval(row) : undefined;
  }

  /**
   * 按指纹找一条可用授权（未撤销、未过期）。
   * 返回最近的到期时间那条：多条同指纹时以最新的为准。
   */
  findApproval(
    tenantId: string,
    agentType: string,
    fingerprint: string,
    at: number = Date.now(),
  ): ApprovalRecord | undefined {
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals
          WHERE tenant_id = ? AND agent_type = ? AND fingerprint = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .all(tenantId, agentType, fingerprint) as ApprovalRow[];
    for (const row of rows) {
      const rec = toApproval(row);
      if (!rec.expiresAt || Date.parse(rec.expiresAt) > at) return rec;
    }
    return undefined;
  }

  listApprovals(tenantId = DEFAULT_TENANT, includeRevoked = false): ApprovalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM approvals WHERE tenant_id = ?${includeRevoked ? '' : ' AND revoked_at IS NULL'}
         ORDER BY created_at DESC`,
      )
      .all(tenantId) as ApprovalRow[];
    return rows.map(toApproval);
  }

  /** 撤销：只置 revoked_at，不删行 —— 审计要能回溯「曾经授权过什么」 */
  revokeApproval(tenantId: string, approvalId: string, at: string = now()): boolean {
    const res = this.db
      .prepare(
        'UPDATE approvals SET revoked_at = ? WHERE tenant_id = ? AND approval_id = ? AND revoked_at IS NULL',
      )
      .run(at, tenantId, approvalId);
    return res.changes > 0;
  }

  /** 清理过期记录（保留撤销记录，它们本身是审计线索） */
  purgeExpiredApprovals(tenantId = DEFAULT_TENANT, at: number = Date.now()): number {
    const cutoff = new Date(at).toISOString();
    const res = this.db
      .prepare(
        'DELETE FROM approvals WHERE tenant_id = ? AND expires_at IS NOT NULL AND expires_at <= ? AND revoked_at IS NULL',
      )
      .run(tenantId, cutoff);
    return res.changes;
  }

  putArtifact(input: Omit<ArtifactRecord, 'createdAt'> & { createdAt?: string }): ArtifactRecord {
    if (!this.getSession(input.sessionId, input.tenantId)) {
      throw new SessionStoreError('session_not_found', `会话不存在：${input.sessionId}`);
    }
    const artifact: ArtifactRecord = {
      ...input,
      createdAt: input.createdAt ?? now(),
    };
    this.db
      .prepare(
        `INSERT INTO artifacts
           (tenant_id, artifact_id, session_id, name, mime_type, size, sha256, kind, storage_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, artifact_id) DO NOTHING`,
      )
      .run(
        artifact.tenantId,
        artifact.artifactId,
        artifact.sessionId,
        artifact.name,
        artifact.mimeType,
        artifact.size,
        artifact.sha256,
        artifact.kind,
        artifact.storageKey,
        artifact.createdAt,
      );
    return this.getArtifact(artifact.artifactId, artifact.tenantId) ?? artifact;
  }

  /** Artifact + canonical event + committed transfer 同事务提交，供 complete 故障后安全重试。 */
  commitArtifact(
    input: Omit<ArtifactRecord, 'createdAt'> & { createdAt?: string },
    transferId: string,
  ): { artifact: ArtifactRecord; event: SessionEvent } {
    const tx = this.db.transaction(() => {
      const transfer = this.getTransfer(transferId, input.tenantId);
      if (!transfer) throw new SessionStoreError('artifact_not_found', `传输不存在：${transferId}`);
      const artifact = this.putArtifact(input);
      const event = this.appendEvent({
        sessionId: artifact.sessionId,
        tenantId: artifact.tenantId,
        type: 'task_artifact',
        payload: {
          artifactId: artifact.artifactId,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
          sha256: artifact.sha256,
          kind: artifact.kind,
        },
      });
      this.saveTransfer({ ...transfer, state: 'committed', tempPath: undefined, nextOffset: artifact.size });
      return { artifact, event };
    });
    return tx();
  }

  saveTransfer(
    input: Omit<ArtifactTransferRecord, 'createdAt' | 'updatedAt'> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): ArtifactTransferRecord {
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    const at = new Date().toISOString();
    const record: ArtifactTransferRecord = {
      ...input,
      tenantId,
      createdAt: input.createdAt ?? at,
      updatedAt: input.updatedAt ?? at,
    };
    this.db
      .prepare(
        `INSERT INTO artifact_transfers
           (tenant_id, transfer_id, session_id, operation_id, artifact_id, direction, name, mime_type,
            size, sha256, chunk_size, next_offset, temp_path, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, transfer_id) DO UPDATE SET
           next_offset = excluded.next_offset,
           temp_path = excluded.temp_path,
           state = excluded.state,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.tenantId,
        record.transferId,
        record.sessionId,
        record.operationId,
        record.artifactId,
        record.direction,
        record.name,
        record.mimeType,
        record.size,
        record.sha256,
        record.chunkSize,
        record.nextOffset,
        record.tempPath ?? null,
        record.state,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  getTransfer(transferId: string, tenantId = DEFAULT_TENANT): ArtifactTransferRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM artifact_transfers WHERE tenant_id = ? AND transfer_id = ?')
      .get(tenantId, transferId) as ArtifactTransferRow | undefined;
    return row ? toTransfer(row) : undefined;
  }

  getTransferByOperation(
    sessionId: string,
    operationId: string,
    tenantId = DEFAULT_TENANT,
  ): ArtifactTransferRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM artifact_transfers WHERE tenant_id = ? AND session_id = ? AND operation_id = ?',
      )
      .get(tenantId, sessionId, operationId) as ArtifactTransferRow | undefined;
    return row ? toTransfer(row) : undefined;
  }

  updateTransferOffset(transferId: string, nextOffset: number, tenantId = DEFAULT_TENANT): void {
    this.db
      .prepare(
        `UPDATE artifact_transfers
            SET next_offset = ?, updated_at = ?
          WHERE tenant_id = ? AND transfer_id = ?`,
      )
      .run(nextOffset, new Date().toISOString(), tenantId, transferId);
  }

  deleteTransfer(transferId: string, tenantId = DEFAULT_TENANT): void {
    this.db
      .prepare('DELETE FROM artifact_transfers WHERE tenant_id = ? AND transfer_id = ?')
      .run(tenantId, transferId);
  }

  listTransfers(
    state?: ArtifactTransferState,
    tenantId = DEFAULT_TENANT,
  ): ArtifactTransferRecord[] {
    const rows = state
      ? (this.db
          .prepare(
            'SELECT * FROM artifact_transfers WHERE tenant_id = ? AND state = ? ORDER BY updated_at',
          )
          .all(tenantId, state) as ArtifactTransferRow[])
      : (this.db
          .prepare('SELECT * FROM artifact_transfers WHERE tenant_id = ? ORDER BY updated_at')
          .all(tenantId) as ArtifactTransferRow[]);
    return rows.map(toTransfer);
  }

  getArtifact(artifactId: string, tenantId = DEFAULT_TENANT): ArtifactRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE tenant_id = ? AND artifact_id = ?')
      .get(tenantId, artifactId) as ArtifactRow | undefined;
    return row ? toArtifact(row) : undefined;
  }

  listAllArtifacts(tenantId = DEFAULT_TENANT): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE tenant_id = ? ORDER BY created_at')
      .all(tenantId) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  deleteArtifact(artifactId: string, tenantId = DEFAULT_TENANT): void {
    this.db
      .prepare('DELETE FROM artifacts WHERE tenant_id = ? AND artifact_id = ?')
      .run(tenantId, artifactId);
  }

  listArtifacts(sessionId: string, tenantId = DEFAULT_TENANT): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE tenant_id = ? AND session_id = ? ORDER BY created_at')
      .all(tenantId, sessionId) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  snapshot(
    sessionId: string,
    opts: {
      afterEventSeq?: number;
      beforeEventSeq?: number;
      limit?: number;
      tenantId?: string;
    } = {},
  ): SessionSnapshot {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT;
    const session = this.getSession(sessionId, tenantId);
    if (!session) throw new SessionStoreError('session_not_found', `会话不存在：${sessionId}`);
    const window = this.eventWindow(sessionId, tenantId);
    // 无游标 = 「我要的是现在的样子」，取最新一页而不是最早一页：
    // 长会话的头 200 条对平台毫无用处，反而会让它以为任务停在那里（latestEventSeq 才是真进度）。
    // 想从头读就显式给 afterEventSeq: 0 —— 三种组合各司其职，不留模糊地带。
    const events =
      opts.afterEventSeq === undefined && opts.beforeEventSeq === undefined
        ? this.listEvents(sessionId, {
            beforeEventSeq: Number.MAX_SAFE_INTEGER,
            limit: opts.limit,
            tenantId,
          })
        : this.listEvents(sessionId, { ...opts, tenantId });
    const first = events[0]?.eventSeq;
    return {
      session,
      turns: this.listTurns(sessionId, tenantId),
      events,
      interactions: this.listInteractions(sessionId, tenantId),
      artifacts: this.listArtifacts(sessionId, tenantId),
      oldestEventSeq: window.oldest,
      latestEventSeq: window.latest,
      // 窗口最旧一条之前还有没有内容 —— 回翻控制器据此决定要不要继续往前取
      hasMoreBefore:
        first === undefined ? false : window.oldest !== undefined && first > window.oldest,
      prunedThrough: this.getPrunedThrough(sessionId, tenantId),
    };
  }

  listInteractions(sessionId: string, tenantId = DEFAULT_TENANT): InteractionRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM interactions WHERE tenant_id = ? AND session_id = ? ORDER BY created_at')
      .all(tenantId, sessionId) as InteractionRow[];
    return rows.map(toInteraction);
  }

  markActiveTurnsInterrupted(sessionId: string, tenantId = DEFAULT_TENANT): number {
    const at = now();
    const result = this.db
      .prepare(
        `UPDATE turns SET status = 'failed', stop_reason = 'session_interrupted', finished_at = ?
          WHERE tenant_id = ? AND session_id = ? AND status = 'running'`,
      )
      .run(at, tenantId, sessionId);
    this.db
      .prepare(
        `UPDATE sessions SET
           phase = CASE
             WHEN EXISTS (SELECT 1 FROM turns q WHERE q.tenant_id = sessions.tenant_id
                          AND q.session_id = sessions.session_id AND q.status = 'queued') THEN 'queued'
             WHEN mode = 'conversation' THEN 'waiting_user' ELSE 'settled' END,
           status = CASE
             WHEN EXISTS (SELECT 1 FROM turns q WHERE q.tenant_id = sessions.tenant_id
                          AND q.session_id = sessions.session_id AND q.status = 'queued') THEN 'running'
             WHEN mode = 'conversation' THEN 'running' ELSE 'failed' END,
           closed_at = CASE WHEN mode = 'task' AND NOT EXISTS (
             SELECT 1 FROM turns q WHERE q.tenant_id = sessions.tenant_id
             AND q.session_id = sessions.session_id AND q.status = 'queued') THEN ? ELSE closed_at END,
           updated_at = ?
         WHERE tenant_id = ? AND session_id = ?`,
      )
      .run(at, at, tenantId, sessionId);
    return result.changes;
  }

  /** 恢复所有遗留开放交互；结果只写 occurrence 表，绝不在终态后追加 canonical feed。 */
  private recoverOpenInteractions(sessionId: string, tenantId: string): void {
    for (const interaction of this.listInteractions(sessionId, tenantId)) {
      if (interaction.state !== 'pending' && interaction.state !== 'submitting') continue;
      const submitting = interaction.state === 'submitting';
      const expired = !submitting && interaction.expiresAt !== undefined && Date.parse(interaction.expiresAt) <= Date.now();
      const requestState = submitting ? 'failed' : expired ? 'expired' : 'cancelled';
      const resolution = submitting
        ? { errorCode: 'interaction_delivery_unknown' }
        : { reason: 'session_interrupted' };
      this.recordInteractionResult({
        sessionId,
        tenantId,
        requestId: interaction.requestId,
        responseId: interaction.responseId,
        responseFingerprint: interaction.responseFingerprint,
        responseAnchor: submitting,
        requestState,
        responseStatus: submitting ? 'invalid' : undefined,
        state: submitting ? 'failed' : expired ? 'expired' : 'cancelled',
        resolution,
        errorCode: submitting ? 'interaction_delivery_unknown' : expired ? 'interaction_expired' : 'cancelled',
        transition: {
          state: requestState,
          responseId: interaction.responseId,
          responseFingerprint: interaction.responseFingerprint,
          resolution,
          resultPayload: resolution,
        },
      });
    }
  }

  /**
   * 进程启动时的一次性恢复：上一进程留下的 running Session 不能假装还在跑。
   * task 模式直接落 failed + tombstone；conversation 保留历史并进入 waiting_user。
   */
  recoverInterrupted(tenantId?: string): number {
    let recovered = 0;
    const sessions = tenantId === undefined ? this.listAllSessions() : this.listSessions(tenantId);
    for (const session of sessions) {
      const active = session.status === 'running' && session.phase !== 'waiting_user';
      const hadRunning = this.listTurns(session.sessionId, session.tenantId).some((turn) => turn.status === 'running');
      const hasOpenInteraction = this.listInteractions(session.sessionId, session.tenantId).some(
        (interaction) => interaction.state === 'pending' || interaction.state === 'submitting',
      );
      if (!active && !hasOpenInteraction) continue;
      const tx = this.db.transaction(() => {
        if (active) this.markActiveTurnsInterrupted(session.sessionId, session.tenantId);
        this.recoverOpenInteractions(session.sessionId, session.tenantId);
        if (!active || !hadRunning) return;
        this.appendEvent({
          sessionId: session.sessionId,
          tenantId: session.tenantId,
          type: 'session_interrupted',
          payload: { previousPhase: session.phase, at: now() },
        });
        const hasQueued = this.listTurns(session.sessionId, session.tenantId).some((turn) => turn.status === 'queued');
        if (session.mode === 'task' && !hasQueued) {
          this.closeSession(session.sessionId, 'failed', 'session_interrupted', session.tenantId);
        }
        recovered += 1;
      });
      tx();
    }
    return recovered;
  }
}

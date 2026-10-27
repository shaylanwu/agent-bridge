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
import type { InteractionKind } from '../protocol.js';
import type { ApprovalRecord } from './permission-ledger.js';

export type SessionMode = 'task' | 'conversation';
export type SessionPhase = 'queued' | 'running' | 'waiting_interaction' | 'waiting_user' | 'settled';
export type SessionTerminalStatus = 'success' | 'failed' | 'cancelled' | 'timeout';
export type SessionStatus = 'running' | SessionTerminalStatus;
export type TurnStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';
// 交互种类是 wire 语义（平台按它决定渲染），真源在 protocol；这里只做同值转出，避免两处漂移
export type { InteractionKind };
export type InteractionState = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';

const SCHEMA_VERSION = 4;
export const DEFAULT_TENANT = 'default';

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

export interface TurnRecord {
  tenantId: string;
  sessionId: string;
  turnId: string;
  ordinal: number;
  status: TurnStatus;
  stopReason?: string;
  startedAt?: string;
  finishedAt?: string;
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
  payload: unknown;
  expiresAt?: string;
  responseId?: string;
  resultSeq?: number;
  resultPayload?: unknown;
  createdAt: string;
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
  payload: string;
  expires_at: string | null;
  response_id: string | null;
  result_seq: number | null;
  result_payload: string | null;
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
    payload: parseJson(row.payload),
    expiresAt: row.expires_at ?? undefined,
    responseId: row.response_id ?? undefined,
    resultSeq: row.result_seq ?? undefined,
    resultPayload: row.result_payload ? parseJson(row.result_payload) : undefined,
    createdAt: row.created_at,
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

export class SessionStore {
  private readonly db: Database.Database;
  /** 单会话事件保留上限（0 = 不裁剪） */
  private readonly retentionMaxEvents: number;
  private closed = false;

  /**
   * @param options.retentionMaxEvents 单会话事件保留上限（0/缺省 = 不裁剪）。
   *   裁剪是**惰性**的：每写入 100 条检查一次，不做定时任务 —— 长会话不必等进程重启才瘦身，
   *   也不会因为每条事件都跑一次 DELETE 把热路径拖慢。
   */
  constructor(
    dbPath: string,
    options: { retentionMaxEvents?: number } = {},
  ) {
    this.retentionMaxEvents = Math.max(0, Math.floor(options.retentionMaxEvents ?? 0));
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    const opened = new Database(dbPath);
    this.db = opened;
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
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

  private migrate(): void {
    const current = Number(this.db.pragma('user_version', { simple: true }) ?? 0);
    if (current >= SCHEMA_VERSION) return;
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
        payload TEXT NOT NULL,
        expires_at TEXT,
        response_id TEXT,
        result_seq INTEGER,
        result_payload TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, session_id, request_id),
        FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE
      );
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

  createTurn(input: {
    sessionId: string;
    turnId?: string;
    tenantId?: string;
    status?: TurnStatus;
    startedAt?: string;
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
    };
    this.db
      .prepare(
        `INSERT INTO turns (tenant_id, session_id, turn_id, ordinal, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(tenantId, input.sessionId, turnId, ordinal, turn.status, turn.startedAt ?? null);
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
   */
  eventGaps(sessionId: string, tenantId = DEFAULT_TENANT): Array<{ from: number; to: number }> {
    const rows = this.db
      .prepare(
        `SELECT prev + 1 AS gap_from, event_seq - 1 AS gap_to FROM (
           SELECT event_seq, LAG(event_seq) OVER (ORDER BY event_seq) AS prev
             FROM events WHERE tenant_id = ? AND session_id = ?
         ) WHERE prev IS NOT NULL AND event_seq > prev + 1`,
      )
      .all(tenantId, sessionId) as Array<{ gap_from: number; gap_to: number }>;
    return rows.map((row) => ({ from: row.gap_from, to: row.gap_to }));
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
    if (current.state !== 'pending' && current.responseId === input.responseId) return current;
    if (current.state !== 'pending') {
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
          WHERE tenant_id = ? AND session_id = ? AND status IN ('queued','running')`,
      )
      .run(at, tenantId, sessionId);
    this.db
      .prepare(
        `UPDATE sessions SET phase = CASE WHEN mode = 'conversation' THEN 'waiting_user' ELSE 'settled' END,
           status = CASE WHEN mode = 'conversation' THEN 'running' ELSE 'failed' END,
           closed_at = CASE WHEN mode = 'conversation' THEN closed_at ELSE ? END,
           updated_at = ?
         WHERE tenant_id = ? AND session_id = ?`,
      )
      .run(at, at, tenantId, sessionId);
    return result.changes;
  }

  /**
   * 进程启动时的一次性恢复：上一进程留下的 running Session 不能假装还在跑。
   * task 模式直接落 failed + tombstone；conversation 保留历史并进入 waiting_user。
   */
  recoverInterrupted(tenantId = DEFAULT_TENANT): number {
    let recovered = 0;
    for (const session of this.listSessions(tenantId)) {
      if (session.status !== 'running' || session.phase === 'waiting_user') continue;
      const tx = this.db.transaction(() => {
        this.markActiveTurnsInterrupted(session.sessionId, tenantId);
        this.appendEvent({
          sessionId: session.sessionId,
          tenantId,
          type: 'session_interrupted',
          payload: { previousPhase: session.phase, at: now() },
        });
        if (session.mode === 'task') {
          this.closeSession(session.sessionId, 'failed', 'session_interrupted', tenantId);
        }
        recovered += 1;
      });
      tx();
    }
    return recovered;
  }
}

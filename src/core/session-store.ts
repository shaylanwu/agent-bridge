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

export type SessionMode = 'task' | 'conversation';
export type SessionPhase = 'queued' | 'running' | 'waiting_interaction' | 'waiting_user' | 'settled';
export type SessionTerminalStatus = 'success' | 'failed' | 'cancelled' | 'timeout';
export type SessionStatus = 'running' | SessionTerminalStatus;
export type TurnStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout';
export type InteractionKind = 'permission' | 'form' | 'auth-url';
export type InteractionState = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';

const SCHEMA_VERSION = 2;
const DEFAULT_TENANT = 'default';

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

export interface SessionSnapshot {
  session: SessionRecord;
  turns: TurnRecord[];
  events: SessionEvent[];
  interactions: InteractionRecord[];
  artifacts: ArtifactRecord[];
  oldestEventSeq?: number;
  latestEventSeq?: number;
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

const now = (): string => new Date().toISOString();

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
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
  private closed = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.migrate();
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
      createdAt: at,
      updatedAt: at,
    };
    this.db
      .prepare(
        `INSERT INTO sessions
           (tenant_id, session_id, context_id, mode, status, phase, agent_type, cwd, permission_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    patch: Partial<Pick<SessionRecord, 'status' | 'phase' | 'permissionMode' | 'closedAt'>>,
    tenantId = DEFAULT_TENANT,
  ): SessionRecord {
    const current = this.getSession(sessionId, tenantId);
    if (!current) throw new SessionStoreError('session_not_found', `会话不存在：${sessionId}`);
    const next = { ...current, ...patch, updatedAt: now() };
    this.db
      .prepare(
        `UPDATE sessions
            SET status = ?, phase = ?, permission_mode = ?, closed_at = ?, updated_at = ?
          WHERE tenant_id = ? AND session_id = ?`,
      )
      .run(
        next.status,
        next.phase,
        next.permissionMode ?? null,
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
      const nextSeq =
        input.eventSeq ??
        Number(
          (
            this.db
              .prepare(
                'SELECT COALESCE(MAX(event_seq), 0) + 1 AS next FROM events WHERE tenant_id = ? AND session_id = ?',
              )
              .get(tenantId, input.sessionId) as { next: number }
          ).next,
        );
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
    return tx();
  }

  listEvents(
    sessionId: string,
    opts: { afterEventSeq?: number; limit?: number; tenantId?: string } = {},
  ): SessionEvent[] {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT;
    const after = Math.max(0, Math.floor(opts.afterEventSeq ?? 0));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 200)));
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

  getArtifact(artifactId: string, tenantId = DEFAULT_TENANT): ArtifactRecord | undefined {
    const row = this.db
      .prepare('SELECT * FROM artifacts WHERE tenant_id = ? AND artifact_id = ?')
      .get(tenantId, artifactId) as ArtifactRow | undefined;
    return row ? toArtifact(row) : undefined;
  }

  listArtifacts(sessionId: string, tenantId = DEFAULT_TENANT): ArtifactRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM artifacts WHERE tenant_id = ? AND session_id = ? ORDER BY created_at')
      .all(tenantId, sessionId) as ArtifactRow[];
    return rows.map(toArtifact);
  }

  snapshot(
    sessionId: string,
    opts: { afterEventSeq?: number; limit?: number; tenantId?: string } = {},
  ): SessionSnapshot {
    const tenantId = opts.tenantId ?? DEFAULT_TENANT;
    const session = this.getSession(sessionId, tenantId);
    if (!session) throw new SessionStoreError('session_not_found', `会话不存在：${sessionId}`);
    const window = this.eventWindow(sessionId, tenantId);
    return {
      session,
      turns: this.listTurns(sessionId, tenantId),
      events: this.listEvents(sessionId, { ...opts, tenantId }),
      interactions: this.listInteractions(sessionId, tenantId),
      artifacts: this.listArtifacts(sessionId, tenantId),
      oldestEventSeq: window.oldest,
      latestEventSeq: window.latest,
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

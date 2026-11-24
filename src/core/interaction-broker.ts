import { createHash } from 'node:crypto';
import type {
  ClientMessage,
  InteractionRequestState,
  InteractionResponseCommand,
  InteractionResponseStatus,
} from '../protocol.js';
import { validateFormContent } from './form-schema.js';
import { fullResidualPermissionOutcome } from './permission-policy.js';
import type {
  InteractionRecord,
  InteractionResultRecord,
  SessionStore,
} from './session-store.js';
import type { InteractionAnswer } from './task-supervisor.js';

/** interaction.payload 里的 options 数组（结构宽松解析；无则空） */
export function interactionPayloadOptions(payload: unknown): Array<Record<string, unknown>> | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const raw = (payload as Record<string, unknown>)['options'];
  if (!Array.isArray(raw)) return undefined;
  return raw.filter(
    (option): option is Record<string, unknown> => typeof option === 'object' && option !== null,
  );
}

export interface InteractionOutcome {
  ok: boolean;
  state?: 'accepted' | 'declined' | 'cancelled' | 'expired';
  responseId?: string;
  resultSeq?: number;
  errorCode?: string;
  /** 仅本进程首次交付失败时为 true；重放 failed occurrence 不得再次取消任务。 */
  deliveryFailed?: boolean;
  /** 仅创建且完成本进程实际交付的调用为 true；共享 flight/重放均为 false。 */
  deliveredNow?: boolean;
  result?: Extract<ClientMessage, { type: 'task_interaction_result' }>;
}

interface BrokerBinding {
  store: SessionStore;
  emit: (msg: ClientMessage) => void;
  deliver: (taskId: string, requestId: string, answer?: InteractionAnswer) => Promise<boolean>;
  defaultTimeoutMs?: number;
  /** result 已落库并上行后，才恢复/失败对应 supervisor Entry。 */
  onResolved?: (taskId: string, requestId: string) => void;
  onFailed?: (taskId: string, requestId: string) => void;
  /**
   * 交互等待到期且以 cancelled outcome 完成请求后触发（无 reject_once 可选的路径）：
   * 按 spec「等待状态、超时与取消」，supervisor 应取消回合并以 interaction_timeout 结算。
   * 有 reject_once 的超时按其原 optionId 拒绝、回合继续，走 onResolved 恢复。
   */
  onExpired?: (taskId: string, requestId: string) => void;
}

interface NormalizedResponse {
  fingerprint: string;
  answer: InteractionAnswer;
  resolution: Record<string, unknown>;
  invalid?: boolean;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

export function fingerprintInteractionResponse(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function asRequestState(record: InteractionRecord): InteractionRequestState {
  return record.state === 'accepted' || record.state === 'declined' ? 'resolved' : record.state;
}

/** 每个 TaskSupervisor 持有一个实例；SQLite 管状态，内存只管当前进程的交付 Promise。 */
export class InteractionBroker {
  private binding?: BrokerBinding;
  private readonly flights = new Map<string, Promise<InteractionOutcome>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  get isBound(): boolean {
    return this.binding !== undefined;
  }

  bind(binding: BrokerBinding): void {
    if (this.binding) throw new Error('InteractionBroker 已绑定');
    this.binding = binding;
  }

  private deps(): BrokerBinding {
    if (!this.binding) throw new Error('InteractionBroker 尚未绑定 SessionStore/Emitter');
    return this.binding;
  }

  open(input: {
    sessionId: string;
    requestId: string;
    kind: InteractionRecord['kind'];
    payload: unknown;
    turnId?: string;
    expiresAt?: string;
    tenantId?: string;
  }): InteractionRecord {
    const { store, emit } = this.deps();
    const existing = store
      .listInteractions(input.sessionId, input.tenantId)
      .find((item) => item.state === 'pending' || item.state === 'submitting');
    if (existing) throw new Error(`每会话只能有一个开放交互：${existing.requestId}`);
    const expiresAt = input.expiresAt ??
      (this.deps().defaultTimeoutMs
        ? new Date(Date.now() + this.deps().defaultTimeoutMs!).toISOString()
        : undefined);
    const { interaction, event } = store.openInteraction({ ...input, expiresAt });
    emit({
      type: 'task_interaction_request',
      taskId: input.sessionId,
      requestId: input.requestId,
      turnId: input.turnId,
      kind: input.kind,
      payload: input.payload as Record<string, unknown>,
      expiresAt,
      eventSeq: event.eventSeq,
    });
    if (expiresAt) {
      const key = `${interaction.tenantId}\0${interaction.sessionId}\0${interaction.requestId}`;
      const timer = setTimeout(() => {
        this.timers.delete(key);
        void this.expire(interaction);
      }, Math.max(0, Date.parse(expiresAt) - Date.now()));
      this.timers.set(key, timer);
    }
    return interaction;
  }

  private normalize(record: InteractionRecord, msg: InteractionResponseCommand): NormalizedResponse {
    const payload = msg.payload ?? {};
    if (record.kind === 'permission') {
      const explicitOption =
        typeof payload['optionId'] === 'string'
          ? payload['optionId']
          : typeof payload['option_id'] === 'string'
            ? payload['option_id']
            : undefined;
      const rawOptions = record.payload && typeof record.payload === 'object'
        ? (record.payload as Record<string, unknown>)['options']
        : undefined;
      const options = Array.isArray(rawOptions)
        ? rawOptions.filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null)
        : [];
      const accepted = msg.state === 'accepted';
      const invalid = accepted && (!explicitOption || !options.some((option) => option['optionId'] === explicitOption));
      const outcome = accepted
        ? { outcome: 'selected', optionId: explicitOption }
        : { outcome: 'cancelled' };
      return {
        fingerprint: fingerprintInteractionResponse({ kind: record.kind, outcome }),
        answer: { optionId: accepted ? explicitOption : undefined, action: accepted ? 'accept' : msg.state === 'declined' ? 'decline' : 'cancel' },
        resolution: accepted ? { state: msg.state, optionId: explicitOption } : { state: msg.state },
        invalid,
      };
    }
    const content = typeof payload['content'] === 'object' && payload['content'] !== null
      ? payload['content'] as Record<string, unknown>
      : undefined;
    const action = msg.state === 'accepted' ? 'accept' : msg.state === 'declined' ? 'decline' : 'cancel';
    const schema = record.payload && typeof record.payload === 'object'
      ? (record.payload as Record<string, unknown>)['requestedSchema']
      : undefined;
    const invalid = action === 'accept' && Boolean(validateFormContent(
      schema && typeof schema === 'object' ? schema as Record<string, unknown> : {},
      content ?? {},
    ));
    return {
      fingerprint: fingerprintInteractionResponse({ kind: record.kind, action, ...(action === 'accept' ? { content: content ?? {} } : {}) }),
      answer: { action, ...(action === 'accept' ? { content: content ?? {} } : {}) },
      resolution: {
        action,
        ...(action === 'accept' ? { fieldNames: Object.keys(content ?? {}).sort() } : {}),
      },
      invalid,
    };
  }

  private toMessage(record: InteractionResultRecord): Extract<ClientMessage, { type: 'task_interaction_result' }> {
    return {
      type: 'task_interaction_result',
      taskId: record.sessionId,
      requestId: record.requestId,
      state: record.state,
      requestState: record.requestState,
      responseStatus: record.responseStatus,
      responseId: record.responseId,
      resultSeq: record.resultSeq,
      resolution: record.resolution,
      resultPayload: record.resolution,
      errorCode: record.errorCode,
      at: record.at,
    };
  }

  private emit(record: InteractionResultRecord): InteractionOutcome {
    const result = this.toMessage(record);
    this.deps().emit(result);
    const ok = record.responseStatus === 'accepted' || record.responseStatus === 'duplicate';
    return {
      ok,
      ...(record.state !== 'failed' ? { state: record.state } : {}),
      responseId: record.responseId,
      resultSeq: record.resultSeq,
      errorCode: record.errorCode,
      result,
    };
  }

  private record(
    interaction: InteractionRecord,
    input: {
      responseId?: string;
      responseFingerprint?: string;
      responseAnchor?: boolean;
      responseStatus?: InteractionResponseStatus;
      state: 'accepted' | 'declined' | 'cancelled' | 'expired' | 'failed';
      requestState?: InteractionRequestState;
      resolution?: Record<string, unknown>;
      errorCode?: string;
      transition?: Parameters<SessionStore['recordInteractionResult']>[0]['transition'];
    },
  ): InteractionOutcome {
    const result = this.deps().store.recordInteractionResult({
      sessionId: interaction.sessionId,
      requestId: interaction.requestId,
      tenantId: interaction.tenantId,
      responseId: input.responseId,
      responseFingerprint: input.responseFingerprint,
      responseAnchor: input.responseAnchor,
      requestState: input.requestState ?? asRequestState(interaction),
      responseStatus: input.responseStatus,
      state: input.state,
      resolution: input.resolution,
      errorCode: input.errorCode,
      transition: input.transition,
    });
    if (['resolved', 'failed', 'expired', 'cancelled'].includes(result.requestState)) {
      const key = `${result.tenantId}\0${result.sessionId}\0${result.requestId}`;
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.delete(key);
    }
    const outcome = this.emit(result);
    if (result.requestState === 'resolved' && result.responseStatus === 'accepted') {
      this.deps().onResolved?.(result.sessionId, result.requestId);
    }
    if (result.requestState === 'failed' && result.errorCode === 'interaction_delivery_unknown') {
      this.deps().onFailed?.(result.sessionId, result.requestId);
    }
    return outcome;
  }

  private conflict(interaction: InteractionRecord, msg: InteractionResponseCommand, fingerprint: string, anchor: boolean): InteractionOutcome {
    return this.record(interaction, {
      responseId: msg.responseId,
      responseFingerprint: fingerprint,
      responseAnchor: anchor,
      responseStatus: 'invalid',
      state: 'failed',
      resolution: interaction.resolution,
      errorCode: 'interaction_response_conflict',
    });
  }

  respond(msg: InteractionResponseCommand): Promise<InteractionOutcome> {
    const { store } = this.deps();
    const interaction = store.getInteraction(msg.taskId, msg.requestId, msg.tenantId ?? 'default');
    if (!interaction) {
      return Promise.resolve({ ok: false, errorCode: 'interaction_not_found' });
    }
    const normalized = this.normalize(interaction, msg);
    const receipt = store.getInteractionResponseReceipt(
      msg.taskId,
      msg.requestId,
      msg.responseId,
      normalized.fingerprint,
      interaction.tenantId,
    );
    if (receipt) return Promise.resolve(this.emit(receipt));
    const anchor = store.getInteractionResponseAnchor(
      msg.taskId,
      msg.requestId,
      msg.responseId,
      interaction.tenantId,
    );
    if (anchor) {
      if (anchor.responseFingerprint === normalized.fingerprint) return Promise.resolve(this.emit(anchor));
      return Promise.resolve(this.conflict(interaction, msg, normalized.fingerprint, false));
    }

    const flightKey = `${interaction.tenantId}\0${interaction.sessionId}\0${interaction.requestId}\0${msg.responseId}`;
    const inFlight = this.flights.get(flightKey);
    if (inFlight) {
      if (interaction.responseFingerprint !== normalized.fingerprint) {
        return Promise.resolve(this.conflict(interaction, msg, normalized.fingerprint, false));
      }
      return inFlight.then((outcome) => ({ ...outcome, deliveredNow: false }));
    }

    const state = asRequestState(interaction);
    if (state === 'pending') {
      if (normalized.invalid) {
        return Promise.resolve(this.record(interaction, {
          responseId: msg.responseId,
          responseFingerprint: normalized.fingerprint,
          responseAnchor: true,
          responseStatus: 'invalid',
          state: 'failed',
          requestState: 'pending',
          errorCode: 'interaction_invalid_response',
        }));
      }
      store.beginInteractionResponse({
        sessionId: interaction.sessionId,
        requestId: interaction.requestId,
        tenantId: interaction.tenantId,
        responseId: msg.responseId,
        responseFingerprint: normalized.fingerprint,
      });
      const flight = this.deliver(interaction, msg, normalized).finally(() => this.flights.delete(flightKey));
      this.flights.set(flightKey, flight);
      return flight;
    }

    const same = (state === 'submitting' ? interaction.responseFingerprint : interaction.resolvedFingerprint) === normalized.fingerprint;
    if (state === 'submitting' || state === 'resolved') {
      return Promise.resolve(this.record(interaction, {
        responseId: msg.responseId,
        responseFingerprint: normalized.fingerprint,
        responseAnchor: true,
        responseStatus: same ? 'duplicate' : 'invalid',
        state: same ? msg.state : 'failed',
        requestState: state,
        resolution: same ? normalized.resolution : interaction.resolution,
        errorCode: same ? undefined : 'interaction_response_conflict',
      }));
    }
    if (state === 'failed') {
      return Promise.resolve(this.record(interaction, {
        responseId: msg.responseId,
        responseFingerprint: normalized.fingerprint,
        responseAnchor: true,
        responseStatus: 'invalid',
        state: 'failed',
        requestState: 'failed',
        resolution: interaction.resolution,
        errorCode: 'interaction_delivery_unknown',
      }));
    }
    return Promise.resolve(this.record(interaction, {
      responseId: msg.responseId,
      responseFingerprint: normalized.fingerprint,
      responseAnchor: true,
      responseStatus: 'late',
      state: state === 'expired' ? 'expired' : 'cancelled',
      requestState: state,
      resolution: interaction.resolution,
      errorCode: state === 'expired' ? 'interaction_expired' : 'interaction_already_resolved',
    }));
  }

  /**
   * 单次等待到期（spec「等待状态、超时与取消」）：
   *  - permission 且 options 真实提供 reject_once → 以**原 optionId** 拒绝这一次（deliver accept+optionId），
   *    回合继续，走 onResolved 恢复 supervisor Entry；
   *  - 否则（含 Form 超时映射 cancel）→ 以 cancelled outcome 完成原请求并结束回合（onExpired，
   *    调用方按 interaction_timeout 结算）；不得伪造 reject_once 或 optionId；
   *  - 交付失败 → interaction_delivery_unknown（onFailed），与响应交付失败同一条路径。
   */
  private async expire(interaction: InteractionRecord): Promise<void> {
    const current = this.deps().store.getInteraction(
      interaction.sessionId,
      interaction.requestId,
      interaction.tenantId,
    );
    if (!current || current.state !== 'pending') return;
    const answer = this.expiryAnswer(interaction);
    const delivered = await this.deps()
      .deliver(interaction.sessionId, interaction.requestId, answer)
      .catch(() => false);
    if (!delivered) {
      this.record(current, {
        responseStatus: 'invalid',
        state: 'failed',
        requestState: 'failed',
        errorCode: 'interaction_delivery_unknown',
        transition: { state: 'failed', resultPayload: { errorCode: 'interaction_delivery_unknown' } },
      });
      return;
    }
    const rejectOutcome = 'optionId' in answer ? answer : undefined;
    this.record(current, {
      state: 'expired',
      requestState: 'expired',
      resolution: rejectOutcome
        ? { reason: 'interaction_timeout', optionId: rejectOutcome.optionId }
        : { reason: 'interaction_timeout' },
      errorCode: 'interaction_expired',
      transition: {
        state: 'expired',
        resolution: rejectOutcome
          ? { reason: 'interaction_timeout', optionId: rejectOutcome.optionId }
          : { reason: 'interaction_timeout' },
        resultPayload: rejectOutcome
          ? { reason: 'interaction_timeout', optionId: rejectOutcome.optionId }
          : { reason: 'interaction_timeout' },
      },
    });
    if (rejectOutcome) this.deps().onResolved?.(current.sessionId, current.requestId);
    else this.deps().onExpired?.(current.sessionId, current.requestId);
  }

  /** 到期时应交付给 adapter 的答复：有 reject_once 选原 optionId，否则 cancel（不伪造选项）。 */
  private expiryAnswer(interaction: InteractionRecord): InteractionAnswer {
    if (interaction.kind === 'permission') {
      const outcome = fullResidualPermissionOutcome(
        interactionPayloadOptions(interaction.payload),
      );
      if ('optionId' in outcome) return { action: 'accept', optionId: outcome.optionId };
    }
    return { action: 'cancel' };
  }

  private async deliver(
    interaction: InteractionRecord,
    msg: InteractionResponseCommand,
    normalized: NormalizedResponse,
  ): Promise<InteractionOutcome> {
    let delivered = false;
    try {
      delivered = await this.deps().deliver(msg.taskId, msg.requestId, normalized.answer);
    } catch {
      delivered = false;
    }
    if (!delivered) {
      const outcome = this.record(interaction, {
        responseId: msg.responseId,
        responseFingerprint: normalized.fingerprint,
        responseAnchor: true,
        responseStatus: 'invalid',
        state: 'failed',
        requestState: 'failed',
        errorCode: 'interaction_delivery_unknown',
        transition: {
          state: 'failed',
          responseId: msg.responseId,
          responseFingerprint: normalized.fingerprint,
          resultPayload: { errorCode: 'interaction_delivery_unknown' },
        },
      });
      return { ...outcome, deliveryFailed: true };
    }
    const outcome = this.record(interaction, {
      responseId: msg.responseId,
      responseFingerprint: normalized.fingerprint,
      responseAnchor: true,
      responseStatus: 'accepted',
      state: msg.state,
      requestState: 'resolved',
      resolution: normalized.resolution,
      transition: {
        state: 'resolved',
        responseId: msg.responseId,
        responseFingerprint: normalized.fingerprint,
        resolvedFingerprint: normalized.fingerprint,
        resolution: normalized.resolution,
        resultPayload: normalized.resolution,
      },
    });
    return { ...outcome, deliveredNow: true };
  }

  /** 回合终态同步关闭开放交互，不再次调用 adapter，也不留假 pending。 */
  cancelRequest(taskId: string, tenantId: string, requestId: string): void {
    if (!this.isBound) return;
    const interaction = this.deps().store.getInteraction(taskId, requestId, tenantId);
    if (!interaction) return;
    if (interaction.state === 'pending') {
      const resolution = { reason: 'turn_cancelled' };
      this.record(interaction, {
        state: 'cancelled',
        requestState: 'cancelled',
        resolution,
        errorCode: 'cancelled',
        transition: { state: 'cancelled', resolution, resultPayload: resolution },
      });
    } else if (interaction.state === 'submitting') {
      this.record(interaction, {
        responseId: interaction.responseId,
        responseFingerprint: interaction.responseFingerprint,
        responseAnchor: true,
        responseStatus: 'invalid',
        state: 'failed',
        requestState: 'failed',
        errorCode: 'interaction_delivery_unknown',
        transition: {
          state: 'failed',
          responseId: interaction.responseId,
          responseFingerprint: interaction.responseFingerprint,
          resultPayload: { errorCode: 'interaction_delivery_unknown' },
        },
      });
    }
  }

  /** Outbox 溢出/重连后的兜底：只重放持久快照，不产生新 occurrence。 */
  replayRecoverable(): void {
    const { store } = this.deps();
    for (const session of store.listAllSessions()) {
      for (const interaction of store.listInteractions(session.sessionId, session.tenantId)) {
        if (interaction.state === 'pending' || interaction.state === 'submitting') {
          this.deps().emit({
            type: 'task_interaction_request',
            taskId: interaction.sessionId,
            requestId: interaction.requestId,
            turnId: interaction.turnId,
            kind: interaction.kind,
            payload: interaction.payload as Record<string, unknown>,
            expiresAt: interaction.expiresAt,
            eventSeq: interaction.requestEventSeq,
          });
        }
      }
      for (const result of store.listLatestInteractionResults(session.sessionId, session.tenantId)) {
        this.deps().emit(this.toMessage(result));
      }
    }
  }
}

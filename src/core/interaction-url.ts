/**
 * Interaction URL vault (1.0).
 *
 * URLs can contain one-time secrets/tokens, so they are intentionally kept out of SQLite and logs.
 * They live in this process only and expire after a short TTL; restart clears them.
 */

export interface InteractionUrlEntry {
  sessionId: string;
  requestId: string;
  url: string;
  expiresAt: string;
}

interface StoredUrl extends InteractionUrlEntry {
  expiresAtMs: number;
}

export class InteractionUrlVault {
  private readonly entries = new Map<string, StoredUrl>();

  private key(sessionId: string, requestId: string): string {
    return `${sessionId}\u0000${requestId}`;
  }

  register(
    sessionId: string,
    requestId: string,
    url: string,
    ttlMs = 5 * 60 * 1000,
    now = Date.now(),
  ): InteractionUrlEntry {
    const entry: StoredUrl = {
      sessionId,
      requestId,
      url,
      expiresAtMs: now + Math.max(1, ttlMs),
      expiresAt: new Date(now + Math.max(1, ttlMs)).toISOString(),
    };
    this.entries.set(this.key(sessionId, requestId), entry);
    return { sessionId, requestId, url, expiresAt: entry.expiresAt };
  }

  /**
   * 区分「没有」和「过期」：调用方要能回 interaction_url_expired，而不是把过期当不存在。
   * 过期项读取即删除，避免长期占内存。
   */
  lookup(
    sessionId: string,
    requestId: string,
    now = Date.now(),
  ): { entry?: InteractionUrlEntry; expired: boolean } {
    const entry = this.entries.get(this.key(sessionId, requestId));
    if (!entry) return { expired: false };
    if (entry.expiresAtMs <= now) {
      this.entries.delete(this.key(sessionId, requestId));
      return { expired: true };
    }
    return {
      entry: {
        sessionId: entry.sessionId,
        requestId: entry.requestId,
        url: entry.url,
        expiresAt: entry.expiresAt,
      },
      expired: false,
    };
  }

  get(sessionId: string, requestId: string, now = Date.now()): InteractionUrlEntry | undefined {
    return this.lookup(sessionId, requestId, now).entry;
  }

  revoke(sessionId: string, requestId: string): void {
    this.entries.delete(this.key(sessionId, requestId));
  }

  cleanup(now = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAtMs <= now) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

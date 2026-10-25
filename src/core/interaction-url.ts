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

  get(sessionId: string, requestId: string, now = Date.now()): InteractionUrlEntry | undefined {
    const entry = this.entries.get(this.key(sessionId, requestId));
    if (!entry) return undefined;
    if (entry.expiresAtMs <= now) {
      this.entries.delete(this.key(sessionId, requestId));
      return undefined;
    }
    return {
      sessionId: entry.sessionId,
      requestId: entry.requestId,
      url: entry.url,
      expiresAt: entry.expiresAt,
    };
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

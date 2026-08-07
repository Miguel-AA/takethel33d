// Login rate limiting, persisted in D1.
//
// This REPLACES the previous in-memory `Map`, which reset on every isolate
// recycle and was not shared across the isolates Cloudflare spins up — i.e. it
// was not a real defense. D1 is a single logical database for the whole
// deployment, so counters here are actually shared.
//
// Two independent buckets are counted per attempt:
//   * the normalized email  — blunts credential stuffing against one account
//   * the client IP         — blunts spraying many accounts from one source
// Both are stored as SHA-256 digests: the table never holds a raw email or a
// raw IP address.
//
// Documented limits: this is a fixed-window counter, not a token bucket, so up
// to 2x the limit can pass across a window boundary; and a distributed attack
// from many IPs is only slowed by the per-email bucket. Cloudflare Turnstile,
// WAF rate-limiting rules or a Durable Object remain the right escalation for
// a determined attacker — `LoginRateLimiter` is the seam where that would plug
// in without touching the handler.

import { nowIso, parseStoredTimestamp as parseIso } from './time';
import { hashOpaqueValue } from './tokens';
import { clientIpOf } from './requestContext';

// Re-exported so existing importers keep a single call site; the canonical
// implementation lives in requestContext.ts alongside the other request
// metadata extraction.
export { clientIpOf };

export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_RATE_MAX_ATTEMPTS = 10;

export type RateLimitBucketKind = 'email' | 'ip';

export interface RateLimitVerdict {
  limited: boolean;
  retryAfterSeconds: number;
  /** Which bucket kinds are currently exhausted. */
  limitedKinds: RateLimitBucketKind[];
}

function kindOf(bucketKey: string): RateLimitBucketKind | null {
  if (bucketKey.startsWith('email:')) return 'email';
  if (bucketKey.startsWith('ip:')) return 'ip';
  return null;
}

interface AttemptRow {
  bucket_key: string;
  attempts: number;
  window_started_at: string;
}

/** Builds the hashed bucket keys for one login attempt. */
export async function buildLoginBucketKeys(
  normalizedEmail: string,
  clientIp: string | null,
): Promise<string[]> {
  const keys = [`email:${await hashOpaqueValue(normalizedEmail)}`];
  if (clientIp) keys.push(`ip:${await hashOpaqueValue(clientIp)}`);
  return keys;
}

export class LoginRateLimiter {
  constructor(
    private readonly db: D1Database,
    private readonly windowMs: number = LOGIN_RATE_WINDOW_MS,
    private readonly maxAttempts: number = LOGIN_RATE_MAX_ATTEMPTS,
  ) {}

  /** Reports which buckets have exhausted their allowance in the current window. */
  async check(keys: string[]): Promise<RateLimitVerdict> {
    if (keys.length === 0) {
      return { limited: false, retryAfterSeconds: 0, limitedKinds: [] };
    }

    const now = Date.now();
    const placeholders = keys.map(() => '?').join(', ');
    const result = await this.db
      .prepare(
        `SELECT bucket_key, attempts, window_started_at
         FROM admin_login_attempts WHERE bucket_key IN (${placeholders})`,
      )
      .bind(...keys)
      .all<AttemptRow>();

    let retryAfterMs = 0;
    const limitedKinds = new Set<RateLimitBucketKind>();

    for (const row of result.results ?? []) {
      const startedAt = parseIso(row.window_started_at);
      if (startedAt === null) continue;
      const windowEnd = startedAt + this.windowMs;
      if (windowEnd <= now) continue; // stale window, no longer counts
      if (row.attempts < this.maxAttempts) continue;

      retryAfterMs = Math.max(retryAfterMs, windowEnd - now);
      const kind = kindOf(row.bucket_key);
      if (kind) limitedKinds.add(kind);
    }

    return {
      limited: retryAfterMs > 0,
      retryAfterSeconds: retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0,
      limitedKinds: [...limitedKinds],
    };
  }

  /** Records one failed attempt against every bucket, rolling stale windows. */
  async recordFailure(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const timestamp = nowIso();
    const cutoff = new Date(Date.now() - this.windowMs).toISOString();

    for (const key of keys) {
      await this.db
        .prepare(
          `INSERT INTO admin_login_attempts (bucket_key, attempts, window_started_at, updated_at)
           VALUES (?, 1, ?, ?)
           ON CONFLICT(bucket_key) DO UPDATE SET
             attempts = CASE
               WHEN admin_login_attempts.window_started_at < ? THEN 1
               ELSE admin_login_attempts.attempts + 1 END,
             window_started_at = CASE
               WHEN admin_login_attempts.window_started_at < ? THEN excluded.window_started_at
               ELSE admin_login_attempts.window_started_at END,
             updated_at = excluded.updated_at`,
        )
        .bind(key, timestamp, timestamp, cutoff, cutoff)
        .run();
    }
  }

  /** Clears the buckets after a successful login. */
  async reset(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const placeholders = keys.map(() => '?').join(', ');
    await this.db
      .prepare(`DELETE FROM admin_login_attempts WHERE bucket_key IN (${placeholders})`)
      .bind(...keys)
      .run();
  }

  /** Housekeeping for windows that can no longer block anyone. */
  async purgeStale(): Promise<void> {
    const cutoff = new Date(Date.now() - this.windowMs).toISOString();
    await this.db
      .prepare('DELETE FROM admin_login_attempts WHERE window_started_at < ?')
      .bind(cutoff)
      .run();
  }
}

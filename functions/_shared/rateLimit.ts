// Rate limiting, persisted in D1.
//
// Two users, one mechanism: `LoginRateLimiter` (credential stuffing) and the
// public flow's limiter (see publicRateLimit.ts) are both `PersistentRateLimiter`
// with different windows, ceilings and key shapes. The counter, the atomic
// upsert and the window rolling are written once.
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

/**
 * The longest window ANY bucket family uses.
 *
 * Housekeeping sweeps against this rather than against the sweeping limiter's
 * own window: the table is shared, and a one-minute GET limiter deleting rows
 * older than a minute would erase an hour-long email backstop that is still
 * doing its job. Raise this if a longer-lived bucket is ever added.
 */
export const RATE_LIMIT_MAX_WINDOW_MS = 60 * 60 * 1000;

/** Rows one opportunistic sweep may remove. Small enough to be unnoticeable. */
export const RATE_LIMIT_SWEEP_BATCH = 100;

/**
 * The label a bucket reports under.
 *
 * `email` and `ip` are the login flow's two kinds and the only ones its callers
 * test for. The type is widened to `string` because the public flow labels its
 * own buckets (`pub_get`, `pub_entry_ip`, …) and a closed union would force
 * every new caller to edit this file — but the login literals stay documented
 * here because `AdminAuthService` branches on them by name.
 */
export type RateLimitBucketKind = string;

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

/**
 * The fixed-window counter itself, independent of what is being counted.
 *
 * EXTRACTED, not rewritten: every line below was `LoginRateLimiter`'s, and
 * `LoginRateLimiter` is now this class with the login defaults. The public flow
 * needs the same persistence, the same atomic upsert and the same window
 * rolling with different numbers and different key shapes, and a second
 * implementation would mean a second set of race conditions to get right.
 *
 * `kindOf` is a constructor parameter rather than a hardcoded function so a
 * caller can label its own buckets. It affects REPORTING only — an unlabelled
 * bucket still counts and still blocks — so a caller cannot weaken the limiter
 * by mislabelling.
 */
export class PersistentRateLimiter {
  constructor(
    protected readonly db: D1Database,
    protected readonly windowMs: number,
    protected readonly maxAttempts: number,
    private readonly classify: (bucketKey: string) => string | null = kindOf,
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
      const kind = this.classify(row.bucket_key);
      if (kind) limitedKinds.add(kind as RateLimitBucketKind);
    }

    return {
      limited: retryAfterMs > 0,
      retryAfterSeconds: retryAfterMs > 0 ? Math.ceil(retryAfterMs / 1000) : 0,
      limitedKinds: [...limitedKinds],
    };
  }

  /**
   * Counts one attempt against every bucket, rolling stale windows.
   *
   * The upsert is atomic PER KEY — `bucket_key` is the primary key, so
   * `ON CONFLICT ... DO UPDATE` cannot lose a concurrent increment. Across
   * keys it is not atomic, and deliberately so: a failure partway through
   * leaves some buckets counted, which errs toward refusing rather than
   * admitting. The alternative, a batch, would roll every counter back on any
   * single failure — the wrong direction for a defence.
   */
  async record(keys: string[]): Promise<void> {
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

  /**
   * Counts one attempt and decides, IN ONE STATEMENT.
   *
   * THIS IS THE ONLY SAFE ADMISSION PRIMITIVE, and `check()` followed by
   * `record()` is not a substitute for it. Those are two round trips, and
   * between them every concurrent caller sees the same pre-increment count:
   * with a ceiling of 5, twenty simultaneous requests all read "0 so far" and
   * all proceed. Measured, before this existed: 20 of 20 admitted. The counter
   * was never wrong — it ended on 20 — but the DECISION had already been taken
   * twenty times.
   *
   * The upsert increments and RETURNS the resulting value, so each concurrent
   * caller gets a DIFFERENT `attempts` back and only the first `maxAttempts`
   * of them see a value within the allowance. There is no window between the
   * count and the verdict because they are the same statement.
   *
   * Refused attempts still count. That is deliberate: a throttle that stops
   * counting once it starts refusing lets an attacker hold a bucket exactly at
   * its ceiling forever, and it means hammering extends the block rather than
   * costing nothing.
   *
   * `check`/`record` remain for the login flow, which genuinely needs them
   * apart: it must verify a password between counting and deciding, and it
   * counts only FAILURES.
   */
  async consume(key: string): Promise<RateLimitVerdict> {
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const cutoff = new Date(now - this.windowMs).toISOString();

    const row = await this.db
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
           updated_at = excluded.updated_at
         RETURNING attempts, window_started_at`,
      )
      .bind(key, timestamp, timestamp, cutoff, cutoff)
      .first<{ attempts: number; window_started_at: string }>();

    if (!row) {
      // The statement always returns a row; reaching here means the driver did
      // not support RETURNING. Fail CLOSED — a limiter that cannot count must
      // not silently admit everyone.
      return {
        limited: true,
        retryAfterSeconds: Math.ceil(this.windowMs / 1000),
        limitedKinds: [this.classify(key) ?? 'unknown'],
      };
    }

    const attempts = Number(row.attempts);
    if (attempts <= this.maxAttempts) {
      return { limited: false, retryAfterSeconds: 0, limitedKinds: [] };
    }

    const startedAt = parseIso(row.window_started_at) ?? now;
    const retryAfterMs = Math.max(0, startedAt + this.windowMs - now);
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      limitedKinds: [this.classify(key) ?? 'unknown'],
    };
  }

  /**
   * Deletes a BOUNDED number of windows that can no longer block anyone.
   *
   * `purgeStale` exists but sweeps the whole table in one unbounded DELETE and
   * has no caller; that was tolerable when the only keys were login buckets,
   * whose cardinality is the number of accounts plus the number of attacking
   * addresses. The public flow changes that: every distinct address that ever
   * loads a page mints a row, so an attacker rotating source addresses grows
   * the table without limit — a persistent denial of service that outlives the
   * attack. Measured: 200 distinct addresses left 200 permanent rows.
   *
   * The cutoff is the LONGEST window any family uses, never this limiter's own.
   * A GET limiter sweeping on its one-minute window would delete an hour-long
   * email backstop that is still blocking somebody.
   *
   * Bounded by `limit` so a sweep is a small, predictable amount of work rather
   * than an unbounded scan that could stall a request.
   */
  async sweepStale(limit = RATE_LIMIT_SWEEP_BATCH): Promise<number> {
    const cutoff = new Date(Date.now() - RATE_LIMIT_MAX_WINDOW_MS).toISOString();
    const result = await this.db
      .prepare(
        `DELETE FROM admin_login_attempts
          WHERE bucket_key IN (
            SELECT bucket_key FROM admin_login_attempts
             WHERE window_started_at < ?
             LIMIT ?
          )`,
      )
      .bind(cutoff, limit)
      .run();
    return Number(result.meta?.changes ?? 0);
  }

  /** Clears the buckets — used when an attempt succeeds legitimately. */
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

/**
 * Login rate limiting.
 *
 * Now a thin specialisation of `PersistentRateLimiter`, carrying exactly the
 * window, the ceiling and the bucket labels it always had. Its public surface —
 * the class name, the constructor's optional overrides, `check`, `reset`,
 * `purgeStale` and `recordFailure` — is UNCHANGED, so `AdminAuthService` and
 * the certified login tests are untouched by the generalisation.
 */
export class LoginRateLimiter extends PersistentRateLimiter {
  constructor(
    db: D1Database,
    windowMs: number = LOGIN_RATE_WINDOW_MS,
    maxAttempts: number = LOGIN_RATE_MAX_ATTEMPTS,
  ) {
    super(db, windowMs, maxAttempts, kindOf);
  }

  /**
   * Records one FAILED login.
   *
   * Kept under its original name because that name is the contract here: the
   * login flow counts failures only, and resets the buckets on success. The
   * public flow counts every attempt instead, which is why the base method is
   * called `record`.
   */
  async recordFailure(keys: string[]): Promise<void> {
    return this.record(keys);
  }
}

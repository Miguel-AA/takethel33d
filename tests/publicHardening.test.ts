// @vitest-environment node
//
// Regressions for defects found by attacking the phase 9 implementation.
//
// Every test here failed against the code as first written. They are grouped by
// the defect they close, with the measured behaviour recorded, because "this
// used to admit twenty of twenty" is the only thing that makes the assertion
// below meaningful a year from now.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PublicRateLimiter,
  hashEmailForBucket,
} from '../functions/_shared/publicRateLimit';
import {
  LOGIN_RATE_MAX_ATTEMPTS,
  LoginRateLimiter,
  PersistentRateLimiter,
  RATE_LIMIT_MAX_WINDOW_MS,
  RATE_LIMIT_SWEEP_BATCH,
  buildLoginBucketKeys,
} from '../functions/_shared/rateLimit';
import { PublicFormTokenService, toBase64Url } from '../functions/_shared/publicFormToken';
import {
  PUBLIC_ENTRY_EMAIL_RATE_MAX,
  PUBLIC_ENTRY_IP_EMAIL_RATE_MAX,
  PUBLIC_ENTRY_IP_RATE_MAX,
  PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS,
  PUBLIC_FORM_TOKEN_TTL_SECONDS,
} from '../shared/limits';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

let db: TestDatabase;
let limiter: PublicRateLimiter;

const IP = 'a'.repeat(64);
const OTHER_IP = 'b'.repeat(64);
const EVENT = 'event-1';

beforeEach(() => {
  db = createTestDatabase();
  limiter = new PublicRateLimiter(db.d1);
});

afterEach(() => db.close());

const rows = () =>
  (db.raw.prepare('SELECT COUNT(*) AS n FROM admin_login_attempts').get() as { n: number }).n;

// ---------------------------------------------------------------------------
// DEFECT 1 — admission was decided before it was counted
// ---------------------------------------------------------------------------

describe('concurrent admission', () => {
  it('admits at most the ceiling when every caller arrives at once', async () => {
    // MEASURED BEFORE THE FIX: 20 of 20 admitted against a ceiling of 5. The
    // counter was never wrong — it ended on 20 — but `check()` and `record()`
    // are two round trips and every concurrent caller read the same
    // pre-increment value. `consume()` increments and decides in one statement.
    const verdicts = await Promise.all(
      Array.from({ length: 20 }, () => limiter.checkEntryIp(IP, EVENT)),
    );

    const admitted = verdicts.filter((verdict) => !verdict.limited).length;
    expect(admitted).toBe(PUBLIC_ENTRY_IP_RATE_MAX);
  });

  it('holds under a larger burst', async () => {
    const verdicts = await Promise.all(
      Array.from({ length: 100 }, () => limiter.checkGet(IP, EVENT)),
    );
    expect(verdicts.filter((verdict) => !verdict.limited).length).toBeLessThanOrEqual(120);
    expect(verdicts.some((verdict) => verdict.limited)).toBe(false);
  });

  it('counts refused attempts too, so hammering extends the block', async () => {
    // A throttle that stops counting at its ceiling lets an attacker sit
    // exactly on the boundary indefinitely.
    for (let i = 0; i < PUBLIC_ENTRY_IP_RATE_MAX + 10; i++) {
      await limiter.checkEntryIp(IP, EVENT);
    }
    const row = db.raw
      .prepare('SELECT attempts FROM admin_login_attempts LIMIT 1')
      .get() as { attempts: number };
    expect(row.attempts).toBe(PUBLIC_ENTRY_IP_RATE_MAX + 10);
  });

  it('every refusal carries a usable Retry-After', async () => {
    for (let i = 0; i <= PUBLIC_ENTRY_IP_RATE_MAX; i++) await limiter.checkEntryIp(IP, EVENT);
    const verdict = await limiter.checkEntryIp(IP, EVENT);

    expect(verdict.limited).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('the underlying counter loses no increment under concurrency', async () => {
    const generic = new PersistentRateLimiter(db.d1, 60_000, 1_000);
    await Promise.all(Array.from({ length: 50 }, () => generic.consume('probe:key')));

    const row = db.raw
      .prepare("SELECT attempts FROM admin_login_attempts WHERE bucket_key = 'probe:key'")
      .get() as { attempts: number };
    expect(row.attempts).toBe(50);
  });

  it('fails CLOSED if the driver cannot return the new count', async () => {
    // A limiter that cannot count must refuse, never wave everyone through.
    const blind = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    } as unknown as D1Database;

    const verdict = await new PersistentRateLimiter(blind, 60_000, 5).consume('k');
    expect(verdict.limited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 2 — omitting the client-IP header removed the limit entirely
// ---------------------------------------------------------------------------

describe('unattributable callers', () => {
  it('is still limited when the edge reports no address', async () => {
    // MEASURED BEFORE THE FIX: no bucket was created at all and the caller was
    // never limited, so "omit a header" was an unlimited-submission bypass.
    let limited = false;
    for (let i = 0; i < PUBLIC_ENTRY_IP_RATE_MAX + 5; i++) {
      if ((await limiter.checkEntryIp(null, EVENT)).limited) limited = true;
    }
    expect(limited).toBe(true);
  });

  it('shares one anonymous bucket per event, not one per request', async () => {
    for (let i = 0; i < 5; i++) await limiter.checkGet(null, EVENT);
    expect(rows()).toBe(1);
  });

  it('keeps anonymous traffic on one event away from another', async () => {
    for (let i = 0; i <= PUBLIC_ENTRY_IP_RATE_MAX + 2; i++) {
      await limiter.checkEntryIp(null, EVENT);
    }
    expect((await limiter.checkEntryIp(null, 'event-2')).limited).toBe(false);
  });

  it('does not let an unattributed caller consume an identified one’s budget', async () => {
    for (let i = 0; i <= PUBLIC_ENTRY_IP_RATE_MAX + 2; i++) {
      await limiter.checkEntryIp(null, EVENT);
    }
    expect((await limiter.checkEntryIp(IP, EVENT)).limited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 3 — the bucket table grew without bound
// ---------------------------------------------------------------------------

describe('storage growth', () => {
  it('sweeps windows that can no longer block anybody', async () => {
    // MEASURED BEFORE THE FIX: 200 distinct addresses left 200 permanent rows
    // and `purgeStale()` had no caller — a denial of service that outlives the
    // attack.
    for (let i = 0; i < 40; i++) {
      await limiter.checkGet(String(i).padStart(64, '0'), EVENT);
    }
    expect(rows()).toBe(40);

    // Age them past the longest window any family uses.
    db.raw
      .prepare('UPDATE admin_login_attempts SET window_started_at = ?')
      .run(new Date(Date.now() - RATE_LIMIT_MAX_WINDOW_MS - 60_000).toISOString());

    expect(await limiter.sweep()).toBe(40);
    expect(rows()).toBe(0);
  });

  it('never removes a window that is still blocking someone', async () => {
    // The cutoff is the LONGEST window in the system, never the sweeping
    // limiter's own — a one-minute GET limiter must not delete an hour-long
    // email backstop that is still doing its job.
    const email = await hashEmailForBucket('victim@example.com');
    for (let i = 0; i <= PUBLIC_ENTRY_EMAIL_RATE_MAX; i++) {
      await limiter.checkEntryIdentity(String(i).padStart(64, 'f'), email, EVENT);
    }
    expect((await limiter.checkEntryIdentity(OTHER_IP, email, EVENT)).limited).toBe(true);

    await limiter.sweep();

    expect((await limiter.checkEntryIdentity(OTHER_IP, email, EVENT)).limited).toBe(true);
  });

  it('is bounded, so one sweep is a predictable amount of work', async () => {
    const stale = new Date(Date.now() - RATE_LIMIT_MAX_WINDOW_MS - 60_000).toISOString();
    for (let i = 0; i < RATE_LIMIT_SWEEP_BATCH + 25; i++) {
      db.raw
        .prepare(
          'INSERT INTO admin_login_attempts (bucket_key, attempts, window_started_at, updated_at) VALUES (?, 1, ?, ?)',
        )
        .run(`stale:${i}`, stale, stale);
    }

    expect(await limiter.sweep()).toBe(RATE_LIMIT_SWEEP_BATCH);
    expect(rows()).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Anti-lockout, attacked from more than one address
// ---------------------------------------------------------------------------

describe('victim lockout', () => {
  it('an attacker exhausting their own composite bucket cannot reach the victim', async () => {
    const victim = await hashEmailForBucket('victim@example.com');
    for (let i = 0; i < PUBLIC_ENTRY_IP_EMAIL_RATE_MAX + 5; i++) {
      await limiter.checkEntryIdentity(IP, victim, EVENT);
    }
    expect((await limiter.checkEntryIdentity(IP, victim, EVENT)).limited).toBe(true);
    expect((await limiter.checkEntryIdentity(OTHER_IP, victim, EVENT)).limited).toBe(false);
  });

  it('a blocked attacker stops burning the victim’s backstop', async () => {
    // The composite refusal returns BEFORE the backstop is consumed. Consuming
    // both unconditionally would turn the control that protects the victim into
    // the one that locks them out.
    const victim = await hashEmailForBucket('victim@example.com');
    for (let i = 0; i < PUBLIC_ENTRY_IP_EMAIL_RATE_MAX + 30; i++) {
      await limiter.checkEntryIdentity(IP, victim, EVENT);
    }

    const backstop = db.raw
      .prepare("SELECT attempts FROM admin_login_attempts WHERE bucket_key LIKE 'pub_entry_email:%'")
      .get() as { attempts: number };

    // Only the attempts made before the composite bucket closed.
    expect(backstop.attempts).toBeLessThanOrEqual(PUBLIC_ENTRY_IP_EMAIL_RATE_MAX);
    expect((await limiter.checkEntryIdentity(OTHER_IP, victim, EVENT)).limited).toBe(false);
  });

  it('a genuine registration releases the backstop', async () => {
    const victim = await hashEmailForBucket('victim@example.com');
    for (let i = 0; i < PUBLIC_ENTRY_EMAIL_RATE_MAX; i++) {
      await limiter.checkEntryIdentity(String(i).padStart(64, 'c'), victim, EVENT);
    }
    expect((await limiter.checkEntryIdentity(OTHER_IP, victim, EVENT)).limited).toBe(true);

    await limiter.releaseIdentity(victim, EVENT);
    expect((await limiter.checkEntryIdentity(OTHER_IP, victim, EVENT)).limited).toBe(false);
  });

  it('the precise bucket is NOT released — it is what resists probing', async () => {
    const victim = await hashEmailForBucket('victim@example.com');
    for (let i = 0; i <= PUBLIC_ENTRY_IP_EMAIL_RATE_MAX; i++) {
      await limiter.checkEntryIdentity(IP, victim, EVENT);
    }
    await limiter.releaseIdentity(victim, EVENT);
    expect((await limiter.checkEntryIdentity(IP, victim, EVENT)).limited).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bucket keys stay bounded and carry nothing personal
// ---------------------------------------------------------------------------

describe('bucket keys', () => {
  it('are fixed length whatever the caller supplies', async () => {
    const email = await hashEmailForBucket(`${'x'.repeat(5000)}@example.com`);
    await limiter.checkEntryIdentity('f'.repeat(64), email, 'e'.repeat(36));

    const keys = (
      db.raw.prepare('SELECT bucket_key FROM admin_login_attempts').all() as Array<{
        bucket_key: string;
      }>
    ).map((row) => row.bucket_key);

    // Hashes are 64 hex characters and the event id is server-derived, so no
    // caller-controlled string reaches the key at its own length.
    for (const key of keys) expect(key.length).toBeLessThan(256);
  });

  it('equivalent spellings of one address share a bucket', async () => {
    // The hash is taken of the NORMALIZED address, so casing and surrounding
    // whitespace cannot buy a fresh allowance.
    const a = await hashEmailForBucket(normalizeEmail('  Ana@Example.COM '));
    const b = await hashEmailForBucket(normalizeEmail('ana@example.com'));
    expect(a).toBe(b);
  });

  it('store no raw address and no raw email', async () => {
    const email = await hashEmailForBucket(normalizeEmail('secret@example.com'));
    await limiter.checkEntryIdentity(IP, email, EVENT);

    const dump = JSON.stringify(db.raw.prepare('SELECT * FROM admin_login_attempts').all());
    expect(dump).not.toContain('secret@example.com');
    expect(dump).not.toContain('203.0.113');
  });
});

// ---------------------------------------------------------------------------
// The login flow must be untouched by all of the above
// ---------------------------------------------------------------------------

describe('login is unaffected', () => {
  it('keeps check/record semantics and its own ceiling', async () => {
    const login = new LoginRateLimiter(db.d1);
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');

    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS - 1; i++) {
      await login.recordFailure(keys);
      expect((await login.check(keys)).limited).toBe(false);
    }
    await login.recordFailure(keys);
    expect((await login.check(keys)).limited).toBe(true);

    await login.reset(keys);
    expect((await login.check(keys)).limited).toBe(false);
  });

  it('is not consumed by public pressure', async () => {
    const login = new LoginRateLimiter(db.d1);
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');
    for (let i = 0; i < 60; i++) await limiter.checkGet(IP, EVENT);
    expect((await login.check(keys)).limited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DEFECT 4 — the token payload accepted more than its four claims
// ---------------------------------------------------------------------------

describe('token payload is canonical', () => {
  const SECRET = 'hardening-secret-value';
  const EVENT_ID = '11111111-1111-4111-8111-111111111111';
  const VERSION_ID = '22222222-2222-4222-8222-222222222222';
  const NOW = Date.parse('2026-03-01T12:00:00.000Z');
  const encoder = new TextEncoder();

  /** Signs an arbitrary payload with the real key, as a rogue issuer would. */
  async function signed(payload: unknown): Promise<string> {
    const encoded = toBase64Url(encoder.encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v1.${encoded}`));
    return `v1.${encoded}.${toBase64Url(new Uint8Array(mac))}`;
  }

  const service = () => new PublicFormTokenService(SECRET);
  const base = { e: EVENT_ID, v: VERSION_ID, i: Math.floor(NOW / 1000), n: 'abc' };

  it('accepts exactly the four claims', async () => {
    const result = await service().verify(await signed(base), EVENT_ID, NOW);
    expect(result.ok).toBe(true);
  });

  it('refuses a correctly signed payload carrying an extra claim', async () => {
    // MEASURED BEFORE THE FIX: accepted. A signature makes injection
    // impossible, so this does not stop an attacker — it stops a future issuer
    // quietly changing the shape and this verifier half-understanding it.
    const result = await service().verify(
      await signed({ ...base, extra: 'injected' }),
      EVENT_ID,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('refuses a payload carrying __proto__ or constructor as a literal key', async () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const result = await service().verify(
        await signed({ ...base, [key]: { polluted: true } }),
        EVENT_ID,
        NOW,
      );
      expect(result.ok, key).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses missing claims, wrong types, arrays and nesting', async () => {
    const hostile: unknown[] = [
      { e: EVENT_ID, v: VERSION_ID, i: base.i },
      { e: EVENT_ID, v: VERSION_ID, n: 'abc' },
      { ...base, i: String(base.i) },
      { ...base, e: 123 },
      { ...base, v: { nested: true } },
      { ...base, e: [EVENT_ID] },
      { ...base, i: base.i + 0.5 },
      { ...base, e: '' },
      [base],
      'a string',
      42,
      null,
    ];

    for (const payload of hostile) {
      const result = await service().verify(await signed(payload), EVENT_ID, NOW);
      expect(result.ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it('refuses a payload that is not JSON at all', async () => {
    const encoded = toBase64Url(encoder.encode('not json'));
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`v1.${encoded}`));
    const result = await service().verify(
      `v1.${encoded}.${toBase64Url(new Uint8Array(mac))}`,
      EVENT_ID,
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  // -------------------------------------------------------------------------
  // Boundaries, stated exactly rather than approximately
  // -------------------------------------------------------------------------

  it('expires strictly AFTER the TTL, not on it', async () => {
    const token = (await service().issue(EVENT_ID, VERSION_ID, NOW))!;
    const at = (seconds: number) => NOW + seconds * 1000;

    expect((await service().verify(token, EVENT_ID, at(PUBLIC_FORM_TOKEN_TTL_SECONDS - 1))).ok).toBe(true);
    expect((await service().verify(token, EVENT_ID, at(PUBLIC_FORM_TOKEN_TTL_SECONDS))).ok).toBe(true);
    expect(await service().verify(token, EVENT_ID, at(PUBLIC_FORM_TOKEN_TTL_SECONDS + 1))).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('tolerates skew up to and including the limit', async () => {
    // Contract: reject only when issuedAt > now + 60. Exactly +60 is accepted.
    const token = (await service().issue(EVENT_ID, VERSION_ID, NOW))!;
    const behind = (seconds: number) => NOW - seconds * 1000;
    const skew = PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS;

    expect((await service().verify(token, EVENT_ID, behind(skew - 1))).ok).toBe(true);
    expect((await service().verify(token, EVENT_ID, behind(skew))).ok).toBe(true);
    expect(await service().verify(token, EVENT_ID, behind(skew + 1))).toEqual({
      ok: false,
      reason: 'ISSUED_IN_FUTURE',
    });
  });

  it('reads the clock once, so a drifting clock cannot straddle both limits', async () => {
    // `verify` takes `nowMs` as a parameter and never calls the clock itself,
    // which is what makes the expiry and skew checks provably consistent.
    const token = (await service().issue(EVENT_ID, VERSION_ID, NOW))!;
    const RealDate = Date;
    let reads = 0;
    class Counting extends RealDate {
      static now() {
        reads++;
        return RealDate.now();
      }
    }
    globalThis.Date = Counting as unknown as DateConstructor;
    try {
      await service().verify(token, EVENT_ID, NOW);
    } finally {
      globalThis.Date = RealDate;
    }
    expect(reads).toBe(0);
  });
});

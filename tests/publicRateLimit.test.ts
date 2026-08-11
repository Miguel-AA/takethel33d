// @vitest-environment node
//
// Public rate limiting, and the login limiter it must not have disturbed.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PublicRateLimiter,
  hashEmailForBucket,
  publicBucketKind,
  PUBLIC_BUCKET_PREFIXES,
} from '../functions/_shared/publicRateLimit';
import {
  LOGIN_RATE_MAX_ATTEMPTS,
  LoginRateLimiter,
  PersistentRateLimiter,
  buildLoginBucketKeys,
} from '../functions/_shared/rateLimit';
import {
  PUBLIC_ENTRY_EMAIL_RATE_MAX,
  PUBLIC_ENTRY_IP_EMAIL_RATE_MAX,
  PUBLIC_ENTRY_IP_RATE_MAX,
  PUBLIC_GET_RATE_MAX,
} from '../shared/limits';
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

afterEach(() => {
  db.close();
});

describe('bucket labelling', () => {
  it('prefers the composite label over the coarse one', () => {
    // `pub_entry_ip_email` shares a prefix with `pub_entry_ip`; testing the
    // shorter one first would mislabel every composite bucket.
    expect(publicBucketKind('pub_entry_ip_email:a:b:c')).toBe(
      PUBLIC_BUCKET_PREFIXES.entryIpEmail,
    );
    expect(publicBucketKind('pub_entry_ip:a:c')).toBe(PUBLIC_BUCKET_PREFIXES.entryIp);
    expect(publicBucketKind('pub_entry_email:b:c')).toBe(PUBLIC_BUCKET_PREFIXES.entryEmail);
    expect(publicBucketKind('pub_get:a:c')).toBe(PUBLIC_BUCKET_PREFIXES.get);
    expect(publicBucketKind('something-else')).toBeNull();
  });
});

describe('reading an event page', () => {
  it('allows a generous number of loads and then refuses', async () => {
    for (let i = 0; i < PUBLIC_GET_RATE_MAX; i++) {
      expect((await limiter.checkGet(IP, EVENT)).limited, `load ${i}`).toBe(false);
    }
    const verdict = await limiter.checkGet(IP, EVENT);
    expect(verdict.limited).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('keys by event, so one event cannot lock a visitor out of another', async () => {
    for (let i = 0; i <= PUBLIC_GET_RATE_MAX; i++) await limiter.checkGet(IP, EVENT);
    expect((await limiter.checkGet(IP, 'event-2')).limited).toBe(false);
  });

  it('STILL limits a request whose address the edge could not report', async () => {
    // This once admitted everyone: with no address there was no bucket and so
    // no limit, which made "omit a header" an unlimited-request bypass.
    // Unattributable callers now share one bucket per event — fail-closed, and
    // unreachable in production where CF-Connecting-IP is always set.
    let limited = false;
    for (let i = 0; i < PUBLIC_GET_RATE_MAX + 5; i++) {
      if ((await limiter.checkGet(null, EVENT)).limited) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe('submitting', () => {
  it('refuses a machine submitting repeatedly', async () => {
    for (let i = 0; i < PUBLIC_ENTRY_IP_RATE_MAX; i++) {
      expect((await limiter.checkEntryIp(IP, EVENT)).limited, `try ${i}`).toBe(false);
    }
    expect((await limiter.checkEntryIp(IP, EVENT)).limited).toBe(true);
  });

  it('is independent of the GET budget', async () => {
    for (let i = 0; i < PUBLIC_ENTRY_IP_RATE_MAX + 2; i++) {
      await limiter.checkEntryIp(IP, EVENT);
    }
    expect((await limiter.checkGet(IP, EVENT)).limited).toBe(false);
  });

  it('refuses one address probing one identity', async () => {
    const email = await hashEmailForBucket('victim@example.com');
    for (let i = 0; i < PUBLIC_ENTRY_IP_EMAIL_RATE_MAX; i++) {
      expect((await limiter.checkEntryIdentity(IP, email, EVENT)).limited, `try ${i}`).toBe(
        false,
      );
    }
    expect((await limiter.checkEntryIdentity(IP, email, EVENT)).limited).toBe(true);
  });

  it('leaves other identities from the same address alone', async () => {
    const victim = await hashEmailForBucket('victim@example.com');
    const other = await hashEmailForBucket('someone-else@example.com');
    for (let i = 0; i <= PUBLIC_ENTRY_IP_EMAIL_RATE_MAX; i++) {
      await limiter.checkEntryIdentity(IP, victim, EVENT);
    }
    expect((await limiter.checkEntryIdentity(IP, other, EVENT)).limited).toBe(false);
  });
});

describe('anti-lockout', () => {
  it('the composite bucket refuses long before the email backstop does', async () => {
    // The refusal work must be done by the bucket an attacker cannot exhaust on
    // a victim's behalf without also holding the victim's address.
    expect(PUBLIC_ENTRY_IP_EMAIL_RATE_MAX).toBeLessThan(PUBLIC_ENTRY_EMAIL_RATE_MAX);
  });

  it('an attacker on one address cannot lock a victim out from another', async () => {
    const victim = await hashEmailForBucket('victim@example.com');

    // The attacker burns their own composite bucket completely.
    for (let i = 0; i < PUBLIC_ENTRY_IP_EMAIL_RATE_MAX + 3; i++) {
      await limiter.checkEntryIdentity(IP, victim, EVENT);
    }
    expect((await limiter.checkEntryIdentity(IP, victim, EVENT)).limited).toBe(true);

    // The victim, on their own connection, is still admitted.
    expect((await limiter.checkEntryIdentity(OTHER_IP, victim, EVENT)).limited).toBe(false);
  });

  it('the email backstop still exists for the distributed case', async () => {
    const victim = await hashEmailForBucket('victim@example.com');
    // Each attempt from a different address, so only the email bucket counts.
    for (let i = 0; i < PUBLIC_ENTRY_EMAIL_RATE_MAX; i++) {
      const from = `${i}`.padStart(64, 'c');
      await limiter.checkEntryIdentity(from, victim, EVENT);
    }
    expect((await limiter.checkEntryIdentity(OTHER_IP, victim, EVENT)).limited).toBe(true);
  });
});

describe('privacy of the buckets', () => {
  it('stores no raw email and no raw address', async () => {
    const email = await hashEmailForBucket('secret@example.com');
    await limiter.checkEntryIdentity(IP, email, EVENT);

    const stored = JSON.stringify(
      db.raw.prepare('SELECT * FROM admin_login_attempts').all(),
    );
    expect(stored).not.toContain('secret@example.com');
    expect(stored).toContain('pub_entry_ip_email:');
  });

  it('hashes an address to 64 hex characters', async () => {
    expect(await hashEmailForBucket('a@b.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('counters persist', () => {
  it('a fresh limiter instance still sees the count', async () => {
    for (let i = 0; i < PUBLIC_ENTRY_IP_RATE_MAX; i++) {
      await limiter.checkEntryIp(IP, EVENT);
    }
    // As a new isolate would be.
    const other = new PublicRateLimiter(db.d1);
    expect((await other.checkEntryIp(IP, EVENT)).limited).toBe(true);
  });

  it('the generic counter is atomic per key under concurrency', async () => {
    const generic = new PersistentRateLimiter(db.d1, 60_000, 100);
    await Promise.all(
      Array.from({ length: 20 }, () => generic.record(['pub_get:x:y'])),
    );
    const row = db.raw
      .prepare("SELECT attempts FROM admin_login_attempts WHERE bucket_key = 'pub_get:x:y'")
      .get() as { attempts: number };
    expect(row.attempts).toBe(20);
  });
});

describe('login is untouched', () => {
  it('keeps its own thresholds', async () => {
    const login = new LoginRateLimiter(db.d1);
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');

    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS - 1; i++) {
      await login.recordFailure(keys);
      expect((await login.check(keys)).limited).toBe(false);
    }
    await login.recordFailure(keys);
    expect((await login.check(keys)).limited).toBe(true);
  });

  it('still reports its bucket kinds by name', async () => {
    // `AdminAuthService` branches on these.
    const login = new LoginRateLimiter(db.d1);
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');
    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS; i++) await login.recordFailure(keys);

    const verdict = await login.check(keys);
    expect(verdict.limitedKinds).toContain('email');
    expect(verdict.limitedKinds).toContain('ip');
  });

  it('public pressure does not consume the login budget', async () => {
    const login = new LoginRateLimiter(db.d1);
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');

    for (let i = 0; i < PUBLIC_ENTRY_IP_RATE_MAX + 5; i++) {
      await limiter.checkEntryIp(IP, EVENT);
    }
    expect((await login.check(keys)).limited).toBe(false);
  });
});

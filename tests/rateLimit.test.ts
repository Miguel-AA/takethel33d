// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  LOGIN_RATE_MAX_ATTEMPTS,
  LoginRateLimiter,
  buildLoginBucketKeys,
  clientIpOf,
} from '../functions/_shared/rateLimit';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

let db: TestDatabase;
let limiter: LoginRateLimiter;

beforeEach(() => {
  db = createTestDatabase();
  limiter = new LoginRateLimiter(db.d1);
});

afterEach(() => {
  db.close();
});

describe('login rate limiting', () => {
  it('allows attempts below the threshold', async () => {
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');
    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS - 1; i++) {
      await limiter.recordFailure(keys);
      expect((await limiter.check(keys)).limited).toBe(false);
    }
  });

  it('blocks once the threshold is reached, with a retry hint', async () => {
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');
    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS; i++) await limiter.recordFailure(keys);

    const verdict = await limiter.check(keys);
    expect(verdict.limited).toBe(true);
    expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('persists counters in the database, not in memory', async () => {
    const keys = await buildLoginBucketKeys('ada@example.com', null);
    await limiter.recordFailure(keys);

    // A brand-new limiter instance — as a fresh isolate would be — still sees
    // the count. This is the property the old in-memory Map lacked.
    const other = new LoginRateLimiter(db.d1);
    for (let i = 1; i < LOGIN_RATE_MAX_ATTEMPTS; i++) await other.recordFailure(keys);
    expect((await other.check(keys)).limited).toBe(true);
  });

  it('isolates buckets per email', async () => {
    const a = await buildLoginBucketKeys('a@example.com', null);
    const b = await buildLoginBucketKeys('b@example.com', null);
    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS; i++) await limiter.recordFailure(a);

    expect((await limiter.check(a)).limited).toBe(true);
    expect((await limiter.check(b)).limited).toBe(false);
  });

  it('blocks by IP even across different emails', async () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS; i++) {
      await limiter.recordFailure(await buildLoginBucketKeys(`user${i}@example.com`, ip));
    }
    // Spraying many accounts from one source still trips the IP bucket.
    const fresh = await buildLoginBucketKeys('brand-new@example.com', ip);
    expect((await limiter.check(fresh)).limited).toBe(true);
  });

  it('reset clears the buckets after a successful login', async () => {
    const keys = await buildLoginBucketKeys('ada@example.com', '203.0.113.1');
    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS; i++) await limiter.recordFailure(keys);
    expect((await limiter.check(keys)).limited).toBe(true);

    await limiter.reset(keys);
    expect((await limiter.check(keys)).limited).toBe(false);
  });

  it('rolls over to a new window once the old one lapses', async () => {
    const keys = await buildLoginBucketKeys('ada@example.com', null);
    for (let i = 0; i < LOGIN_RATE_MAX_ATTEMPTS; i++) await limiter.recordFailure(keys);
    expect((await limiter.check(keys)).limited).toBe(true);

    // Age the window past its end.
    db.raw
      .prepare("UPDATE admin_login_attempts SET window_started_at = '2000-01-01T00:00:00.000Z'")
      .run();

    expect((await limiter.check(keys)).limited).toBe(false);
    await limiter.recordFailure(keys);
    const row = db.raw
      .prepare('SELECT attempts FROM admin_login_attempts LIMIT 1')
      .get() as { attempts: number };
    expect(row.attempts).toBe(1);
  });

  it('stores no raw email or IP', async () => {
    const keys = await buildLoginBucketKeys('secret@example.com', '203.0.113.7');
    await limiter.recordFailure(keys);

    const stored = JSON.stringify(
      db.raw.prepare('SELECT * FROM admin_login_attempts').all(),
    );
    expect(stored).not.toContain('secret@example.com');
    expect(stored).not.toContain('203.0.113.7');
    expect(stored).toMatch(/email:[0-9a-f]{64}/);
    expect(stored).toMatch(/ip:[0-9a-f]{64}/);
  });

  it('purgeStale removes windows that can no longer block', async () => {
    const keys = await buildLoginBucketKeys('ada@example.com', null);
    await limiter.recordFailure(keys);
    db.raw
      .prepare("UPDATE admin_login_attempts SET window_started_at = '2000-01-01T00:00:00.000Z'")
      .run();

    await limiter.purgeStale();
    const count = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_login_attempts')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('handles an empty key list', async () => {
    await expect(limiter.check([])).resolves.toEqual({
      limited: false,
      retryAfterSeconds: 0,
      limitedKinds: [],
    });
    await expect(limiter.recordFailure([])).resolves.toBeUndefined();
  });

  it('omits the IP bucket when the client IP is unknown', async () => {
    const keys = await buildLoginBucketKeys('ada@example.com', null);
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith('email:')).toBe(true);
  });
});

describe('clientIpOf', () => {
  it('prefers the Cloudflare header', () => {
    const request = new Request('https://example.com/', {
      headers: { 'CF-Connecting-IP': '203.0.113.5', 'x-forwarded-for': '198.51.100.1' },
    });
    expect(clientIpOf(request)).toBe('203.0.113.5');
  });

  it('falls back to the first x-forwarded-for entry', () => {
    const request = new Request('https://example.com/', {
      headers: { 'x-forwarded-for': '198.51.100.1, 10.0.0.1' },
    });
    expect(clientIpOf(request)).toBe('198.51.100.1');
  });

  it('returns null when no header is present', () => {
    expect(clientIpOf(new Request('https://example.com/'))).toBeNull();
  });
});

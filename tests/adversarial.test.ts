// @vitest-environment node
//
// Adversarial validation of the Phase 1 auth stack. Every test here asserts the
// SECURE behaviour and is written to fail if the corresponding defence is
// removed.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { onRequestPost as logoutHandler } from '../functions/api/manager/logout';
import { onRequestGet as meHandler } from '../functions/api/manager/me';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { SessionRepository } from '../functions/_shared/sessionRepository';
import { AdminAuthService } from '../functions/_shared/adminAuthService';
import { hashPassword } from '../functions/_shared/password';
import { hashToken } from '../functions/_shared/tokens';
import {
  SESSION_COOKIE_NAME,
  HOST_SESSION_COOKIE_NAME,
  readSessionCookie,
} from '../functions/_shared/cookies';
import { LoginRateLimiter, buildLoginBucketKeys } from '../functions/_shared/rateLimit';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { AdminStatus } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;

async function invoke(
  handler: (ctx: never) => Promise<Response> | Response,
  request: Request,
  data: Record<string, unknown> = {},
): Promise<{ response: Response; data: Record<string, unknown>; nextCalled: boolean }> {
  let nextCalled = false;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    request,
    env: { DB: db.d1 },
    data,
    params: {},
    next: async () => {
      nextCalled = true;
      return new Response('downstream', { status: 200 });
    },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  };
  const response = await handler(ctx as never);
  await Promise.allSettled(pending);
  return { response, data, nextCalled };
}

function jsonRequest(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  });
}

async function seedAdmin(email = EMAIL, status: AdminStatus = 'ACTIVE'): Promise<string> {
  const result = await new AdminRepository(db.d1).create({
    email,
    normalizedEmail: normalizeEmail(email),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword(PASSWORD),
    status,
  });
  if (result.kind !== 'created') throw new Error('seed failed');
  return result.admin.id;
}

function cookieValueOf(response: Response, name: string): string | null {
  const all = response.headers.getSetCookie?.() ?? [
    response.headers.get('Set-Cookie') ?? '',
  ];
  for (const cookie of all) {
    const match = new RegExp(`(?:^|\\s)${name}=([^;]*)`).exec(cookie);
    if (match) return decodeURIComponent(match[1]);
  }
  return null;
}

async function loginAndGetToken(email = EMAIL): Promise<string> {
  const { response } = await invoke(
    loginHandler as never,
    jsonRequest('/api/manager/login', { email, password: PASSWORD }),
  );
  expect(response.status).toBe(200);
  const token =
    cookieValueOf(response, HOST_SESSION_COOKIE_NAME) ??
    cookieValueOf(response, SESSION_COOKIE_NAME);
  if (!token) throw new Error('no session cookie issued');
  return token;
}

function cookieHeaderFor(token: string, secure = true): Record<string, string> {
  const name = secure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
  return { Cookie: `${name}=${encodeURIComponent(token)}` };
}

beforeEach(() => {
  db = createTestDatabase();
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// A. Middleware path-normalisation bypass
// ---------------------------------------------------------------------------
describe('middleware cannot be bypassed by path tricks', () => {
  // A router that normalises differently from the guard is a classic auth
  // bypass. The guard must normalise the path itself rather than trust it.
  const BYPASS_CANDIDATES = [
    '//api/attendees',
    '/api//attendees',
    '/api/%61ttendees',
    '/api/%61ttendees/abc',
    '/API/attendees',
    '/Api/Metrics',
    '/api/./attendees',
    '/api/attendees/',
    '///api/metrics',
    '/api/%72affle/draw',
    '/api/raffle/%64raw',
    '/api/manager/%6de',
  ];

  it.each(BYPASS_CANDIDATES)('rejects %s without a session', async (path) => {
    const { response, nextCalled } = await invoke(
      onRequest as never,
      new Request(`https://example.com${path}`),
    );
    expect(nextCalled, `${path} reached its handler unauthenticated`).toBe(false);
    expect(response.status).toBe(401);
  });

  it('still lets genuinely public paths through', async () => {
    for (const path of ['/api/register', '/api/manager/login', '/', '/events']) {
      const { nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(nextCalled, `${path} must stay public`).toBe(true);
    }
  });

  it('does not protect an unrelated path that merely shares a prefix', async () => {
    // /api/metricsomething is not an endpoint; over-protecting is safe, but a
    // public path must never be swallowed.
    const { nextCalled } = await invoke(
      onRequest as never,
      new Request('https://example.com/api/registered-users-public'),
    );
    expect(nextCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. Cookie handling: fixation, duplicates, prefix
// ---------------------------------------------------------------------------
describe('session cookie hardening', () => {
  it('issues a __Host- prefixed cookie over HTTPS', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      jsonRequest('/api/manager/login', { email: EMAIL, password: PASSWORD }),
    );
    const raw = (response.headers.getSetCookie?.() ?? []).join(' | ');
    // __Host- cannot be set by a sibling subdomain, which is what stops
    // cookie-tossing session fixation.
    expect(raw).toContain(`${HOST_SESSION_COOKIE_NAME}=`);
    expect(raw).toContain('Secure');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('Path=/');
    expect(raw).not.toContain('Domain=');
  });

  it('falls back to the plain cookie name over plain HTTP', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      new Request('http://localhost:8788/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    const raw = (response.headers.getSetCookie?.() ?? []).join(' | ');
    // __Host- requires Secure, so it cannot be used on http://localhost.
    expect(raw).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(raw).not.toContain(HOST_SESSION_COOKIE_NAME);
  });

  it('prefers the __Host- cookie when both are present', () => {
    const request = new Request('https://example.com/', {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=tossed-by-subdomain; ${HOST_SESSION_COOKIE_NAME}=genuine`,
      },
    });
    expect(readSessionCookie(request)).toBe('genuine');
  });

  it('refuses an ambiguous duplicate cookie instead of picking one', () => {
    // Two values for the same name means something other than this app set one
    // of them. Choosing either could hand the user an attacker's session.
    const request = new Request('https://example.com/', {
      headers: {
        Cookie: `${HOST_SESSION_COOKIE_NAME}=attacker; ${HOST_SESSION_COOKIE_NAME}=victim`,
      },
    });
    expect(readSessionCookie(request)).toBeNull();
  });

  it('a duplicated cookie cannot authenticate', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();
    const { response, nextCalled } = await invoke(
      onRequest as never,
      new Request('https://example.com/api/metrics', {
        headers: {
          Cookie: `${HOST_SESSION_COOKIE_NAME}=${token}; ${HOST_SESSION_COOKIE_NAME}=forged`,
        },
      }),
    );
    expect(nextCalled).toBe(false);
    expect(response.status).toBe(401);
  });

  it('logout clears both cookie names', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();
    const gate = await invoke(
      onRequest as never,
      new Request('https://example.com/api/manager/logout', {
        headers: cookieHeaderFor(token),
      }),
    );
    const { response } = await invoke(
      logoutHandler as never,
      new Request('https://example.com/api/manager/logout', {
        method: 'POST',
        headers: { ...cookieHeaderFor(token), 'Content-Type': 'application/json' },
      }),
      gate.data,
    );
    const all = (response.headers.getSetCookie?.() ?? []).join(' | ');
    expect(all).toContain(HOST_SESSION_COOKIE_NAME);
    expect(all).toContain(SESSION_COOKIE_NAME);
    expect(all).toContain('Max-Age=0');
  });

  it('a token containing cookie delimiters cannot inject attributes', () => {
    const request = new Request('https://example.com/', {
      headers: { Cookie: `${HOST_SESSION_COOKIE_NAME}=abc%3B%20Path%3D%2Fevil` },
    });
    // Percent-decoding happens after splitting, so the injected `;` is inert.
    expect(readSessionCookie(request)).toBe('abc; Path=/evil');
  });
});

// ---------------------------------------------------------------------------
// C. Login CSRF / session fixation via cross-origin form POST
// ---------------------------------------------------------------------------
describe('login rejects cross-origin form submissions', () => {
  // A cross-origin <form> can only send urlencoded/multipart/text-plain. If the
  // handler parses those as JSON, an attacker can force a victim's browser to
  // log in as the ATTACKER (session fixation).
  it.each([
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    '',
  ])('refuses Content-Type %s', async (contentType) => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers: contentType ? { 'Content-Type': contentType } : {},
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(415);
    expect(response.headers.get('Set-Cookie')).toBeNull();
  });

  it('accepts application/json with a charset parameter', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it('logout also requires a JSON content type', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();
    const gate = await invoke(
      onRequest as never,
      new Request('https://example.com/api/manager/logout', {
        headers: cookieHeaderFor(token),
      }),
    );
    const { response } = await invoke(
      logoutHandler as never,
      new Request('https://example.com/api/manager/logout', {
        method: 'POST',
        headers: { ...cookieHeaderFor(token), 'Content-Type': 'text/plain' },
      }),
      gate.data,
    );
    expect(response.status).toBe(415);
  });
});

// ---------------------------------------------------------------------------
// D. Login input abuse
// ---------------------------------------------------------------------------
describe('login input handling', () => {
  it('rejects malformed JSON, empty body and wrong shapes without 500s', async () => {
    await seedAdmin();
    const bodies = ['', '{', 'null', '[]', '"string"', '{"email":123}', '{}'];
    for (const body of bodies) {
      const { response } = await invoke(
        loginHandler as never,
        jsonRequest('/api/manager/login', body),
      );
      expect([400, 401]).toContain(response.status);
      expect(response.status).not.toBe(500);
    }
  });

  it('never creates a session on a failed login', async () => {
    await seedAdmin();
    for (const payload of [
      { email: EMAIL, password: 'wrong' },
      { email: 'ghost@example.com', password: PASSWORD },
      { email: 'bad', password: 'x' },
    ]) {
      await invoke(loginHandler as never, jsonRequest('/api/manager/login', payload));
    }
    const count = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_sessions')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('strips unknown fields so status/role cannot be mass-assigned', async () => {
    const id = await seedAdmin('sus@example.com', 'SUSPENDED');
    const { response } = await invoke(
      loginHandler as never,
      jsonRequest('/api/manager/login', {
        email: 'sus@example.com',
        password: PASSWORD,
        status: 'ACTIVE',
        role: 'ADMIN',
      }),
    );
    expect(response.status).toBe(403);
    const row = db.raw
      .prepare('SELECT status FROM admin_users WHERE id = ?')
      .get(id) as { status: string };
    expect(row.status).toBe('SUSPENDED');
  });

  it('bounds oversized email and password inputs', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      jsonRequest('/api/manager/login', {
        email: `${'a'.repeat(300)}@example.com`,
        password: 'x'.repeat(5000),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('treats email as data, not SQL', async () => {
    await seedAdmin();
    const injections = [
      "' OR '1'='1",
      "admin@example.com'--",
      "'; DROP TABLE admin_users;--",
    ];
    for (const email of injections) {
      const { response } = await invoke(
        loginHandler as never,
        jsonRequest('/api/manager/login', { email, password: PASSWORD }),
      );
      expect([400, 401, 429]).toContain(response.status);
    }
    // The table is still there and intact.
    const count = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_users')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// E. Rate limiting: lockout DoS and concurrency
// ---------------------------------------------------------------------------
describe('rate limiting cannot be weaponised against a legitimate admin', () => {
  it('a third party cannot lock a victim out of their own account', async () => {
    await seedAdmin();
    const auth = new AdminAuthService(db.d1);

    // Attacker burns the victim's email bucket from their own IP.
    for (let i = 0; i < 15; i++) {
      await auth.login({
        email: EMAIL,
        password: 'guess',
        clientIp: '198.51.100.66',
      });
    }

    // The real admin, from a clean IP and with the correct password, must
    // still get in. Otherwise anyone who knows an admin email can deny access.
    const victim = await auth.login({
      email: EMAIL,
      password: PASSWORD,
      clientIp: '203.0.113.10',
    });
    expect(victim.kind).toBe('ok');
  });

  it('still blocks password guessing from one source', async () => {
    await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    const ip = '198.51.100.77';
    for (let i = 0; i < 10; i++) {
      await auth.login({ email: EMAIL, password: 'guess', clientIp: ip });
    }
    // Same IP is now hard-blocked, even with the correct password.
    const blocked = await auth.login({ email: EMAIL, password: PASSWORD, clientIp: ip });
    expect(blocked.kind).toBe('rate_limited');
  });

  it('a wrong password against a rate-limited email is refused', async () => {
    await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    for (let i = 0; i < 12; i++) {
      await auth.login({ email: EMAIL, password: 'guess', clientIp: `198.51.100.${i}` });
    }
    const attacker = await auth.login({
      email: EMAIL,
      password: 'still-wrong',
      clientIp: '203.0.113.99',
    });
    expect(attacker.kind).toBe('rate_limited');
  });

  it('counts concurrent failures without losing updates', async () => {
    const limiter = new LoginRateLimiter(db.d1);
    const keys = await buildLoginBucketKeys(EMAIL, '203.0.113.1');

    await Promise.all(Array.from({ length: 8 }, () => limiter.recordFailure(keys)));

    const rows = db.raw
      .prepare('SELECT bucket_key, attempts FROM admin_login_attempts')
      .all() as Array<{ bucket_key: string; attempts: number }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // UPSERT is atomic, so no increment may be lost.
      expect(row.attempts).toBe(8);
    }
  });

  it('does not grow a row per attacker-chosen email forever', async () => {
    const limiter = new LoginRateLimiter(db.d1);
    for (let i = 0; i < 5; i++) {
      await limiter.recordFailure(await buildLoginBucketKeys(`spam${i}@x.com`, '1.2.3.4'));
    }
    db.raw
      .prepare("UPDATE admin_login_attempts SET window_started_at = '2000-01-01T00:00:00.000Z'")
      .run();
    await limiter.purgeStale();
    const count = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_login_attempts')
      .get() as { n: number };
    expect(count.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F. Session lifecycle races and IDOR
// ---------------------------------------------------------------------------
describe('session lifecycle under concurrency', () => {
  it('two concurrent logins yield two distinct, independently valid sessions', async () => {
    await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    const [a, b] = await Promise.all([
      auth.login({ email: EMAIL, password: PASSWORD }),
      auth.login({ email: EMAIL, password: PASSWORD }),
    ]);
    if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('expected both to succeed');

    expect(a.token).not.toBe(b.token);
    expect(a.sessionId).not.toBe(b.sessionId);
    expect((await auth.validateSessionToken(a.token)).kind).toBe('valid');
    expect((await auth.validateSessionToken(b.token)).kind).toBe('valid');
  });

  it('two concurrent logouts are safe and keep one revocation timestamp', async () => {
    await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    const login = await auth.login({ email: EMAIL, password: PASSWORD });
    if (login.kind !== 'ok') throw new Error('login failed');

    const results = await Promise.all([auth.logout(login.token), auth.logout(login.token)]);
    expect(results.filter((r) => r.revoked).length).toBeGreaterThanOrEqual(1);

    const rows = db.raw
      .prepare('SELECT revoked_at FROM admin_sessions')
      .all() as Array<{ revoked_at: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
    expect((await auth.validateSessionToken(login.token)).kind).toBe('revoked');
  });

  it('logout revokes only the caller session, not one named in the request', async () => {
    await seedAdmin();
    await seedAdmin('victim@example.com');
    const auth = new AdminAuthService(db.d1);

    const attacker = await auth.login({ email: EMAIL, password: PASSWORD });
    const victim = await auth.login({ email: 'victim@example.com', password: PASSWORD });
    if (attacker.kind !== 'ok' || victim.kind !== 'ok') throw new Error('login failed');

    const gate = await invoke(
      onRequest as never,
      new Request('https://example.com/api/manager/logout', {
        headers: cookieHeaderFor(attacker.token),
      }),
    );
    // Attacker names the victim's session in the body — it must be ignored.
    await invoke(
      logoutHandler as never,
      new Request('https://example.com/api/manager/logout', {
        method: 'POST',
        headers: { ...cookieHeaderFor(attacker.token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: victim.sessionId, id: victim.sessionId }),
      }),
      gate.data,
    );

    expect((await auth.validateSessionToken(victim.token)).kind).toBe('valid');
    expect((await auth.validateSessionToken(attacker.token)).kind).toBe('revoked');
  });

  it('a token belonging to a deleted admin stops working', async () => {
    const id = await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    const login = await auth.login({ email: EMAIL, password: PASSWORD });
    if (login.kind !== 'ok') throw new Error('login failed');

    db.raw.prepare('DELETE FROM admin_users WHERE id = ?').run(id);

    // ON DELETE CASCADE removes the session; nothing may authenticate.
    expect((await auth.validateSessionToken(login.token)).kind).toBe('invalid');
    const sessions = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_sessions')
      .get() as { n: number };
    expect(sessions.n).toBe(0);
  });

  it('a session expiring between checks is refused on the next request', async () => {
    await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    const login = await auth.login({ email: EMAIL, password: PASSWORD });
    if (login.kind !== 'ok') throw new Error('login failed');

    expect((await auth.validateSessionToken(login.token)).kind).toBe('valid');
    db.raw
      .prepare("UPDATE admin_sessions SET expires_at = ?")
      .run(new Date(Date.now() - 1).toISOString());
    expect((await auth.validateSessionToken(login.token)).kind).toBe('expired');
  });

  it('rejects a token that hashes to a foreign session', async () => {
    await seedAdmin();
    await seedAdmin('other@example.com');
    const auth = new AdminAuthService(db.d1);
    const mine = await auth.login({ email: EMAIL, password: PASSWORD });
    const theirs = await auth.login({ email: 'other@example.com', password: PASSWORD });
    if (mine.kind !== 'ok' || theirs.kind !== 'ok') throw new Error('login failed');

    const theirOutcome = await auth.validateSessionToken(theirs.token);
    const myOutcome = await auth.validateSessionToken(mine.token);
    if (theirOutcome.kind !== 'valid' || myOutcome.kind !== 'valid') {
      throw new Error('expected both valid');
    }
    // Each token resolves to its own owner only — no cross-binding.
    expect(theirOutcome.admin.email).toBe('other@example.com');
    expect(myOutcome.admin.email).toBe(EMAIL);
    expect(theirOutcome.admin.id).not.toBe(myOutcome.admin.id);
    expect(theirOutcome.admin.sessionId).not.toBe(myOutcome.admin.sessionId);
  });

  it('a duplicate token hash is rejected by the unique index', async () => {
    const id = await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    const login = await auth.login({ email: EMAIL, password: PASSWORD });
    if (login.kind !== 'ok') throw new Error('login failed');

    const existingHash = await hashToken(login.token);
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO admin_sessions (id, admin_user_id, token_hash, expires_at)
           VALUES ('forged', ?, ?, '2099-01-01T00:00:00.000Z')`,
        )
        .run(id, existingHash),
    ).toThrow(/UNIQUE/i);
  });
});

// ---------------------------------------------------------------------------
// G. Secret leakage
// ---------------------------------------------------------------------------
describe('no secret ever leaves the process', () => {
  it('no endpoint response contains a hash or a token', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();

    const gate = await invoke(
      onRequest as never,
      new Request('https://example.com/api/manager/me', { headers: cookieHeaderFor(token) }),
    );
    const me = await invoke(
      meHandler as never,
      new Request('https://example.com/api/manager/me', { headers: cookieHeaderFor(token) }),
      gate.data,
    );

    const body = await me.response.text();
    const storedHash = (
      db.raw.prepare('SELECT password_hash AS h FROM admin_users LIMIT 1').get() as {
        h: string;
      }
    ).h;
    const storedToken = (
      db.raw.prepare('SELECT token_hash AS h FROM admin_sessions LIMIT 1').get() as {
        h: string;
      }
    ).h;

    expect(body).not.toContain(storedHash);
    expect(body).not.toContain(storedToken);
    expect(body).not.toContain(token);
    expect(body).not.toContain('pbkdf2');
  });

  it('error responses never echo the submitted password', async () => {
    await seedAdmin();
    const secret = 'my-unique-secret-password-value';
    const { response } = await invoke(
      loginHandler as never,
      jsonRequest('/api/manager/login', { email: EMAIL, password: secret }),
    );
    const text = await response.text();
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/at .*\(/); // no stack trace
  });

  it('the plaintext token is never persisted anywhere in the database', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();
    const tables = ['admin_users', 'admin_sessions', 'admin_login_attempts'];
    for (const table of tables) {
      const dump = JSON.stringify(db.raw.prepare(`SELECT * FROM ${table}`).all());
      expect(dump, `${table} must not contain the plaintext token`).not.toContain(token);
    }
    // ...but its hash is there, which is what validation uses.
    const stored = db.raw
      .prepare('SELECT token_hash AS h FROM admin_sessions LIMIT 1')
      .get() as { h: string };
    expect(stored.h).toBe(await hashToken(token));
  });

  it('a hostile display name is stored verbatim and never interpolated into SQL', async () => {
    const hostile = `Robert'); DROP TABLE admin_users;--<script>alert(1)</script>`;
    const repo = new AdminRepository(db.d1);
    const created = await repo.create({
      email: 'x@example.com',
      normalizedEmail: 'x@example.com',
      displayName: hostile,
      passwordHash: await hashPassword(PASSWORD),
    });
    if (created.kind !== 'created') throw new Error('create failed');
    expect(created.admin.displayName).toBe(hostile);

    const still = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_users')
      .get() as { n: number };
    expect(still.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// H. Concurrent admin creation
// ---------------------------------------------------------------------------
describe('administrator creation', () => {
  it('two concurrent creations with the same email produce exactly one admin', async () => {
    const repo = new AdminRepository(db.d1);
    const hash = await hashPassword(PASSWORD);
    const results = await Promise.all([
      repo.create({
        email: 'Race@example.com',
        normalizedEmail: 'race@example.com',
        displayName: 'A',
        passwordHash: hash,
      }),
      repo.create({
        email: 'RACE@example.com',
        normalizedEmail: 'race@example.com',
        displayName: 'B',
        passwordHash: hash,
      }),
    ]);

    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'email_exists')).toHaveLength(1);

    const count = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_users')
      .get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('refuses an empty password hash', async () => {
    // A blank hash would make verifyPassword return false for everything, but
    // storing one at all is a defect worth preventing at the schema level.
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
           VALUES ('u9','a@b.com','a@b.com','A','')`,
        )
        .run(),
    ).toThrow(/CHECK|constraint/i);
  });
});

// ---------------------------------------------------------------------------
// I. Session repository ownership
// ---------------------------------------------------------------------------
describe('session repository', () => {
  it('revokeAllForAdmin only touches that admin', async () => {
    await seedAdmin();
    const otherId = await seedAdmin('other@example.com');
    const auth = new AdminAuthService(db.d1);
    const mine = await auth.login({ email: EMAIL, password: PASSWORD });
    const theirs = await auth.login({ email: 'other@example.com', password: PASSWORD });
    if (mine.kind !== 'ok' || theirs.kind !== 'ok') throw new Error('login failed');

    await new SessionRepository(db.d1).revokeAllForAdmin(otherId);

    expect((await auth.validateSessionToken(mine.token)).kind).toBe('valid');
    expect((await auth.validateSessionToken(theirs.token)).kind).toBe('revoked');
  });

  it('last_seen_at is throttled so polling does not write on every request', async () => {
    await seedAdmin();
    const auth = new AdminAuthService(db.d1);
    const login = await auth.login({ email: EMAIL, password: PASSWORD });
    if (login.kind !== 'ok') throw new Error('login failed');

    const readLastSeen = () =>
      (db.raw.prepare('SELECT last_seen_at AS t FROM admin_sessions LIMIT 1').get() as {
        t: string;
      }).t;

    // Plant a recognisable marker so the assertions cannot be confused by two
    // writes landing in the same millisecond.
    const MARKER = '2026-01-01T00:00:00.000Z';
    db.raw.prepare('UPDATE admin_sessions SET last_seen_at = ?').run(MARKER);

    // A last_seen_at that is already recent must SUPPRESS the write, so the
    // dashboard's 4-second poll does not turn every read into an UPDATE.
    await auth.touchSession(login.sessionId, new Date().toISOString());
    expect(readLastSeen()).toBe(MARKER);

    // A stale one must allow it through.
    await auth.touchSession(login.sessionId, '2000-01-01T00:00:00.000Z');
    expect(readLastSeen()).not.toBe(MARKER);
  });
});

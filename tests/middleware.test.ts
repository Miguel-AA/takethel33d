// @vitest-environment node
//
// Drives the real middleware and the real login/me/logout handlers.

import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { onRequestGet as meHandler } from '../functions/api/manager/me';
import { onRequestPost as logoutHandler } from '../functions/api/manager/logout';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import {
  HOST_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../functions/_shared/cookies';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { AdminStatus, ApiErrorBody } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;

interface CallResult {
  response: Response;
  data: Record<string, unknown>;
  nextCalled: boolean;
}

/** Builds a Pages-Functions-shaped context and invokes a handler. */
async function invoke(
  handler: (ctx: never) => Promise<Response> | Response,
  request: Request,
  data: Record<string, unknown> = {},
): Promise<CallResult> {
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

function req(path: string, init: RequestInit = {}): Request {
  // State-changing endpoints require a JSON content type (CSRF control), so the
  // helper declares it for every request it builds.
  return new Request(`https://example.com${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** Over HTTPS the session lives in the `__Host-` prefixed cookie. */
function withCookie(path: string, token: string, init: RequestInit = {}): Request {
  return req(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    },
  });
}

async function seedAdmin(
  email = EMAIL,
  status: AdminStatus = 'ACTIVE',
): Promise<string> {
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

/** Logs in through the real handler and returns the cookie token. */
async function loginAndGetToken(email = EMAIL): Promise<string> {
  const { response } = await invoke(
    loginHandler as never,
    req('/api/manager/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: PASSWORD }),
    }),
  );
  expect(response.status).toBe(200);

  const setCookie = (response.headers.getSetCookie?.() ?? [
    response.headers.get('Set-Cookie') ?? '',
  ]).join(' | ');
  const match = new RegExp(`${HOST_SESSION_COOKIE_NAME}=([^;]+)`).exec(setCookie);
  if (!match) throw new Error(`no session cookie in: ${setCookie}`);
  return decodeURIComponent(match[1]);
}

beforeEach(() => {
  db = createTestDatabase();
});

afterEach(() => {
  db.close();
});

describe('login endpoint', () => {
  it('sets an HttpOnly, SameSite=Lax, Secure session cookie over HTTPS', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      req('/api/manager/login', {
        method: 'POST',
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );

    const cookie = (response.headers.getSetCookie?.() ?? []).join(' | ');
    expect(cookie).toContain(HOST_SESSION_COOKIE_NAME);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('omits Secure over plain HTTP so local dev works', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      new Request('http://localhost:8788/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    const cookie = (response.headers.getSetCookie?.() ?? []).join(' | ');
    expect(cookie).toContain(SESSION_COOKIE_NAME);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).not.toContain('Secure');
  });

  it('returns the admin and never a secret', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      req('/api/manager/login', {
        method: 'POST',
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    const body = (await response.json()) as { admin: Record<string, unknown> };
    expect(body.admin.email).toBe(EMAIL);
    expect(body.admin.displayName).toBe('Ada Lovelace');

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('pbkdf2');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('tokenHash');
  });

  it('returns INVALID_CREDENTIALS with no cookie for bad credentials', async () => {
    await seedAdmin();
    for (const payload of [
      { email: EMAIL, password: 'wrong' },
      { email: 'ghost@example.com', password: PASSWORD },
    ]) {
      const { response } = await invoke(
        loginHandler as never,
        req('/api/manager/login', { method: 'POST', body: JSON.stringify(payload) }),
      );
      expect(response.status).toBe(401);
      expect(response.headers.get('Set-Cookie')).toBeNull();
      const body = (await response.json()) as ApiErrorBody;
      expect(body.error.code).toBe('INVALID_CREDENTIALS');
    }
  });

  it('refuses suspended and disabled accounts', async () => {
    await seedAdmin('sus@example.com', 'SUSPENDED');
    await seedAdmin('off@example.com', 'DISABLED');

    const suspended = await invoke(
      loginHandler as never,
      req('/api/manager/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'sus@example.com', password: PASSWORD }),
      }),
    );
    expect(suspended.response.status).toBe(403);
    expect(((await suspended.response.json()) as ApiErrorBody).error.code).toBe(
      'ADMIN_SUSPENDED',
    );

    const disabled = await invoke(
      loginHandler as never,
      req('/api/manager/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'off@example.com', password: PASSWORD }),
      }),
    );
    expect(disabled.response.status).toBe(403);
    expect(((await disabled.response.json()) as ApiErrorBody).error.code).toBe(
      'ADMIN_DISABLED',
    );
  });

  it('rejects a malformed payload without leaking which field failed', async () => {
    const { response } = await invoke(
      loginHandler as never,
      req('/api/manager/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'not-an-email' }),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.fields).toBeUndefined();
  });
});

describe('middleware', () => {
  it('rejects a protected route with no session', async () => {
    for (const path of [
      '/api/manager/me',
      '/api/manager/logout',
      '/api/attendees',
      '/api/attendees/abc',
      '/api/metrics',
      '/api/raffle/draw',
      '/api/raffle/current',
    ]) {
      const { response, nextCalled } = await invoke(onRequest as never, req(path));
      expect(response.status, `${path} must be protected`).toBe(401);
      expect(nextCalled, `${path} must not reach its handler`).toBe(false);
    }
  });

  it('lets a valid session through and publishes the actor', async () => {
    const adminId = await seedAdmin();
    const token = await loginAndGetToken();

    const { response, data, nextCalled } = await invoke(
      onRequest as never,
      withCookie('/api/attendees', token),
    );

    expect(response.status).toBe(200);
    expect(nextCalled).toBe(true);

    const admin = data.admin as Record<string, unknown>;
    expect(admin).toBeDefined();
    expect(admin.id).toBe(adminId);
    expect(admin.email).toBe(EMAIL);
    expect(admin.displayName).toBe('Ada Lovelace');
    expect(admin.role).toBe('ADMIN');
    expect(admin.sessionId).toEqual(expect.any(String));
  });

  it('leaves public routes public', async () => {
    for (const path of ['/api/register', '/api/manager/login', '/events', '/']) {
      const { response, nextCalled } = await invoke(onRequest as never, req(path));
      expect(response.status, path).toBe(200);
      expect(nextCalled, path).toBe(true);
    }
  });

  it('rejects a revoked session', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();

    // Authenticate, then log out through the real handler.
    const gate = await invoke(onRequest as never, withCookie('/api/manager/logout', token));
    await invoke(
      logoutHandler as never,
      withCookie('/api/manager/logout', token, { method: 'POST' }),
      gate.data,
    );

    const { response, nextCalled } = await invoke(
      onRequest as never,
      withCookie('/api/metrics', token),
    );
    expect(response.status).toBe(401);
    expect(nextCalled).toBe(false);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('SESSION_REVOKED');
  });

  it('rejects an expired session', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();
    db.raw
      .prepare("UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00.000Z'")
      .run();

    const { response, nextCalled } = await invoke(
      onRequest as never,
      withCookie('/api/metrics', token),
    );
    expect(response.status).toBe(401);
    expect(nextCalled).toBe(false);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('SESSION_EXPIRED');
  });

  it('rejects an unknown or tampered token', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();
    const tampered = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;

    for (const candidate of ['completely-made-up', tampered]) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        withCookie('/api/metrics', candidate),
      );
      expect(response.status).toBe(401);
      expect(nextCalled).toBe(false);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('SESSION_INVALID');
    }
  });

  it('cuts off an admin suspended mid-session', async () => {
    const adminId = await seedAdmin();
    const token = await loginAndGetToken();

    expect((await invoke(onRequest as never, withCookie('/api/metrics', token))).nextCalled).toBe(
      true,
    );

    db.raw.prepare('UPDATE admin_users SET status = ? WHERE id = ?').run('SUSPENDED', adminId);

    const { response, nextCalled } = await invoke(
      onRequest as never,
      withCookie('/api/metrics', token),
    );
    expect(response.status).toBe(401);
    expect(nextCalled).toBe(false);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('ADMIN_SUSPENDED');
  });

  it('cuts off an admin disabled mid-session', async () => {
    const adminId = await seedAdmin();
    const token = await loginAndGetToken();
    db.raw.prepare('UPDATE admin_users SET status = ? WHERE id = ?').run('DISABLED', adminId);

    const { response } = await invoke(onRequest as never, withCookie('/api/metrics', token));
    expect(response.status).toBe(401);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('ADMIN_DISABLED');
  });

  it('ignores an Authorization bearer header (cookies only)', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();

    const { response } = await invoke(
      onRequest as never,
      req('/api/metrics', { headers: { Authorization: `Bearer ${token}` } }),
    );
    // The legacy transport must not authenticate anything any more.
    expect(response.status).toBe(401);
  });
});

describe('me endpoint', () => {
  it('returns the authenticated admin without secrets', async () => {
    const adminId = await seedAdmin();
    const token = await loginAndGetToken();

    const gate = await invoke(onRequest as never, withCookie('/api/manager/me', token));
    const { response } = await invoke(
      meHandler as never,
      withCookie('/api/manager/me', token),
      gate.data,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { admin: Record<string, unknown> };
    expect(body.admin.id).toBe(adminId);
    expect(body.admin.email).toBe(EMAIL);
    expect(body.admin.status).toBe('ACTIVE');
    expect(body.admin.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('pbkdf2');
    expect(raw).not.toContain('password');
    expect(raw).not.toContain(token);
  });
});

describe('logout endpoint', () => {
  it('revokes the session and clears the cookie', async () => {
    await seedAdmin();
    const token = await loginAndGetToken();

    const gate = await invoke(onRequest as never, withCookie('/api/manager/logout', token));
    const { response } = await invoke(
      logoutHandler as never,
      withCookie('/api/manager/logout', token, { method: 'POST' }),
      gate.data,
    );

    expect(response.status).toBe(200);
    const cookie = (response.headers.getSetCookie?.() ?? []).join(' | ');
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');

    const row = db.raw
      .prepare('SELECT revoked_at FROM admin_sessions LIMIT 1')
      .get() as { revoked_at: string | null };
    expect(row.revoked_at).not.toBeNull();

    // And the token is immediately unusable.
    const after = await invoke(onRequest as never, withCookie('/api/metrics', token));
    expect(after.response.status).toBe(401);
  });

  it('cannot be called without a session', async () => {
    const { response, nextCalled } = await invoke(
      onRequest as never,
      req('/api/manager/logout', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    expect(nextCalled).toBe(false);
  });
});

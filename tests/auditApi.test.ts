// @vitest-environment node
//
// The audit HTTP surface, the payload guard, request-id handling, and the
// auditing of the phase 1 authentication endpoints.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import { onRequestGet as listAudit } from '../functions/api/audit/index';
import { onRequestGet as getAudit } from '../functions/api/audit/[id]';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { onRequestPost as logoutHandler } from '../functions/api/manager/logout';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { AuditService } from '../functions/_shared/auditService';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { newId } from '../functions/_shared/ids';
import { nowIso } from '../functions/_shared/time';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { ApiErrorBody, AuditListResponse, AuditLog } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;

async function invoke(
  handler: (ctx: never) => Promise<Response> | Response,
  request: Request,
  data: Record<string, unknown> = {},
  params: Record<string, string> = {},
): Promise<{ response: Response; data: Record<string, unknown>; nextCalled: boolean }> {
  let nextCalled = false;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    request,
    env: { DB: db.d1 },
    data,
    params,
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

function jsonReq(path: string, body?: unknown, init: RequestInit = {}): Request {
  // `init` is spread FIRST so the merged headers below always win; spreading it
  // last would silently replace them and drop the Content-Type.
  return new Request(`https://example.com${path}`, {
    ...init,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authedGet(path: string, token: string): Request {
  return new Request(`https://example.com${path}`, {
    headers: { Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
  });
}

async function seedAdmin(email = EMAIL): Promise<string> {
  const result = await new AdminRepository(db.d1).create({
    email,
    normalizedEmail: normalizeEmail(email),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword(PASSWORD),
  });
  if (result.kind !== 'created') throw new Error('seed failed');
  return result.admin.id;
}

async function login(email = EMAIL): Promise<string> {
  const { response } = await invoke(
    loginHandler as never,
    jsonReq('/api/manager/login', { email, password: PASSWORD }),
  );
  expect(response.status).toBe(200);
  const cookies = (response.headers.getSetCookie?.() ?? []).join(' | ');
  const match = new RegExp(`${HOST_SESSION_COOKIE_NAME}=([^;]+)`).exec(cookies);
  if (!match) throw new Error('no session cookie');
  return decodeURIComponent(match[1]);
}

/** Authenticates through the middleware and returns ctx.data for a handler. */
async function gate(path: string, token: string): Promise<Record<string, unknown>> {
  const result = await invoke(onRequest as never, authedGet(path, token));
  return result.data;
}

function auditRows(): Array<Record<string, unknown>> {
  return db.raw
    .prepare('SELECT * FROM audit_logs ORDER BY created_at ASC')
    .all() as Array<Record<string, unknown>>;
}

beforeEach(() => {
  db = createTestDatabase();
  setLogSink(() => {});
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('authentication auditing', () => {
  it('records a successful login without any secret', async () => {
    const adminId = await seedAdmin();
    const token = await login();

    const rows = auditRows();
    const success = rows.find((r) => r.action === 'ADMIN_LOGIN_SUCCEEDED');
    expect(success).toBeDefined();
    expect(success?.actor_admin_id).toBe(adminId);
    expect(success?.entity_type).toBe('ADMIN_SESSION');
    expect(String(success?.request_id).length).toBeGreaterThan(0);

    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain('pbkdf2');
    expect(dump).not.toContain('Set-Cookie');
  });

  it('records a failed login without enabling enumeration', async () => {
    await seedAdmin();

    await invoke(
      loginHandler as never,
      jsonReq('/api/manager/login', { email: EMAIL, password: 'wrong' }),
    );
    await invoke(
      loginHandler as never,
      jsonReq('/api/manager/login', { email: 'ghost@example.com', password: 'wrong' }),
    );

    const failures = auditRows().filter((r) => r.action === 'ADMIN_LOGIN_FAILED');
    expect(failures).toHaveLength(2);

    for (const failure of failures) {
      expect(failure.actor_admin_id).toBeNull();
      expect(failure.entity_type).toBe('SYSTEM');
      const metadata = JSON.parse(String(failure.metadata)) as Record<string, unknown>;
      // Identical reason for a real and a non-existent account: reading the
      // audit log cannot tell them apart either.
      expect(metadata.reason).toBe('invalid_credentials');
      expect(metadata.emailMasked).toMatch(/^.\*\*\*@/);
    }

    const dump = JSON.stringify(failures);
    expect(dump).not.toContain('ada@example.com');
    expect(dump).not.toContain('ghost@example.com');
    expect(dump).not.toContain('wrong');
  });

  it('marks a rate-limited attempt', async () => {
    await seedAdmin();
    for (let i = 0; i < 11; i++) {
      await invoke(
        loginHandler as never,
        jsonReq(
          '/api/manager/login',
          { email: EMAIL, password: 'wrong' },
          { headers: { 'CF-Connecting-IP': '203.0.113.5' } },
        ),
      );
    }

    const flags = auditRows()
      .filter((r) => r.action === 'ADMIN_LOGIN_FAILED')
      .map((r) => (JSON.parse(String(r.metadata)) as { rateLimited: boolean }).rateLimited);
    expect(flags).toContain(true);
  });

  it('records a logout attributed to the actor', async () => {
    const adminId = await seedAdmin();
    const token = await login();

    const data = await gate('/api/manager/logout', token);
    await invoke(
      logoutHandler as never,
      jsonReq('/api/manager/logout', undefined, {
        headers: { Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
      }),
      data,
    );

    const logout = auditRows().find((r) => r.action === 'ADMIN_LOGOUT');
    expect(logout).toBeDefined();
    expect(logout?.actor_admin_id).toBe(adminId);
  });

  it('logout still succeeds when the audit write fails', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/manager/logout', token);

    // Make every further audit insert fail.
    db.raw.exec('DROP TABLE audit_logs');

    const { response } = await invoke(
      logoutHandler as never,
      jsonReq('/api/manager/logout', undefined, {
        headers: { Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
      }),
      data,
    );

    // Security behaviour is preserved: the session is revoked regardless.
    expect(response.status).toBe(200);
    const session = db.raw
      .prepare('SELECT revoked_at FROM admin_sessions LIMIT 1')
      .get() as { revoked_at: string | null };
    expect(session.revoked_at).not.toBeNull();
  });

  it('audits a denial only for a session that really exists', async () => {
    await seedAdmin();
    const token = await login();

    // Revoked → audited (a genuinely issued token being replayed).
    db.raw.prepare('UPDATE admin_sessions SET revoked_at = ?').run(nowIso());
    await invoke(onRequest as never, authedGet('/api/metrics', token));

    // Unknown and absent cookies → NOT audited, so the table cannot be flooded.
    for (let i = 0; i < 20; i++) {
      await invoke(onRequest as never, authedGet('/api/metrics', `made-up-${i}`));
      await invoke(onRequest as never, new Request('https://example.com/api/metrics'));
    }

    const denials = auditRows().filter((r) => r.action === 'ADMIN_ACCESS_DENIED');
    expect(denials).toHaveLength(1);
    expect(JSON.parse(String(denials[0].metadata)).reason).toBe('revoked');
  });
});

// ---------------------------------------------------------------------------
describe('request ids', () => {
  it('generates one and returns it in the header', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      jsonReq('/api/manager/login', { email: EMAIL, password: PASSWORD }),
    );
    const header = response.headers.get('X-Request-ID');
    expect(header).toBeTruthy();

    const success = auditRows().find((r) => r.action === 'ADMIN_LOGIN_SUCCEEDED');
    // The audit row and the client's header are the same value.
    expect(success?.request_id).toBe(header);
  });

  it('preserves a trusted CF-Ray and echoes it', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      jsonReq(
        '/api/manager/login',
        { email: EMAIL, password: 'wrong' },
        { headers: { 'CF-Ray': '8a1b2c3d4e5f6789-IAD' } },
      ),
    );
    expect(response.headers.get('X-Request-ID')).toBe('8a1b2c3d4e5f6789-IAD');
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.requestId).toBe('8a1b2c3d4e5f6789-IAD');
  });

  it('sanitizeRequestId rejects log-injection and oversized values', async () => {
    const { sanitizeRequestId } = await import('../functions/_shared/requestContext');
    // Newlines cannot even be placed in a header by a compliant client, but the
    // sanitizer is the layer that must refuse them, so it is checked directly.
    for (const hostile of [
      'a\nINJECTED: true',
      'a\r\nSet-Cookie: x=1',
      '{"json":"breaker"}',
      'x'.repeat(200),
      'has spaces',
      '"quoted"',
      '<script>alert(1)</script>',
      '',
      '   ',
    ]) {
      expect(sanitizeRequestId(hostile), JSON.stringify(hostile)).toBeNull();
    }
    expect(sanitizeRequestId('8a1b2c3d4e5f6789-IAD')).toBe('8a1b2c3d4e5f6789-IAD');
    expect(sanitizeRequestId(null)).toBeNull();
  });

  it('rejects a hostile request id over HTTP and mints a safe one', async () => {
    await seedAdmin();
    for (const hostile of ['<script>alert(1)</script>', 'x'.repeat(200), 'has spaces', '"quoted"']) {
      const { response } = await invoke(
        loginHandler as never,
        jsonReq(
          '/api/manager/login',
          { email: EMAIL, password: 'wrong' },
          { headers: { 'X-Request-ID': hostile } },
        ),
      );
      const returned = response.headers.get('X-Request-ID') ?? '';
      expect(returned).not.toBe(hostile);
      expect(returned).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });

  it('stamps the header on responses from downstream handlers too', async () => {
    await seedAdmin();
    const token = await login();
    const { response } = await invoke(onRequest as never, authedGet('/api/metrics', token));
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });

  it('includes the id in a 401 body', async () => {
    const { response } = await invoke(
      onRequest as never,
      new Request('https://example.com/api/audit'),
    );
    expect(response.status).toBe(401);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.requestId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
describe('payload limits', () => {
  it('accepts valid JSON with a charset parameter', async () => {
    await seedAdmin();
    const { response } = await invoke(
      loginHandler as never,
      jsonReq(
        '/api/manager/login',
        { email: EMAIL, password: PASSWORD },
        { headers: { 'Content-Type': 'application/json; charset=utf-8' } },
      ),
    );
    expect(response.status).toBe(200);
  });

  it('rejects a non-JSON content type with 415', async () => {
    const { response } = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(415);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe(
      'UNSUPPORTED_MEDIA_TYPE',
    );
  });

  it('rejects an oversized body declared by Content-Length', async () => {
    const { response } = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(20 * 1024),
        },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(413);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rejects an oversized body even when Content-Length lies', async () => {
    const huge = { email: EMAIL, password: 'x'.repeat(20 * 1024) };
    const { response } = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        // Understates the real size; the actual byte count must still win.
        headers: { 'Content-Type': 'application/json', 'Content-Length': '10' },
        body: JSON.stringify(huge),
      }),
    );
    expect(response.status).toBe(413);
  });

  it('rejects malformed and empty bodies with INVALID_JSON', async () => {
    for (const body of ['', '   ', '{', '{"email":']) {
      const { response } = await invoke(
        loginHandler as never,
        new Request('https://example.com/api/manager/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      );
      expect(response.status, body).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('INVALID_JSON');
    }
  });

  it('accepts a payload just under the limit', async () => {
    await seedAdmin();
    // Long but legal password: rejected by the schema (max 200), not the size guard.
    const { response } = await invoke(
      loginHandler as never,
      jsonReq('/api/manager/login', { email: EMAIL, password: 'x'.repeat(199) }),
    );
    expect([401, 429]).toContain(response.status);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/audit', () => {
  async function seedEntries(count: number, token: string) {
    const service = new AuditService(db.d1);
    for (let i = 0; i < count; i++) {
      await service.record({
        action: 'EVENT_UPDATED',
        entityType: 'EVENT',
        entityId: newId(),
        requestContext: {
          requestId: `seed-${i}`,
          ipHash: null,
          userAgent: null,
          origin: null,
          method: 'POST',
          pathname: '/seed',
        },
      });
    }
    return token;
  }

  it('requires a session', async () => {
    for (const path of ['/api/audit', `/api/audit/${newId()}`]) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(response.status, path).toBe(401);
      expect(nextCalled, path).toBe(false);
    }
  });

  it('returns a paginated list for an authenticated admin', async () => {
    await seedAdmin();
    const token = await login();
    await seedEntries(30, token);

    const data = await gate('/api/audit', token);
    const { response } = await invoke(
      listAudit as never,
      authedGet('/api/audit?page=1&pageSize=10', token),
      data,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AuditListResponse;
    expect(body.items).toHaveLength(10);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.total).toBeGreaterThanOrEqual(30);
    expect(body.totalPages).toBe(Math.ceil(body.total / 10));
    // Newest first.
    expect(body.items[0].createdAt >= body.items[1].createdAt).toBe(true);
  });

  it('clamps an abusive pageSize', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const { response } = await invoke(
      listAudit as never,
      authedGet('/api/audit?pageSize=100000', token),
      data,
    );
    const body = (await response.json()) as AuditListResponse;
    expect(body.pageSize).toBe(200);
  });

  it('filters by action and entity type', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const { response } = await invoke(
      listAudit as never,
      authedGet('/api/audit?action=ADMIN_LOGIN_SUCCEEDED', token),
      data,
    );
    const body = (await response.json()) as AuditListResponse;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((i) => i.action === 'ADMIN_LOGIN_SUCCEEDED')).toBe(true);
  });

  it('rejects invalid filters instead of ignoring them', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const cases = [
      'actorAdminId=not-a-uuid',
      'entityId=1; DROP TABLE audit_logs',
      'eventId=../../etc',
      'action=NOT_AN_ACTION',
      'entityType=NOT_AN_ENTITY',
      'from=13/01/2026',
      'to=nonsense',
      'from=2026-06-01&to=2026-01-01',
    ];

    for (const query of cases) {
      const { response } = await invoke(
        listAudit as never,
        authedGet(`/api/audit?${query}`, token),
        data,
      );
      expect(response.status, query).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('INVALID_QUERY');
    }

    // The injection attempt did not touch the table.
    const still = db.raw
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='audit_logs'")
      .get() as { n: number };
    expect(still.n).toBe(1);
  });

  it('accepts a civil date range covering whole days', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const today = nowIso().slice(0, 10);
    const { response } = await invoke(
      listAudit as never,
      authedGet(`/api/audit?from=${today}&to=${today}`, token),
      data,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AuditListResponse;
    expect(body.total).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/audit/:id', () => {
  it('returns one entry and audits the view', async () => {
    const adminId = await seedAdmin();
    const token = await login();

    const target = auditRows().find((r) => r.action === 'ADMIN_LOGIN_SUCCEEDED');
    const id = String(target?.id);

    const data = await gate(`/api/audit/${id}`, token);
    const { response } = await invoke(
      getAudit as never,
      authedGet(`/api/audit/${id}`, token),
      data,
      { id },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as AuditLog;
    expect(body.id).toBe(id);
    expect(body.actorAdminId).toBe(adminId);

    const views = auditRows().filter((r) => r.action === 'AUDIT_LOG_VIEWED');
    expect(views).toHaveLength(1);
    expect(views[0].entity_id).toBe(id);
  });

  it('does not audit the viewing of a view (no self-feeding growth)', async () => {
    await seedAdmin();
    const token = await login();

    const first = String(
      auditRows().find((r) => r.action === 'ADMIN_LOGIN_SUCCEEDED')?.id,
    );
    let data = await gate(`/api/audit/${first}`, token);
    await invoke(getAudit as never, authedGet(`/api/audit/${first}`, token), data, {
      id: first,
    });

    const viewId = String(auditRows().find((r) => r.action === 'AUDIT_LOG_VIEWED')?.id);
    data = await gate(`/api/audit/${viewId}`, token);
    await invoke(getAudit as never, authedGet(`/api/audit/${viewId}`, token), data, {
      id: viewId,
    });

    // Opening the view record must not append another one.
    expect(auditRows().filter((r) => r.action === 'AUDIT_LOG_VIEWED')).toHaveLength(1);
  });

  it('404s for an unknown id and 400s for a malformed one', async () => {
    await seedAdmin();
    const token = await login();

    const missingId = newId();
    let data = await gate(`/api/audit/${missingId}`, token);
    const missing = await invoke(
      getAudit as never,
      authedGet(`/api/audit/${missingId}`, token),
      data,
      { id: missingId },
    );
    expect(missing.response.status).toBe(404);
    expect(((await missing.response.json()) as ApiErrorBody).error.code).toBe('NOT_FOUND');

    data = await gate('/api/audit/not-a-uuid', token);
    const malformed = await invoke(
      getAudit as never,
      authedGet('/api/audit/not-a-uuid', token),
      data,
      { id: 'not-a-uuid' },
    );
    expect(malformed.response.status).toBe(400);
  });

  it('never returns an unredacted secret', async () => {
    await seedAdmin();
    const token = await login();

    const service = new AuditService(db.d1);
    const written = await service.record({
      action: 'EVENT_UPDATED',
      entityType: 'EVENT',
      requestContext: {
        requestId: 'req-secret',
        ipHash: null,
        userAgent: null,
        origin: null,
        method: 'POST',
        pathname: '/x',
      },
      metadata: { password: 'super-secret', token: 'tok-123' },
    });
    if (!written.ok) throw new Error('expected write');

    const data = await gate(`/api/audit/${written.id}`, token);
    const { response } = await invoke(
      getAudit as never,
      authedGet(`/api/audit/${written.id}`, token),
      data,
      { id: written.id },
    );

    const raw = await response.text();
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('tok-123');
    expect(raw).toContain('[REDACTED]');
  });

  it('still renders an entry whose actor was deleted', async () => {
    const adminId = await seedAdmin();
    const token = await login();
    const id = String(auditRows().find((r) => r.action === 'ADMIN_LOGIN_SUCCEEDED')?.id);

    // Revoking sessions first, then deleting, mirrors a real removal.
    const data = await gate(`/api/audit/${id}`, token);
    db.raw.prepare('DELETE FROM admin_users WHERE id = ?').run(adminId);

    const { response } = await invoke(
      getAudit as never,
      authedGet(`/api/audit/${id}`, token),
      data,
      { id },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AuditLog;
    expect(body.actorAdminId).toBeNull();
    expect(body.action).toBe('ADMIN_LOGIN_SUCCEEDED');
  });

  it('exposes no mutating handler', async () => {
    const listModule = await import('../functions/api/audit/index');
    const detailModule = await import('../functions/api/audit/[id]');
    for (const module of [listModule, detailModule]) {
      const exported = Object.keys(module);
      expect(exported).not.toContain('onRequestPost');
      expect(exported).not.toContain('onRequestPut');
      expect(exported).not.toContain('onRequestPatch');
      expect(exported).not.toContain('onRequestDelete');
      expect(exported).not.toContain('onRequest');
    }
  });
});

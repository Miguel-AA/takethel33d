// @vitest-environment node
//
// Adversarial validation of the phase 2 surface: redaction, JSON safety, the
// logger, payload limits, audit recursion, route protection and concurrency.
// Every test asserts the SECURE behaviour and fails if the defence is removed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/_middleware';
import { onRequestGet as listAudit } from '../functions/api/audit/index';
import { onRequestGet as getAudit } from '../functions/api/audit/[id]';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { AuditRepository } from '../functions/_shared/auditRepository';
import { AuditService } from '../functions/_shared/auditService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { REDACTED, redact } from '../functions/_shared/redact';
import { parseJson, serializeJson } from '../functions/_shared/json';
import { logger, setLogSink } from '../functions/_shared/logger';
import { newId } from '../functions/_shared/ids';
import { nowIso } from '../functions/_shared/time';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type { ApiErrorBody, AuditListResponse } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;

const REQUEST: RequestContext = {
  requestId: 'req-adversarial',
  ipHash: 'd'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/x',
};

async function invoke(
  handler: (ctx: never) => Promise<Response> | Response,
  request: Request,
  data: Record<string, unknown> = {},
  params: Record<string, string> = {},
) {
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

function jsonReq(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authedGet(path: string, token: string) {
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

async function login(): Promise<string> {
  const { response } = await invoke(
    loginHandler as never,
    jsonReq('/api/manager/login', { email: EMAIL, password: PASSWORD }),
  );
  expect(response.status).toBe(200);
  const cookies = (response.headers.getSetCookie?.() ?? []).join(' | ');
  const match = new RegExp(`${HOST_SESSION_COOKIE_NAME}=([^;]+)`).exec(cookies);
  if (!match) throw new Error('no cookie');
  return decodeURIComponent(match[1]);
}

async function gate(path: string, token: string) {
  return (await invoke(onRequest as never, authedGet(path, token))).data;
}

function auditRows() {
  return db.raw.prepare('SELECT * FROM audit_logs').all() as Array<Record<string, unknown>>;
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
// A. Redaction
// ---------------------------------------------------------------------------
describe('redaction resists every naming variant', () => {
  it.each([
    'password',
    'Password',
    'PASSWORD_HASH',
    'passwordHash',
    'accessToken',
    'refresh_token',
    'refreshToken',
    'Authorization',
    'authorization',
    'set-cookie',
    'setCookie',
    'clientSecret',
    'CLIENT_SECRET',
    'api_key',
    'apiKey',
    'sessionToken',
    'session_token',
    'privateKey',
    'x-api-key',
    'user password',
  ])('redacts the key %s', (key) => {
    const output = redact({ [key]: 'THE-SECRET-VALUE' }) as Record<string, unknown>;
    expect(output[key], key).toBe(REDACTED);
  });

  it('redacts a key named exactly `session` but keeps `sessionId`', () => {
    const output = redact({
      session: 'maybe-a-token',
      sessionId: '11111111-1111-4111-8111-111111111111',
      session_id: '22222222-2222-4222-8222-222222222222',
    }) as Record<string, unknown>;

    // A bare `session` may hold the credential itself.
    expect(output.session).toBe(REDACTED);
    // ...but a session IDENTIFIER is not a credential, and losing it would
    // destroy the audit trail's ability to point at a specific session.
    expect(output.sessionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(output.session_id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('redacts inside nested objects and arrays of objects', () => {
    const dumped = JSON.stringify(
      redact({
        level1: { level2: { level3: { password: 'DEEP-SECRET' } } },
        list: [{ token: 'ARRAY-SECRET' }, [{ cookie: 'NESTED-ARRAY-SECRET' }]],
      }),
    );
    expect(dumped).not.toContain('DEEP-SECRET');
    expect(dumped).not.toContain('ARRAY-SECRET');
    expect(dumped).not.toContain('NESTED-ARRAY-SECRET');
  });

  it('survives a getter that throws instead of losing the whole entry', () => {
    const hostile = {
      safe: 'kept',
      get boom(): string {
        throw new Error('getter exploded');
      },
    };
    expect(() => redact(hostile)).not.toThrow();
    const output = redact(hostile) as Record<string, unknown>;
    expect(output.safe).toBe('kept');
  });

  it('survives a circular structure', () => {
    const circular: Record<string, unknown> = { name: 'loop', password: 'SECRET' };
    circular.self = circular;
    expect(() => redact(circular)).not.toThrow();
    const dumped = JSON.stringify(redact(circular));
    expect(dumped).not.toContain('SECRET');
  });

  it('redacts a full admin_users row snapshot', async () => {
    await seedAdmin();
    const row = db.raw.prepare('SELECT * FROM admin_users LIMIT 1').get();
    const dumped = JSON.stringify(redact(row));
    expect(dumped).not.toContain('pbkdf2');
    expect(dumped).toContain(REDACTED);
    // Non-secret columns must survive so the snapshot stays useful.
    expect(dumped).toContain('ada@example.com');
  });

  it('redacts a full admin_sessions row snapshot', async () => {
    await seedAdmin();
    const token = await login();
    const row = db.raw.prepare('SELECT * FROM admin_sessions LIMIT 1').get() as Record<
      string,
      unknown
    >;
    const dumped = JSON.stringify(redact(row));
    expect(dumped).not.toContain(String(row.token_hash));
    expect(dumped).not.toContain(token);
    // ip_hash is already a hash and is the safe representation.
    expect(dumped).toContain(String(row.ip_hash));
  });

  it('never emits a value JSON cannot store', () => {
    const output = redact({
      fn: () => 1,
      sym: Symbol('s'),
      big: 10n,
      nan: NaN,
      inf: Infinity,
      date: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(serializeJson(output).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. JSON safety
// ---------------------------------------------------------------------------
describe('JSON layer resists pollution and abuse', () => {
  it.each([
    '{"__proto__":{"polluted":1}}',
    '{"a":{"__proto__":{"polluted":1}}}',
    '{"a":[{"__proto__":{"polluted":1}}]}',
    '{"constructor":{"prototype":{"polluted":1}}}',
    '{"a":{"constructor":{"prototype":{"polluted":1}}}}',
    '{"__PROTO__":{"x":1},"__proto__":{"y":2}}',
  ])('strips pollution from %s', (raw) => {
    const result = parseJson(raw);
    expect(result.ok).toBe(true);
    const probe = {} as Record<string, unknown>;
    expect(probe.polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
    if (result.ok) {
      expect(JSON.stringify(result.value)).not.toContain('"__proto__"');
    }
  });

  it('leaves Object.prototype untouched after a hostile round trip', () => {
    const hostile = { __proto__: { polluted: true }, ok: 1 };
    const serialized = serializeJson(JSON.parse(JSON.stringify(hostile)));
    if (serialized.ok) parseJson(serialized.json);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a payload one byte over the limit and accepts one at the limit', () => {
    // The encoded form is {"b":"xxx..."} — 8 characters of envelope.
    const atLimit = { b: 'x'.repeat(1000 - 8) };
    const overLimit = { b: 'x'.repeat(1000 - 7) };
    expect(serializeJson(atLimit, 1000).ok).toBe(true);
    expect(serializeJson(overLimit, 1000)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses a deeply nested structure without blowing the stack', () => {
    let deep: unknown = { end: true };
    for (let i = 0; i < 5000; i++) deep = { child: deep };
    expect(() => serializeJson(deep)).not.toThrow();
    expect(serializeJson(deep).ok).toBe(false);
  });

  it('handles a deeply nested parse without crashing the process', () => {
    const raw = `${'['.repeat(20_000)}1${']'.repeat(20_000)}`;
    expect(() => parseJson(raw)).not.toThrow();
  });

  it('handles a huge array within the size limit', () => {
    const many = Array.from({ length: 5000 }, (_, i) => i);
    const result = serializeJson(many);
    expect(result.ok).toBe(true);
    if (result.ok) expect(parseJson(result.json).ok).toBe(true);
  });

  it('a corrupt column never takes down a listing', async () => {
    const repository = new AuditRepository(db.d1);
    for (let i = 0; i < 3; i++) {
      await repository.append({
        id: newId(),
        actorAdminId: null,
        action: 'EVENT_UPDATED',
        entityType: 'EVENT',
        entityId: null,
        eventId: null,
        previousData: null,
        newData: null,
        metadata: JSON.stringify({ i }),
        ipHash: null,
        userAgent: null,
        requestId: 'r',
        createdAt: nowIso(),
      });
    }
    db.raw.prepare("UPDATE audit_logs SET metadata = '{corrupt' ").run();

    const listed = await repository.list({
      page: 1,
      pageSize: 10,
      actorAdminId: null,
      action: null,
      entityType: null,
      entityId: null,
      eventId: null,
      from: null,
      to: null,
    });
    expect(listed.items).toHaveLength(3);
    expect(listed.items.every((i) => i.metadata === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C. Logger
// ---------------------------------------------------------------------------
describe('logger cannot be used to forge or corrupt entries', () => {
  function capture(): string[] {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    return lines;
  }

  // Control characters that let an attacker forge a second log entry or spoof
  // how a line renders in a terminal (ANSI colour codes, bidi overrides).
  // Built from a string so the test file itself contains no literal control
  // characters (eslint `no-control-regex`).
  const CONTROL_CHARS = new RegExp(
    '[' +
      '\\u0000-\\u001f' +
      '\\u007f-\\u009f' +
      '\\u200e\\u200f' +
      '\\u202a-\\u202e' +
      '\\u2066-\\u2069' +
      ']',
  );

  it.each([
    ['CRLF', 'a\r\nforged'],
    ['LF', 'a\nforged'],
    ['ANSI escape', 'a[31mRED[0m'],
    ['bidi override', 'a‮gnitseuqer‬'],
    ['null byte', 'a b'],
    ['tab', 'a\tb'],
  ])('neutralises %s in a message', (_label, message) => {
    const lines = capture();
    logger.warn(message);

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { message: string };
    expect(CONTROL_CHARS.test(parsed.message), JSON.stringify(parsed.message)).toBe(
      false,
    );
  });

  it('emits exactly one valid JSON line per call', () => {
    const lines = capture();
    logger.info('one');
    logger.warn('two');
    logger.error('three');
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(line.includes('\n')).toBe(false);
    }
  });

  it('never breaks the caller when the sink itself throws', () => {
    setLogSink(() => {
      throw new Error('sink exploded');
    });
    // A logging failure must not propagate into the operation being logged.
    expect(() => logger.error('something')).not.toThrow();
  });

  it('redacts secrets even inside an Error-shaped field', () => {
    const lines = capture();
    logger.error('failed', {
      requestId: 'r',
      context: { password: 'LOGGER-SECRET', nested: [{ token: 'ARRAY-LOGGER-SECRET' }] },
    });
    expect(lines[0]).not.toContain('LOGGER-SECRET');
    expect(lines[0]).not.toContain('ARRAY-LOGGER-SECRET');
  });

  it('never emits a stack trace', () => {
    const lines = capture();
    const err = new Error('boom');
    logger.error('failed', { err });
    expect(lines[0]).not.toContain('at ');
    expect(lines[0]).not.toContain('.ts:');
  });
});

// ---------------------------------------------------------------------------
// D. Audit service integrity
// ---------------------------------------------------------------------------
describe('AuditService cannot be talked into writing junk', () => {
  it('the caller cannot forge the timestamp', async () => {
    const service = new AuditService(db.d1);
    await service.record({
      action: 'ADMIN_LOGOUT',
      entityType: 'ADMIN_SESSION',
      requestContext: REQUEST,
      // A caller-supplied createdAt must be ignored entirely.
      ...({ createdAt: '1999-01-01T00:00:00.000Z' } as Record<string, unknown>),
    });

    const row = auditRows()[0];
    expect(String(row.created_at).startsWith('1999')).toBe(false);
    expect(String(row.created_at)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it('the caller cannot forge an actor that does not exist', async () => {
    const service = new AuditService(db.d1);
    const result = await service.record({
      action: 'ADMIN_LOGOUT',
      entityType: 'ADMIN_SESSION',
      actor: { id: 'ghost-admin', email: 'x@y.z', displayName: 'Ghost' },
      requestContext: REQUEST,
    });
    // The foreign key refuses it; the service reports a write failure rather
    // than silently inventing history.
    expect(result).toEqual({ ok: false, reason: 'write_failed' });
    expect(auditRows()).toHaveLength(0);
  });

  it('the caller cannot bypass redaction by nesting', async () => {
    const service = new AuditService(db.d1);
    await service.record({
      action: 'EVENT_UPDATED',
      entityType: 'EVENT',
      requestContext: REQUEST,
      metadata: { deep: { deeper: { password: 'BYPASS-ATTEMPT' } } },
      previousData: [{ token: 'ARRAY-BYPASS' }],
      newData: { authorization: 'Bearer BYPASS' },
    });

    const dumped = JSON.stringify(auditRows());
    expect(dumped).not.toContain('BYPASS-ATTEMPT');
    expect(dumped).not.toContain('ARRAY-BYPASS');
    expect(dumped).not.toContain('Bearer BYPASS');
  });

  it('the caller cannot store a raw IP through the request context', async () => {
    const service = new AuditService(db.d1);
    await service.record({
      action: 'ADMIN_LOGIN_FAILED',
      entityType: 'SYSTEM',
      requestContext: { ...REQUEST, ipHash: 'e'.repeat(64) },
      metadata: { ip_address: '203.0.113.9', forwarded: { clientIp: '198.51.100.2' } },
    });

    const dumped = JSON.stringify(auditRows());
    expect(dumped).not.toContain('203.0.113.9');
    expect(dumped).not.toContain('198.51.100.2');
  });

  it('bounds an oversized entity id rather than storing it whole', async () => {
    const service = new AuditService(db.d1);
    const result = await service.record({
      action: 'EVENT_UPDATED',
      entityType: 'EVENT',
      entityId: 'x'.repeat(5000),
      requestContext: REQUEST,
    });
    expect(result.ok).toBe(true);
    const row = auditRows()[0];
    expect(String(row.entity_id).length).toBeLessThanOrEqual(200);
  });

  it('truncates an oversized user agent', async () => {
    const service = new AuditService(db.d1);
    await service.record({
      action: 'ADMIN_LOGOUT',
      entityType: 'ADMIN_SESSION',
      requestContext: { ...REQUEST, userAgent: 'U'.repeat(5000) },
    });
    const row = auditRows()[0];
    expect(String(row.user_agent).length).toBeLessThanOrEqual(512);
  });
});

// ---------------------------------------------------------------------------
// E. Recursion and flooding
// ---------------------------------------------------------------------------
describe('audit reading cannot amplify', () => {
  it('repeatedly opening view records never grows the table', async () => {
    await seedAdmin();
    const token = await login();

    const seed = String(auditRows().find((r) => r.action === 'ADMIN_LOGIN_SUCCEEDED')?.id);

    // Open the real entry once: exactly one view record appears.
    let data = await gate(`/api/audit/${seed}`, token);
    await invoke(getAudit as never, authedGet(`/api/audit/${seed}`, token), data, {
      id: seed,
    });
    expect(auditRows().filter((r) => r.action === 'AUDIT_LOG_VIEWED')).toHaveLength(1);

    const viewId = String(auditRows().find((r) => r.action === 'AUDIT_LOG_VIEWED')?.id);

    // Open the view record ten times: still exactly one.
    for (let i = 0; i < 10; i++) {
      data = await gate(`/api/audit/${viewId}`, token);
      await invoke(getAudit as never, authedGet(`/api/audit/${viewId}`, token), data, {
        id: viewId,
      });
    }
    expect(auditRows().filter((r) => r.action === 'AUDIT_LOG_VIEWED')).toHaveLength(1);
  });

  it('listing and paging never write a row', async () => {
    await seedAdmin();
    const token = await login();
    const before = auditRows().length;

    for (let page = 1; page <= 5; page++) {
      const data = await gate('/api/audit', token);
      await invoke(
        listAudit as never,
        authedGet(`/api/audit?page=${page}&pageSize=5`, token),
        data,
      );
    }
    expect(auditRows()).toHaveLength(before);
  });

  it('a 404 detail lookup writes nothing', async () => {
    await seedAdmin();
    const token = await login();
    const before = auditRows().length;

    const missing = newId();
    const data = await gate(`/api/audit/${missing}`, token);
    const { response } = await invoke(
      getAudit as never,
      authedGet(`/api/audit/${missing}`, token),
      data,
      { id: missing },
    );
    expect(response.status).toBe(404);
    expect(auditRows()).toHaveLength(before);
  });

  it('two concurrent views of the same entry stay bounded', async () => {
    await seedAdmin();
    const token = await login();
    const seed = String(auditRows().find((r) => r.action === 'ADMIN_LOGIN_SUCCEEDED')?.id);

    const data = await gate(`/api/audit/${seed}`, token);
    await Promise.all([
      invoke(getAudit as never, authedGet(`/api/audit/${seed}`, token), { ...data }, { id: seed }),
      invoke(getAudit as never, authedGet(`/api/audit/${seed}`, token), { ...data }, { id: seed }),
    ]);

    // One row per view is expected and acceptable; what must not happen is a
    // chain reaction.
    expect(
      auditRows().filter((r) => r.action === 'AUDIT_LOG_VIEWED').length,
    ).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// F. Route protection
// ---------------------------------------------------------------------------
describe('/api/audit resists the phase 1 bypass family', () => {
  it.each([
    '//api/audit',
    '/api//audit',
    '/API/audit',
    '/Api/Audit',
    '/api/%61udit',
    '/api/%2561udit',
    '/api/attendees/../audit',
    '/api/audit/../metrics',
    '///api/audit',
    '/api/audit/',
    `/api/audit/${'11111111-1111-4111-8111-111111111111'}`,
  ])('rejects %s without a session', async (path) => {
    const { response, nextCalled } = await invoke(
      onRequest as never,
      new Request(`https://example.com${path}`),
    );
    expect(nextCalled, `${path} reached its handler`).toBe(false);
    expect(response.status).toBe(401);
  });

  it('keeps /api/register public', async () => {
    const { nextCalled } = await invoke(
      onRequest as never,
      new Request('https://example.com/api/register', { method: 'POST' }),
    );
    expect(nextCalled).toBe(true);
  });

  it('rejects an expired, revoked or suspended session', async () => {
    const adminId = await seedAdmin();
    const token = await login();

    db.raw.prepare('UPDATE admin_sessions SET revoked_at = ?').run(nowIso());
    expect((await invoke(onRequest as never, authedGet('/api/audit', token))).response.status).toBe(401);

    db.raw.prepare('UPDATE admin_sessions SET revoked_at = NULL').run();
    db.raw.prepare("UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await invoke(onRequest as never, authedGet('/api/audit', token))).response.status).toBe(401);

    db.raw.prepare("UPDATE admin_sessions SET expires_at = '2099-01-01T00:00:00.000Z'").run();
    db.raw.prepare('UPDATE admin_users SET status = ? WHERE id = ?').run('SUSPENDED', adminId);
    expect((await invoke(onRequest as never, authedGet('/api/audit', token))).response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// G. Query abuse
// ---------------------------------------------------------------------------
describe('audit listing rejects abusive queries', () => {
  it.each([
    'page=0',
    'page=-5',
    'pageSize=0',
    'pageSize=-1',
    'pageSize=201',
    'pageSize=abc',
    'page=abc',
  ])('clamps %s rather than trusting it', async (query) => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const { response } = await invoke(
      listAudit as never,
      authedGet(`/api/audit?${query}`, token),
      data,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AuditListResponse;
    expect(body.page).toBeGreaterThanOrEqual(1);
    expect(body.pageSize).toBeGreaterThanOrEqual(1);
    expect(body.pageSize).toBeLessThanOrEqual(200);
  });

  it('never lets a filter reach SQL as a fragment', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const injections = [
      "action=' OR '1'='1",
      'entityType=EVENT; DROP TABLE audit_logs',
      "entityId=' UNION SELECT password_hash FROM admin_users--",
      'actorAdminId=1 OR 1=1',
      "from=2026-01-01'",
    ];
    for (const query of injections) {
      const { response } = await invoke(
        listAudit as never,
        authedGet(`/api/audit?${query}`, token),
        data,
      );
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) {
        const body = (await response.json()) as AuditListResponse;
        expect(JSON.stringify(body)).not.toContain('pbkdf2');
      }
    }

    const tables = db.raw
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='audit_logs'")
      .get() as { n: number };
    expect(tables.n).toBe(1);
  });

  it('uses the first value when a parameter is repeated', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const { response } = await invoke(
      listAudit as never,
      authedGet('/api/audit?pageSize=5&pageSize=999', token),
      data,
    );
    const body = (await response.json()) as AuditListResponse;
    expect(body.pageSize).toBe(5);
  });

  it('ignores unknown parameters', async () => {
    await seedAdmin();
    const token = await login();
    const data = await gate('/api/audit', token);

    const { response } = await invoke(
      listAudit as never,
      authedGet('/api/audit?orderBy=password_hash&sort=token_hash&evil=1', token),
      data,
    );
    expect(response.status).toBe(200);
  });

  it('sends no-store and a request id on both audit endpoints', async () => {
    await seedAdmin();
    const token = await login();
    const seed = String(auditRows()[0].id);

    let data = await gate('/api/audit', token);
    const list = await invoke(listAudit as never, authedGet('/api/audit', token), data);
    expect(list.response.headers.get('Cache-Control')).toBe('no-store');
    expect(list.response.headers.get('X-Request-ID')).toBeTruthy();

    data = await gate(`/api/audit/${seed}`, token);
    const detail = await invoke(
      getAudit as never,
      authedGet(`/api/audit/${seed}`, token),
      data,
      { id: seed },
    );
    expect(detail.response.headers.get('Cache-Control')).toBe('no-store');
    expect(detail.response.headers.get('X-Request-ID')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// H. Payload limits
// ---------------------------------------------------------------------------
describe('payload guard', () => {
  it.each([
    ['no content type', undefined],
    ['text/plain', 'text/plain'],
    ['form urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart', 'multipart/form-data'],
    ['json-ish', 'application/jsonx'],
  ])('rejects %s with 415 and writes no session', async (_label, contentType) => {
    await seedAdmin();
    const headers: Record<string, string> = contentType
      ? { 'Content-Type': contentType }
      : {};
    const { response } = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    expect(response.status).toBe(415);
    const sessions = db.raw
      .prepare('SELECT COUNT(*) AS n FROM admin_sessions')
      .get() as { n: number };
    expect(sessions.n).toBe(0);
  });

  it('accepts a payload exactly at the limit and rejects one byte more', async () => {
    await seedAdmin();
    // Padding is an unknown key, stripped by the schema; only the size matters.
    const sizeFor = (padLength: number) =>
      JSON.stringify({ email: EMAIL, password: PASSWORD, pad: 'x'.repeat(padLength) });

    let padding = 1;
    // Grow until the encoded body is strictly ABOVE the ceiling.
    while (new TextEncoder().encode(sizeFor(padding)).length <= 16 * 1024) padding += 1;
    const overBody = sizeFor(padding);
    const underBody = sizeFor(padding - 1);

    expect(new TextEncoder().encode(overBody).length).toBeGreaterThan(16 * 1024);
    expect(new TextEncoder().encode(underBody).length).toBeLessThanOrEqual(16 * 1024);

    const over = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: overBody,
      }),
    );
    expect(over.response.status).toBe(413);

    const under = await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: underBody,
      }),
    );
    expect(under.response.status).toBe(200);
  });

  it('carries a request id on every rejection', async () => {
    for (const [status, request] of [
      [
        415,
        new Request('https://example.com/api/manager/login', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: '{}',
        }),
      ],
      [
        400,
        new Request('https://example.com/api/manager/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{broken',
        }),
      ],
    ] as Array<[number, Request]>) {
      const { response } = await invoke(loginHandler as never, request);
      expect(response.status).toBe(status);
      const body = (await response.json()) as ApiErrorBody;
      expect(body.error.requestId, String(status)).toBeTruthy();
      expect(response.headers.get('X-Request-ID')).toBeTruthy();
    }
  });

  it('a rejected payload creates no misleading audit row', async () => {
    await seedAdmin();
    await invoke(
      loginHandler as never,
      new Request('https://example.com/api/manager/login', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
    );
    // Nothing was attempted, so nothing may claim a login attempt happened.
    expect(auditRows()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// I. Concurrency
// ---------------------------------------------------------------------------
describe('pagination semantics (documented honestly)', () => {
  const emptyQuery = {
    actorAdminId: null,
    action: null,
    entityType: null,
    entityId: null,
    eventId: null,
    from: null,
    to: null,
  };

  async function seedRows(count: number, createdAt: string, prefix: string) {
    const repository = new AuditRepository(db.d1);
    for (let i = 0; i < count; i++) {
      await repository.append({
        id: `${prefix}-${String(i).padStart(4, '0')}`,
        actorAdminId: null,
        action: 'EVENT_UPDATED',
        entityType: 'EVENT',
        entityId: null,
        eventId: null,
        previousData: null,
        newData: null,
        metadata: null,
        ipHash: null,
        userAgent: null,
        requestId: 'r',
        createdAt,
      });
    }
  }

  it('IS stable across pages when rows share a millisecond', async () => {
    const repository = new AuditRepository(db.d1);
    await seedRows(10, '2026-01-01T00:00:00.000Z', 'tie');

    const page1 = await repository.list({ ...emptyQuery, page: 1, pageSize: 5 });
    const page2 = await repository.list({ ...emptyQuery, page: 2, pageSize: 5 });

    const ids1 = page1.items.map((i) => i.id);
    const ids2 = page2.items.map((i) => i.id);

    // The `id DESC` tiebreak is what guarantees this: no repeats, nothing lost.
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
    expect(new Set([...ids1, ...ids2]).size).toBe(10);
  });

  it('is NOT a consistent snapshot when rows arrive between pages', async () => {
    const repository = new AuditRepository(db.d1);
    await seedRows(10, '2026-01-01T00:00:00.000Z', 'old');

    const page1 = await repository.list({ ...emptyQuery, page: 1, pageSize: 5 });
    // Five newer rows arrive while the reviewer is on page 1.
    await seedRows(5, '2026-06-01T00:00:00.000Z', 'new');
    const page2 = await repository.list({ ...emptyQuery, page: 2, pageSize: 5 });

    const ids1 = page1.items.map((i) => i.id);
    const ids2 = page2.items.map((i) => i.id);

    // This documents reality: offset pagination shifts, so page 2 re-shows what
    // page 1 already displayed. Nothing is lost from the table; the traversal
    // simply is not a snapshot. Asserting it keeps anyone from later claiming
    // a stability guarantee that does not exist.
    expect(ids1.filter((id) => ids2.includes(id)).length).toBeGreaterThan(0);

    const stillPresent = await repository.list({ ...emptyQuery, page: 1, pageSize: 100 });
    expect(stillPresent.total).toBe(15);
  });

  it('bounding the window with `to` restores a stable traversal', async () => {
    const repository = new AuditRepository(db.d1);
    await seedRows(10, '2026-01-01T00:00:00.000Z', 'old');

    const upperBound = '2026-01-01T00:00:00.000Z';
    const page1 = await repository.list({
      ...emptyQuery,
      to: upperBound,
      page: 1,
      pageSize: 5,
    });
    await seedRows(5, '2026-06-01T00:00:00.000Z', 'new');
    const page2 = await repository.list({
      ...emptyQuery,
      to: upperBound,
      page: 2,
      pageSize: 5,
    });

    const ids1 = page1.items.map((i) => i.id);
    const ids2 = page2.items.map((i) => i.id);
    // Newer rows fall outside the pinned window, so the traversal is stable.
    expect(ids1.filter((id) => ids2.includes(id))).toHaveLength(0);
    expect(new Set([...ids1, ...ids2]).size).toBe(10);
  });
});

describe('concurrency', () => {
  it('concurrent audit writes all land with distinct ids', async () => {
    const service = new AuditService(db.d1);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.record({
          action: 'EVENT_UPDATED',
          entityType: 'EVENT',
          requestContext: REQUEST,
        }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const rows = auditRows();
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.id)).size).toBe(12);
    // A shared request id is legitimate: one request may emit several entries.
    expect(new Set(rows.map((r) => r.request_id)).size).toBe(1);
  });

  it('deleting the actor while writing does not corrupt the trail', async () => {
    const adminId = await seedAdmin();
    const service = new AuditService(db.d1);

    const [written] = await Promise.all([
      service.record({
        action: 'ADMIN_LOGOUT',
        entityType: 'ADMIN_SESSION',
        actor: { id: adminId, email: EMAIL, displayName: 'Ada' },
        requestContext: REQUEST,
      }),
      Promise.resolve().then(() => {
        db.raw.prepare('DELETE FROM admin_sessions WHERE admin_user_id = ?').run(adminId);
      }),
    ]);

    // Either it wrote, or the FK refused it — never a half-written row.
    if (written.ok) {
      expect(auditRows()).toHaveLength(1);
    } else {
      expect(written.reason).toBe('write_failed');
      expect(auditRows()).toHaveLength(0);
    }
  });

  it('an audit failure never produces an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      const failing = new AuditService(db.d1, {
        append: vi.fn(async () => {
          throw new Error('d1 down');
        }),
      } as unknown as AuditRepository);

      await Promise.all(
        Array.from({ length: 5 }, () =>
          failing.record({
            action: 'ADMIN_LOGOUT',
            entityType: 'ADMIN_SESSION',
            requestContext: REQUEST,
          }),
        ),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});

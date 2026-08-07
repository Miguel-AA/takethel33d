// @vitest-environment node
//
// Second adversarial pass over the HTTP surface: session states, method
// exposure, header hygiene, IDOR and payload abuse against every event route.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import * as eventsIndex from '../functions/api/events/index';
import * as eventById from '../functions/api/events/[id]/index';
import * as publishRoute from '../functions/api/events/[id]/publish';
import * as openRoute from '../functions/api/events/[id]/open';
import * as closeRoute from '../functions/api/events/[id]/close';
import * as drawReadyRoute from '../functions/api/events/[id]/mark-draw-ready';
import * as cancelRoute from '../functions/api/events/[id]/cancel';
import * as archiveRoute from '../functions/api/events/[id]/archive';
import * as duplicateRoute from '../functions/api/events/[id]/duplicate';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { newId } from '../functions/_shared/ids';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { ApiErrorBody, Event } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;
let token: string;

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

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://example.com${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
      ...((init.headers as Record<string, string>) ?? {}),
    },
  });
}

const gate = async (path: string) => (await invoke(onRequest as never, req(path))).data;

async function createDraft(body: Record<string, unknown> = {}): Promise<Event> {
  const data = await gate('/api/events');
  const { response } = await invoke(
    eventsIndex.onRequestPost as never,
    req('/api/events', {
      method: 'POST',
      body: JSON.stringify({ name: 'Security Event', ...body }),
    }),
    data,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Event;
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});

  await new AdminRepository(db.d1).create({
    email: EMAIL,
    normalizedEmail: normalizeEmail(EMAIL),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword(PASSWORD),
  });
  const { response } = await invoke(
    loginHandler as never,
    new Request('https://example.com/api/manager/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    }),
  );
  const cookies = (response.headers.getSetCookie?.() ?? []).join(' | ');
  token = decodeURIComponent(
    new RegExp(`${HOST_SESSION_COOKIE_NAME}=([^;]+)`).exec(cookies)?.[1] ?? '',
  );
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('method exposure', () => {
  it('exposes ONLY the documented handlers per route', () => {
    const handlersOf = (mod: Record<string, unknown>) =>
      Object.keys(mod).filter((key) => key.startsWith('onRequest')).sort();

    // A stray onRequestPut/onRequestDelete would silently open a mutation path.
    expect(handlersOf(eventsIndex)).toEqual(['onRequestGet', 'onRequestPost']);
    expect(handlersOf(eventById)).toEqual([
      'onRequestDelete',
      'onRequestGet',
      'onRequestPatch',
    ]);
    for (const mod of [
      publishRoute,
      openRoute,
      closeRoute,
      drawReadyRoute,
      cancelRoute,
      archiveRoute,
      duplicateRoute,
    ]) {
      expect(handlersOf(mod)).toEqual(['onRequestPost']);
    }
  });

  it('exposes no catch-all onRequest that would answer every method', () => {
    for (const mod of [eventsIndex, eventById, publishRoute, duplicateRoute]) {
      expect(Object.keys(mod)).not.toContain('onRequest');
    }
  });
});

// ---------------------------------------------------------------------------
describe('session states across every event route', () => {
  const ROUTES = [
    '/api/events',
    '/api/events/11111111-1111-4111-8111-111111111111',
    '/api/events/11111111-1111-4111-8111-111111111111/publish',
    '/api/events/11111111-1111-4111-8111-111111111111/open',
    '/api/events/11111111-1111-4111-8111-111111111111/close',
    '/api/events/11111111-1111-4111-8111-111111111111/mark-draw-ready',
    '/api/events/11111111-1111-4111-8111-111111111111/cancel',
    '/api/events/11111111-1111-4111-8111-111111111111/archive',
    '/api/events/11111111-1111-4111-8111-111111111111/duplicate',
  ];

  it.each(ROUTES)('%s rejects an expired session', async (path) => {
    db.raw.prepare("UPDATE admin_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const { response, nextCalled } = await invoke(onRequest as never, req(path));
    expect(nextCalled).toBe(false);
    expect(response.status).toBe(401);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('SESSION_EXPIRED');
  });

  it.each(ROUTES)('%s rejects a revoked session', async (path) => {
    db.raw.prepare('UPDATE admin_sessions SET revoked_at = ?').run(new Date().toISOString());
    const { response, nextCalled } = await invoke(onRequest as never, req(path));
    expect(nextCalled).toBe(false);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('SESSION_REVOKED');
  });

  it.each(ROUTES)('%s rejects a suspended administrator', async (path) => {
    db.raw.prepare("UPDATE admin_users SET status = 'SUSPENDED'").run();
    const { response, nextCalled } = await invoke(onRequest as never, req(path));
    expect(nextCalled).toBe(false);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('ADMIN_SUSPENDED');
  });
});

// ---------------------------------------------------------------------------
describe('hostile identifiers', () => {
  const HOSTILE = [
    'not-a-uuid',
    '../../admin',
    "1' OR '1'='1",
    '%2e%2e%2f',
    '11111111-1111-4111-8111-11111111111',
    '11111111111141118111111111111111',
    '<script>alert(1)</script>',
    'null',
    '00000000-0000-0000-0000-000000000000',
  ];

  it.each(HOSTILE)('GET rejects the id %s with 400, never a 500', async (id) => {
    const data = await gate('/api/events/x');
    const { response } = await invoke(
      eventById.onRequestGet as never,
      req('/api/events/x'),
      data,
      { id },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('INVALID_QUERY');
    // The rejected value must not be echoed back.
    expect(JSON.stringify(body)).not.toContain('script');
  });

  it.each(HOSTILE)('transition endpoints reject the id %s', async (id) => {
    const data = await gate('/api/events/x/publish');
    const { response } = await invoke(
      publishRoute.onRequestPost as never,
      req('/api/events/x/publish', { method: 'POST', body: '{}' }),
      data,
      { id },
    );
    expect(response.status).toBe(400);
  });

  it('a well-formed but unknown id is a clean 404', async () => {
    const data = await gate('/api/events/x');
    const missing = newId();
    const { response } = await invoke(
      eventById.onRequestGet as never,
      req(`/api/events/${missing}`),
      data,
      { id: missing },
    );
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('EVENT_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('header hygiene', () => {
  it('every event response carries no-store and a request id', async () => {
    const event = await createDraft();
    const data = await gate('/api/events');

    const cases: Array<[string, Promise<Response>]> = [
      [
        'list',
        invoke(eventsIndex.onRequestGet as never, req('/api/events'), data).then(
          (r) => r.response,
        ),
      ],
      [
        'detail',
        invoke(eventById.onRequestGet as never, req(`/api/events/${event.id}`), data, {
          id: event.id,
        }).then((r) => r.response),
      ],
      [
        'patch',
        invoke(
          eventById.onRequestPatch as never,
          req(`/api/events/${event.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ expectedRevision: 1, name: 'Renamed' }),
          }),
          data,
          { id: event.id },
        ).then((r) => r.response),
      ],
    ];

    for (const [label, promise] of cases) {
      const response = await promise;
      expect(response.headers.get('Cache-Control'), label).toBe('no-store');
      expect(response.headers.get('X-Request-ID'), label).toBeTruthy();
    }
  });

  it('error responses also carry a request id', async () => {
    const data = await gate('/api/events');
    const { response } = await invoke(
      eventsIndex.onRequestGet as never,
      req('/api/events?status=NONSENSE'),
      data,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.requestId).toBeTruthy();
  });

  it('never leaks a stack trace or internal path in an error body', async () => {
    const data = await gate('/api/events');
    const { response } = await invoke(
      eventsIndex.onRequestPost as never,
      req('/api/events', { method: 'POST', body: '{"name":' }),
      data,
    );
    const text = await response.text();
    expect(text).not.toContain('at ');
    expect(text).not.toContain('functions/');
    expect(text).not.toContain('.ts:');
  });
});

// ---------------------------------------------------------------------------
describe('payload abuse on every mutating route', () => {
  it('rejects a non-JSON content type on create, patch and duplicate', async () => {
    const event = await createDraft();
    const data = await gate('/api/events');

    const plain = (path: string, method: string) =>
      new Request(`https://example.com${path}`, {
        method,
        headers: {
          'Content-Type': 'text/plain',
          Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        },
        body: '{}',
      });

    const create = await invoke(
      eventsIndex.onRequestPost as never,
      plain('/api/events', 'POST'),
      data,
    );
    expect(create.response.status).toBe(415);

    const patch = await invoke(
      eventById.onRequestPatch as never,
      plain(`/api/events/${event.id}`, 'PATCH'),
      data,
      { id: event.id },
    );
    expect(patch.response.status).toBe(415);

    const duplicate = await invoke(
      duplicateRoute.onRequestPost as never,
      plain(`/api/events/${event.id}/duplicate`, 'POST'),
      data,
      { id: event.id },
    );
    expect(duplicate.response.status).toBe(415);
  });

  it('rejects an oversized body before it can be stored', async () => {
    const data = await gate('/api/events');
    const { response } = await invoke(
      eventsIndex.onRequestPost as never,
      req('/api/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'Big', description: 'x'.repeat(200_000) }),
      }),
      data,
    );
    expect(response.status).toBe(413);
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('strips prototype pollution from a create payload', async () => {
    const data = await gate('/api/events');
    await invoke(
      eventsIndex.onRequestPost as never,
      req('/api/events', {
        method: 'POST',
        body: '{"name":"Polluted","__proto__":{"polluted":true}}',
      }),
      data,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses an oversized individual field', async () => {
    const data = await gate('/api/events');
    const { response } = await invoke(
      eventsIndex.onRequestPost as never,
      req('/api/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'x'.repeat(500) }),
      }),
      data,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
describe('transition endpoints refuse to mutate from an invalid state', () => {
  it.each([
    ['close', closeRoute],
    ['mark-draw-ready', drawReadyRoute],
  ])('%s on a DRAFT is refused and writes nothing', async (_label, mod) => {
    const event = await createDraft();
    const data = await gate('/api/events');

    const { response } = await invoke(
      mod.onRequestPost as never,
      req(`/api/events/${event.id}/x`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe(
      'EVENT_INVALID_TRANSITION',
    );

    const row = db.raw
      .prepare('SELECT status, revision FROM events WHERE id = ?')
      .get(event.id) as { status: string; revision: number };
    expect(row.status).toBe('DRAFT');
    expect(row.revision).toBe(1);

    // Scoped to this event: the sign-in that set the suite up also audits.
    const audits = db.raw
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_logs WHERE event_id = ? AND action <> 'EVENT_CREATED'",
      )
      .get(event.id) as { n: number };
    expect(audits.n).toBe(0);
  });
});

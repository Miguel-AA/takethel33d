// @vitest-environment node
//
// The prize HTTP surface: auth, route protection, IDOR, payload guards, typed
// errors and method exposure.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import * as prizesIndex from '../functions/api/events/[id]/prizes/index';
import * as prizeById from '../functions/api/events/[id]/prizes/[prizeId]/index';
import * as activateRoute from '../functions/api/events/[id]/prizes/[prizeId]/activate';
import * as deactivateRoute from '../functions/api/events/[id]/prizes/[prizeId]/deactivate';
import * as archiveRoute from '../functions/api/events/[id]/prizes/[prizeId]/archive';
import * as reorderRoute from '../functions/api/events/[id]/prizes/reorder';
import { onRequestGet as getEvent } from '../functions/api/events/[id]/index';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { newId } from '../functions/_shared/ids';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type {
  ApiErrorBody,
  AuthenticatedAdmin,
  Event,
  EventPrize,
  EventPrizeDetailResponse,
  EventPrizeListResponse,
  EventDetailResponse,
} from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const EMAIL = 'ada@example.com';

let db: TestDatabase;
let token: string;
let admin: AuthenticatedAdmin;
let event: Event;

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

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

async function addPrize(body: Record<string, unknown> = {}): Promise<EventPrize> {
  const data = await gate(`/api/events/${event.id}/prizes`);
  const { response } = await invoke(
    prizesIndex.onRequestPost as never,
    req(`/api/events/${event.id}/prizes`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Vape', quantity: 1, ...body }),
    }),
    data,
    { id: event.id },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as EventPrize;
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});

  const created = await new AdminRepository(db.d1).create({
    email: EMAIL,
    normalizedEmail: normalizeEmail(EMAIL),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword(PASSWORD),
  });
  if (created.kind !== 'created') throw new Error('admin seed failed');
  admin = {
    id: created.admin.id,
    email: created.admin.email,
    displayName: created.admin.displayName,
    role: 'ADMIN',
    status: 'ACTIVE',
    sessionId: 'session-1',
  };

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

  const madeEvent = await new EventLifecycleService(db.d1).create(
    {
      name: 'Grand Opening Smoke Shop',
      registrationOpensAt: at(1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    },
    {
      admin,
      requestContext: {
        requestId: 'seed',
        ipHash: null,
        userAgent: null,
        origin: null,
        method: 'POST',
        pathname: '/api/events',
      },
    },
  );
  if (!madeEvent.ok) throw new Error('event seed failed');
  event = madeEvent.value;
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('route protection', () => {
  const routes = (eventId: string, prizeId: string) => [
    `/api/events/${eventId}/prizes`,
    `/api/events/${eventId}/prizes/reorder`,
    `/api/events/${eventId}/prizes/${prizeId}`,
    `/api/events/${eventId}/prizes/${prizeId}/activate`,
    `/api/events/${eventId}/prizes/${prizeId}/deactivate`,
    `/api/events/${eventId}/prizes/${prizeId}/archive`,
  ];

  it('rejects every prize route without a session', async () => {
    for (const path of routes(newId(), newId())) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(nextCalled, path).toBe(false);
      expect(response.status, path).toBe(401);
    }
  });

  it.each([
    '//api/events/x/prizes',
    '/api//events/x/prizes',
    '/API/events/x/prizes',
    '/api/%65vents/x/prizes',
    '/api/events/x/%70rizes',
    // Double-encoded: the guard decodes repeatedly, so this resolves too.
    '/api/events/x/%2570rizes',
    '/api/events/x/../../events/y/prizes',
    '/api/events/x/prizes/../archive',
    '/api/events/../audit',
    '/api/events/x/prizes/y/../activate',
    '\\api\\events\\x\\prizes',
    '\\api\\events\\x\\prizes\\y\\archive',
  ])('rejects the bypass attempt %s', async (path) => {
    const { response, nextCalled } = await invoke(
      onRequest as never,
      new Request(`https://example.com${path}`),
    );
    expect(nextCalled).toBe(false);
    expect(response.status).toBe(401);
  });

  it('rejects a revoked session and a suspended admin', async () => {
    db.raw.prepare('UPDATE admin_sessions SET revoked_at = ?').run(new Date().toISOString());
    expect((await invoke(onRequest as never, req(`/api/events/${event.id}/prizes`))).response.status).toBe(401);

    db.raw.prepare('UPDATE admin_sessions SET revoked_at = NULL').run();
    db.raw.prepare("UPDATE admin_users SET status = 'SUSPENDED'").run();
    expect((await invoke(onRequest as never, req(`/api/events/${event.id}/prizes`))).response.status).toBe(401);
  });

  it('keeps the legacy public routes untouched', async () => {
    for (const path of ['/api/register', '/events', '/']) {
      const { nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(nextCalled, path).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('method exposure', () => {
  it('exposes only the documented handlers', () => {
    const handlersOf = (mod: Record<string, unknown>) =>
      Object.keys(mod).filter((key) => key.startsWith('onRequest')).sort();

    expect(handlersOf(prizesIndex)).toEqual(['onRequestGet', 'onRequestPost']);
    expect(handlersOf(prizeById)).toEqual([
      'onRequestDelete',
      'onRequestGet',
      'onRequestPatch',
    ]);
    for (const mod of [activateRoute, deactivateRoute, archiveRoute, reorderRoute]) {
      expect(handlersOf(mod)).toEqual(['onRequestPost']);
    }
    // No catch-all that would answer every method.
    for (const mod of [prizesIndex, prizeById, reorderRoute]) {
      expect(Object.keys(mod)).not.toContain('onRequest');
    }
  });
});

// ---------------------------------------------------------------------------
describe('POST /prizes', () => {
  it('creates a prize with request id and no-store', async () => {
    const data = await gate(`/api/events/${event.id}/prizes`);
    const { response } = await invoke(
      prizesIndex.onRequestPost as never,
      req(`/api/events/${event.id}/prizes`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Gift Card', quantity: 3 }),
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();

    const prize = (await response.json()) as EventPrize;
    expect(prize.status).toBe('ACTIVE');
    expect(prize.revision).toBe(1);
    expect(prize.eventId).toBe(event.id);
  });

  it.each([
    { status: 'INACTIVE' },
    { revision: 9 },
    { id: 'forced' },
    { eventId: 'another-event' },
    { createdBy: 'someone' },
    { archivedAt: '2026-01-01T00:00:00.000Z' },
    { sortOrder: -1 },
  ])('refuses the injected field %o', async (extra) => {
    const data = await gate(`/api/events/${event.id}/prizes`);
    const { response } = await invoke(
      prizesIndex.onRequestPost as never,
      req(`/api/events/${event.id}/prizes`, {
        method: 'POST',
        body: JSON.stringify({ name: 'X', quantity: 1, ...extra }),
      }),
      data,
      { id: event.id },
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/relative.png'])(
    'refuses the image URL %s',
    async (imageUrl) => {
      const data = await gate(`/api/events/${event.id}/prizes`);
      const { response } = await invoke(
        prizesIndex.onRequestPost as never,
        req(`/api/events/${event.id}/prizes`, {
          method: 'POST',
          body: JSON.stringify({ name: 'X', quantity: 1, imageUrl }),
        }),
        data,
        { id: event.id },
      );
      expect(response.status).toBe(400);
      const count = db.raw
        .prepare('SELECT COUNT(*) AS n FROM event_prizes')
        .get() as { n: number };
      expect(count.n).toBe(0);
    },
  );

  it('rejects a wrong content type and an oversized body', async () => {
    const data = await gate(`/api/events/${event.id}/prizes`);

    const wrongType = await invoke(
      prizesIndex.onRequestPost as never,
      new Request(`https://example.com/api/events/${event.id}/prizes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        },
        body: '{}',
      }),
      data,
      { id: event.id },
    );
    expect(wrongType.response.status).toBe(415);

    const huge = await invoke(
      prizesIndex.onRequestPost as never,
      req(`/api/events/${event.id}/prizes`, {
        method: 'POST',
        body: JSON.stringify({ name: 'X', quantity: 1, description: 'x'.repeat(200_000) }),
      }),
      data,
      { id: event.id },
    );
    expect(huge.response.status).toBe(413);
  });

  it('stores hostile text verbatim without executing it', async () => {
    const hostile = '<script>alert(1)</script>';
    const prize = await addPrize({ name: hostile, description: hostile });
    expect(prize.name).toBe(hostile);
  });

  it('404s for an unknown event and 400s for a malformed id', async () => {
    const data = await gate('/api/events/x/prizes');

    const missing = newId();
    const notFound = await invoke(
      prizesIndex.onRequestPost as never,
      req(`/api/events/${missing}/prizes`, {
        method: 'POST',
        body: JSON.stringify({ name: 'X', quantity: 1 }),
      }),
      data,
      { id: missing },
    );
    expect(notFound.response.status).toBe(404);

    for (const id of ['not-a-uuid', '../../admin', "1' OR '1'='1"]) {
      const bad = await invoke(
        prizesIndex.onRequestPost as never,
        req('/api/events/x/prizes', {
          method: 'POST',
          body: JSON.stringify({ name: 'X', quantity: 1 }),
        }),
        data,
        { id },
      );
      expect(bad.response.status, id).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
describe('GET /prizes', () => {
  it('returns items, summary and the event status', async () => {
    await addPrize({ name: 'A', quantity: 2 });
    await addPrize({ name: 'B', quantity: 3 });

    const data = await gate(`/api/events/${event.id}/prizes`);
    const { response } = await invoke(
      prizesIndex.onRequestGet as never,
      req(`/api/events/${event.id}/prizes`),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as EventPrizeListResponse;
    expect(body.total).toBe(2);
    expect(body.summary.totalActiveUnits).toBe(5);
    expect(body.eventStatus).toBe('DRAFT');
  });

  it.each(['status=GONE', 'sort=event_id', 'archived=maybe', 'pageSize=201', 'page=0'])(
    'rejects the invalid filter %s',
    async (query) => {
      const data = await gate(`/api/events/${event.id}/prizes`);
      const { response } = await invoke(
        prizesIndex.onRequestGet as never,
        req(`/api/events/${event.id}/prizes?${query}`),
        data,
        { id: event.id },
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('INVALID_QUERY');
    },
  );
});

// ---------------------------------------------------------------------------
describe('IDOR between events', () => {
  it('a prize cannot be read, patched, transitioned or deleted through another event', async () => {
    const prize = await addPrize();

    const other = await new EventLifecycleService(db.d1).create(
      { name: 'Other event' },
      {
        admin,
        requestContext: {
          requestId: 'seed2',
          ipHash: null,
          userAgent: null,
          origin: null,
          method: 'POST',
          pathname: '/api/events',
        },
      },
    );
    if (!other.ok) throw new Error('other event failed');
    const foreignId = other.value.id;
    const data = await gate(`/api/events/${foreignId}/prizes/${prize.id}`);
    const params = { id: foreignId, prizeId: prize.id };

    const read = await invoke(
      prizeById.onRequestGet as never,
      req(`/api/events/${foreignId}/prizes/${prize.id}`),
      data,
      params,
    );
    expect(read.response.status).toBe(404);

    const patch = await invoke(
      prizeById.onRequestPatch as never,
      req(`/api/events/${foreignId}/prizes/${prize.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, name: 'Stolen' }),
      }),
      data,
      params,
    );
    expect(patch.response.status).toBe(404);

    const archived = await invoke(
      archiveRoute.onRequestPost as never,
      req(`/api/events/${foreignId}/prizes/${prize.id}/archive`, {
        method: 'POST',
        body: '{}',
      }),
      data,
      params,
    );
    expect(archived.response.status).toBe(404);

    const removed = await invoke(
      prizeById.onRequestDelete as never,
      req(`/api/events/${foreignId}/prizes/${prize.id}`, { method: 'DELETE' }),
      data,
      params,
    );
    expect(removed.response.status).toBe(404);

    // Nothing happened to it.
    const row = db.raw
      .prepare('SELECT name, status, revision FROM event_prizes WHERE id = ?')
      .get(prize.id) as { name: string; status: string; revision: number };
    expect(row).toEqual({ name: 'Vape', status: 'ACTIVE', revision: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('PATCH and status endpoints', () => {
  it('patches and reports a stale revision', async () => {
    const prize = await addPrize();
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);
    const params = { id: event.id, prizeId: prize.id };

    const first = await invoke(
      prizeById.onRequestPatch as never,
      req(`/api/events/${event.id}/prizes/${prize.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, name: 'Renamed' }),
      }),
      data,
      params,
    );
    expect(first.response.status).toBe(200);

    const stale = await invoke(
      prizeById.onRequestPatch as never,
      req(`/api/events/${event.id}/prizes/${prize.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, name: 'Again' }),
      }),
      data,
      params,
    );
    expect(stale.response.status).toBe(409);
    expect(((await stale.response.json()) as ApiErrorBody).error.code).toBe(
      'PRIZE_REVISION_CONFLICT',
    );
  });

  it('accepts an empty body on a status action and refuses a repeat', async () => {
    const prize = await addPrize();
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}/deactivate`);
    const params = { id: event.id, prizeId: prize.id };

    const off = await invoke(
      deactivateRoute.onRequestPost as never,
      new Request(`https://example.com/api/events/${event.id}/prizes/${prize.id}/deactivate`, {
        method: 'POST',
        headers: { Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
      }),
      data,
      params,
    );
    expect(off.response.status).toBe(200);

    const again = await invoke(
      deactivateRoute.onRequestPost as never,
      req(`/api/events/${event.id}/prizes/${prize.id}/deactivate`, {
        method: 'POST',
        body: '{}',
      }),
      data,
      params,
    );
    expect(again.response.status).toBe(409);
    expect(((await again.response.json()) as ApiErrorBody).error.code).toBe(
      'PRIZE_INVALID_STATUS',
    );
  });

  it('reports a frozen event with its status', async () => {
    const prize = await addPrize();
    db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);

    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}/archive`);
    const { response } = await invoke(
      archiveRoute.onRequestPost as never,
      req(`/api/events/${event.id}/prizes/${prize.id}/archive`, {
        method: 'POST',
        body: '{}',
      }),
      data,
      { id: event.id, prizeId: prize.id },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('PRIZE_EVENT_NOT_EDITABLE');
    expect(body.error.fields?.eventStatus).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
describe('reorder endpoint', () => {
  it('applies a full new order', async () => {
    const a = await addPrize({ name: 'A' });
    const b = await addPrize({ name: 'B' });

    const data = await gate(`/api/events/${event.id}/prizes/reorder`);
    const { response } = await invoke(
      reorderRoute.onRequestPost as never,
      req(`/api/events/${event.id}/prizes/reorder`, {
        method: 'POST',
        body: JSON.stringify({
          items: [
            { prizeId: b.id, expectedRevision: 1, sortOrder: 0 },
            { prizeId: a.id, expectedRevision: 1, sortOrder: 1 },
          ],
        }),
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: EventPrize[] };
    expect(body.items.map((p) => p.name)).toEqual(['B', 'A']);
  });

  it('rejects duplicate ids and duplicate positions', async () => {
    const a = await addPrize({ name: 'A' });
    const data = await gate(`/api/events/${event.id}/prizes/reorder`);

    for (const items of [
      [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: a.id, expectedRevision: 1, sortOrder: 1 },
      ],
      [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: newId(), expectedRevision: 1, sortOrder: 0 },
      ],
    ]) {
      const { response } = await invoke(
        reorderRoute.onRequestPost as never,
        req(`/api/events/${event.id}/prizes/reorder`, {
          method: 'POST',
          body: JSON.stringify({ items }),
        }),
        data,
        { id: event.id },
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }
  });
});

// ---------------------------------------------------------------------------
describe('event detail integration', () => {
  it('an event holding prizes reports canDelete false', async () => {
    const before = await gate(`/api/events/${event.id}`);
    const initial = await invoke(
      getEvent as never,
      req(`/api/events/${event.id}`),
      before,
      { id: event.id },
    );
    expect(((await initial.response.json()) as EventDetailResponse).canDelete).toBe(true);

    await addPrize();

    const after = await invoke(
      getEvent as never,
      req(`/api/events/${event.id}`),
      before,
      { id: event.id },
    );
    expect(((await after.response.json()) as EventDetailResponse).canDelete).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('detail endpoint', () => {
  it('reports allowed actions, editable fields and the event status', async () => {
    const prize = await addPrize();
    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);

    const { response } = await invoke(
      prizeById.onRequestGet as never,
      req(`/api/events/${event.id}/prizes/${prize.id}`),
      data,
      { id: event.id, prizeId: prize.id },
    );

    const body = (await response.json()) as EventPrizeDetailResponse;
    expect(body.prize.id).toBe(prize.id);
    expect(body.allowedActions).toContain('deactivate');
    expect(body.allowedActions).toContain('archive');
    expect(body.editableFields).toContain('quantity');
    expect(body.canDelete).toBe(true);
    expect(body.eventStatus).toBe('DRAFT');
  });

  it('narrows the reported permissions once the event is OPEN', async () => {
    const prize = await addPrize();
    db.raw.prepare("UPDATE events SET status = 'OPEN' WHERE id = ?").run(event.id);

    const data = await gate(`/api/events/${event.id}/prizes/${prize.id}`);
    const { response } = await invoke(
      prizeById.onRequestGet as never,
      req(`/api/events/${event.id}/prizes/${prize.id}`),
      data,
      { id: event.id, prizeId: prize.id },
    );

    const body = (await response.json()) as EventPrizeDetailResponse;
    expect(body.allowedActions).toHaveLength(0);
    expect(body.editableFields).not.toContain('quantity');
    expect(body.editableFields).toContain('name');
    expect(body.canDelete).toBe(false);
  });
});

// @vitest-environment node
//
// The event HTTP surface: auth, validation, payload guards, typed errors,
// route protection and mass-assignment resistance.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequest } from '../functions/_middleware';
import { onRequestGet as listEvents, onRequestPost as createEvent } from '../functions/api/events/index';
import {
  onRequestGet as getEvent,
  onRequestPatch as patchEvent,
  onRequestDelete as deleteEvent,
} from '../functions/api/events/[id]/index';
import { onRequestPost as publishEvent } from '../functions/api/events/[id]/publish';
import { onRequestPost as openEvent } from '../functions/api/events/[id]/open';
import { onRequestPost as archiveEvent } from '../functions/api/events/[id]/archive';
import { onRequestPost as duplicateEvent } from '../functions/api/events/[id]/duplicate';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { newId } from '../functions/_shared/ids';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { ApiErrorBody, Event, EventDetailResponse, EventListResponse } from '../shared/types';

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

/** Authenticates through the middleware and returns ctx.data for a handler. */
async function gate(path: string) {
  return (await invoke(onRequest as never, req(path))).data;
}

async function createDraft(body: Record<string, unknown> = {}): Promise<Event> {
  const data = await gate('/api/events');
  const { response } = await invoke(
    createEvent as never,
    req('/api/events', {
      method: 'POST',
      body: JSON.stringify({ name: 'Grand Opening Smoke Shop', ...body }),
    }),
    data,
  );
  expect(response.status).toBe(201);
  return (await response.json()) as Event;
}

function futureWindow() {
  const day = 86_400_000;
  const at = (d: number) => new Date(Date.now() + d * day).toISOString();
  return {
    registrationOpensAt: at(1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  };
}

/**
 * Gives an event a published form version.
 *
 * Since phase 6, `publish` and `open` require one: announcing an event means
 * people will be asked to fill something in. Inserted directly — the form
 * domain has its own suites, and this is only scaffolding.
 */
function seedPublishedForm(eventId: string): string {
  const now = new Date().toISOString();
  const versionId = crypto.randomUUID();
  const publisher = (
    db.raw.prepare('SELECT id FROM admin_users LIMIT 1').get() as { id: string }
  ).id;
  db.raw
    .prepare(
      `INSERT INTO event_form_versions
         (id, event_id, version_number, source_draft_revision, published_by,
          published_at, schema_snapshot, created_at)
       VALUES (?, ?, 1, 1, ?, ?, '{"snapshotVersion":1}', ?)`,
    )
    .run(versionId, eventId, publisher, now, now);
  // A published version must have structure: since phase 6 an event pointing at
  // an empty one counts as having no published form at all.
  const stepId = crypto.randomUUID();
  db.raw
    .prepare(
      `INSERT INTO form_steps
         (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
       VALUES (?, 'VERSION', ?, 'About you', 0, ?, ?)`,
    )
    .run(stepId, versionId, now, now);
  db.raw
    .prepare(
      `INSERT INTO form_questions
         (id, form_owner_type, form_owner_id, step_id, key, system_field, type,
          label, required, sort_order, created_at, updated_at)
       VALUES (?, 'VERSION', ?, ?, 'email', 'EMAIL', 'EMAIL', 'Email', 1, 0, ?, ?)`,
    )
    .run(crypto.randomUUID(), versionId, stepId, now, now);

  db.raw
    .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
    .run(versionId, eventId);
  return versionId;
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
describe('route protection', () => {
  it.each([
    '/api/events',
    '/api/events/11111111-1111-4111-8111-111111111111',
    '/api/events/11111111-1111-4111-8111-111111111111/publish',
    '//api/events',
    '/api//events',
    '/API/events',
    '/api/%65vents',
    '/api/%2565vents',
    '/api/attendees/../events',
    '\\api\\events',
    '///api/events',
  ])('rejects %s without a session', async (path) => {
    const { response, nextCalled } = await invoke(
      onRequest as never,
      new Request(`https://example.com${path}`),
    );
    expect(nextCalled, `${path} reached its handler`).toBe(false);
    expect(response.status).toBe(401);
  });

  it('leaves the legacy public routes alone', async () => {
    for (const path of ['/api/register', '/events', '/']) {
      const { nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(nextCalled, path).toBe(true);
    }
  });

  it('rejects a revoked session', async () => {
    db.raw.prepare('UPDATE admin_sessions SET revoked_at = ?').run(new Date().toISOString());
    const { response } = await invoke(onRequest as never, req('/api/events'));
    expect(response.status).toBe(401);
  });

  it('rejects a suspended administrator', async () => {
    db.raw.prepare("UPDATE admin_users SET status = 'SUSPENDED'").run();
    const { response } = await invoke(onRequest as never, req('/api/events'));
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/events', () => {
  it('creates a draft and returns 201 with a request id', async () => {
    const data = await gate('/api/events');
    const { response } = await invoke(
      createEvent as never,
      req('/api/events', { method: 'POST', body: JSON.stringify({ name: 'My Event' }) }),
      data,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();

    const event = (await response.json()) as Event;
    expect(event.status).toBe('DRAFT');
    expect(event.revision).toBe(1);
  });

  it('rejects a non-JSON content type and an oversized body', async () => {
    const data = await gate('/api/events');

    const wrongType = await invoke(
      createEvent as never,
      new Request('https://example.com/api/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        },
        body: JSON.stringify({ name: 'X' }),
      }),
      data,
    );
    expect(wrongType.response.status).toBe(415);

    const huge = await invoke(
      createEvent as never,
      req('/api/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'X', description: 'x'.repeat(200_000) }),
      }),
      data,
    );
    expect(huge.response.status).toBe(413);
  });

  it('refuses mass assignment of protected fields', async () => {
    const data = await gate('/api/events');
    for (const extra of [
      { status: 'OPEN' },
      { revision: 99 },
      { createdBy: 'someone-else' },
      { id: 'forced-id' },
      { publishedAt: '2026-01-01T00:00:00.000Z' },
      { archivedAt: '2026-01-01T00:00:00.000Z' },
    ]) {
      const { response } = await invoke(
        createEvent as never,
        req('/api/events', {
          method: 'POST',
          body: JSON.stringify({ name: 'X', ...extra }),
        }),
        data,
      );
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(((await response.json()) as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');
    }

    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('returns typed conflicts for slug problems', async () => {
    await createDraft({ slug: 'taken-slug' });
    const data = await gate('/api/events');

    const conflict = await invoke(
      createEvent as never,
      req('/api/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'Other', slug: 'taken-slug' }),
      }),
      data,
    );
    expect(conflict.response.status).toBe(409);
    expect(((await conflict.response.json()) as ApiErrorBody).error.code).toBe(
      'EVENT_SLUG_EXISTS',
    );

    const reserved = await invoke(
      createEvent as never,
      req('/api/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'Other', slug: 'manager' }),
      }),
      data,
    );
    expect(reserved.response.status).toBe(400);
    expect(((await reserved.response.json()) as ApiErrorBody).error.code).toBe(
      'EVENT_SLUG_RESERVED',
    );
  });

  it('rejects a javascript: banner URL', async () => {
    const data = await gate('/api/events');
    const { response } = await invoke(
      createEvent as never,
      req('/api/events', {
        method: 'POST',
        body: JSON.stringify({ name: 'X', bannerUrl: 'javascript:alert(1)' }),
      }),
      data,
    );
    expect(response.status).toBe(400);
  });

  it('stores hostile text verbatim without executing it', async () => {
    const hostile = '<script>alert(1)</script>';
    const event = await createDraft({ name: hostile, description: hostile });
    // Stored as data; escaping is the renderer's job and React does it.
    expect(event.name).toBe(hostile);
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/events', () => {
  it('lists with pagination metadata', async () => {
    await createDraft({ name: 'One', slug: 'one' });
    await createDraft({ name: 'Two', slug: 'two' });

    const data = await gate('/api/events');
    const { response } = await invoke(
      listEvents as never,
      req('/api/events?page=1&pageSize=1'),
      data,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as EventListResponse;
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(1);
    expect(body.totalPages).toBe(2);
  });

  it('excludes archived events by default', async () => {
    const event = await createDraft();
    const data = await gate('/api/events');
    await invoke(
      archiveEvent as never,
      req(`/api/events/${event.id}/archive`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    const active = await invoke(listEvents as never, req('/api/events'), data);
    expect(((await active.response.json()) as EventListResponse).total).toBe(0);

    const archived = await invoke(
      listEvents as never,
      req('/api/events?archived=archived'),
      data,
    );
    expect(((await archived.response.json()) as EventListResponse).total).toBe(1);
  });

  it.each([
    'status=MADE_UP',
    'sort=password_hash',
    'sort=id;DROP TABLE events',
    'direction=sideways',
    'archived=maybe',
    'pageSize=201',
    'page=0',
  ])('rejects the invalid filter %s', async (query) => {
    const data = await gate('/api/events');
    const { response } = await invoke(listEvents as never, req(`/api/events?${query}`), data);
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe('INVALID_QUERY');
  });

  it('leaves the table intact after injection attempts', async () => {
    const data = await gate('/api/events');
    await invoke(listEvents as never, req("/api/events?search=';DROP TABLE events;--"), data);
    const still = db.raw
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='events'")
      .get() as { n: number };
    expect(still.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/events/:id', () => {
  it('returns the event with available actions and actors', async () => {
    const event = await createDraft(futureWindow());
    // Since phase 6, publishing an event needs a published registration form.
    seedPublishedForm(event.id);
    const data = await gate(`/api/events/${event.id}`);

    const { response } = await invoke(
      getEvent as never,
      req(`/api/events/${event.id}`),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as EventDetailResponse;
    expect(body.event.id).toBe(event.id);
    expect(body.availableActions).toContain('publish');
    // An event carrying a published form can no longer be deleted; deleting it
    // would destroy the record of what people were asked.
    expect(body.canDelete).toBe(false);
    expect(body.editableFields).toContain('slug');
    expect(body.actors.createdBy.displayName).toBe('Ada Lovelace');
  });

  it('reports blocked actions with their missing fields', async () => {
    const event = await createDraft();
    const data = await gate(`/api/events/${event.id}`);
    const { response } = await invoke(
      getEvent as never,
      req(`/api/events/${event.id}`),
      data,
      { id: event.id },
    );

    const body = (await response.json()) as EventDetailResponse;
    const publish = body.blockedActions.find((entry) => entry.action === 'publish');
    expect(publish?.missingFields).toContain('registrationOpensAt');
  });

  it('404s for an unknown id and 400s for a malformed one', async () => {
    const data = await gate('/api/events/x');

    const missing = newId();
    const notFound = await invoke(
      getEvent as never,
      req(`/api/events/${missing}`),
      data,
      { id: missing },
    );
    expect(notFound.response.status).toBe(404);
    expect(((await notFound.response.json()) as ApiErrorBody).error.code).toBe(
      'EVENT_NOT_FOUND',
    );

    for (const hostile of ['not-a-uuid', '../../admin', "1' OR '1'='1"]) {
      const bad = await invoke(getEvent as never, req('/api/events/x'), data, {
        id: hostile,
      });
      expect(bad.response.status, hostile).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/events/:id', () => {
  it('updates and returns the new revision', async () => {
    const event = await createDraft();
    const data = await gate(`/api/events/${event.id}`);

    const { response } = await invoke(
      patchEvent as never,
      req(`/api/events/${event.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, name: 'Renamed' }),
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(200);
    const updated = (await response.json()) as Event;
    expect(updated.name).toBe('Renamed');
    expect(updated.revision).toBe(2);
  });

  it('409s on a stale revision', async () => {
    const event = await createDraft();
    const data = await gate(`/api/events/${event.id}`);
    const patch = (revision: number, name: string) =>
      invoke(
        patchEvent as never,
        req(`/api/events/${event.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ expectedRevision: revision, name }),
        }),
        data,
        { id: event.id },
      );

    await patch(1, 'First');
    const stale = await patch(1, 'Second');
    expect(stale.response.status).toBe(409);
    expect(((await stale.response.json()) as ApiErrorBody).error.code).toBe(
      'EVENT_REVISION_CONFLICT',
    );
  });

  it('refuses a status change and an empty patch', async () => {
    const event = await createDraft();
    const data = await gate(`/api/events/${event.id}`);

    for (const body of [
      { expectedRevision: 1, status: 'OPEN' },
      { expectedRevision: 1 },
      { name: 'No revision' },
    ]) {
      const { response } = await invoke(
        patchEvent as never,
        req(`/api/events/${event.id}`, { method: 'PATCH', body: JSON.stringify(body) }),
        data,
        { id: event.id },
      );
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    const current = db.raw
      .prepare('SELECT status FROM events WHERE id = ?')
      .get(event.id) as { status: string };
    expect(current.status).toBe('DRAFT');
  });

  it('409s when a field is frozen by the current state', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const data = await gate(`/api/events/${event.id}`);
    await invoke(
      openEvent as never,
      req(`/api/events/${event.id}/open`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    const { response } = await invoke(
      patchEvent as never,
      req(`/api/events/${event.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 2, minimumAge: 21 }),
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('EVENT_CANNOT_BE_EDITED');
    expect(body.error.fields?.locked).toContain('minimumAge');
  });
});

// ---------------------------------------------------------------------------
describe('transition endpoints', () => {
  it('accepts an empty body', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const data = await gate(`/api/events/${event.id}/publish`);

    const { response } = await invoke(
      publishEvent as never,
      new Request(`https://example.com/api/events/${event.id}/publish`, {
        method: 'POST',
        headers: { Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}` },
      }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { event: Event };
    expect(body.event.status).toBe('SCHEDULED');
  });

  it('409s on an invalid transition with the state named', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const data = await gate(`/api/events/${event.id}/publish`);
    await invoke(
      openEvent as never,
      req(`/api/events/${event.id}/open`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    const { response } = await invoke(
      publishEvent as never,
      req(`/api/events/${event.id}/publish`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('EVENT_INVALID_TRANSITION');
    expect(body.error.fields?.from).toBe('OPEN');
  });

  it('400s when required configuration is missing', async () => {
    const event = await createDraft();
    const data = await gate(`/api/events/${event.id}/publish`);

    const { response } = await invoke(
      publishEvent as never,
      req(`/api/events/${event.id}/publish`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ApiErrorBody;
    expect(body.error.code).toBe('EVENT_REQUIRED_FIELDS_MISSING');
    expect(body.error.fields?.missing).toContain('registrationOpensAt');
  });

  it('honours expectedRevision', async () => {
    const event = await createDraft(futureWindow());
    const data = await gate(`/api/events/${event.id}/publish`);

    const { response } = await invoke(
      publishEvent as never,
      req(`/api/events/${event.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: 99 }),
      }),
      data,
      { id: event.id },
    );
    expect(response.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe('duplicate and delete', () => {
  it('duplicates into a new draft', async () => {
    const event = await createDraft(futureWindow());
    const data = await gate(`/api/events/${event.id}/duplicate`);

    const { response } = await invoke(
      duplicateEvent as never,
      req(`/api/events/${event.id}/duplicate`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(201);
    const copy = (await response.json()) as Event;
    expect(copy.id).not.toBe(event.id);
    expect(copy.status).toBe('DRAFT');
  });

  it('deletes a pristine draft', async () => {
    const event = await createDraft();
    const data = await gate(`/api/events/${event.id}`);

    const { response } = await invoke(
      deleteEvent as never,
      req(`/api/events/${event.id}?expectedRevision=1`, { method: 'DELETE' }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(200);
    const count = db.raw.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('409s when deleting a non-draft', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const data = await gate(`/api/events/${event.id}`);
    await invoke(
      publishEvent as never,
      req(`/api/events/${event.id}/publish`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    const { response } = await invoke(
      deleteEvent as never,
      req(`/api/events/${event.id}`, { method: 'DELETE' }),
      data,
      { id: event.id },
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as ApiErrorBody).error.code).toBe(
      'EVENT_CANNOT_BE_DELETED',
    );
  });
});

// ---------------------------------------------------------------------------
describe('audit integration', () => {
  it('records every mutation with the actor and the event id', async () => {
    const event = await createDraft(futureWindow());
    seedPublishedForm(event.id);
    const data = await gate(`/api/events/${event.id}`);

    await invoke(
      patchEvent as never,
      req(`/api/events/${event.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: 1, name: 'Renamed' }),
      }),
      data,
      { id: event.id },
    );
    await invoke(
      publishEvent as never,
      req(`/api/events/${event.id}/publish`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    const rows = db.raw
      .prepare('SELECT * FROM audit_logs WHERE event_id = ? ORDER BY rowid ASC')
      .all(event.id) as Array<Record<string, unknown>>;

    expect(rows.map((r) => r.action)).toEqual([
      'EVENT_CREATED',
      'EVENT_UPDATED',
      'EVENT_PUBLISHED',
    ]);
    for (const row of rows) {
      expect(row.actor_admin_id).toBeTruthy();
      expect(row.request_id).toBeTruthy();
      expect(row.entity_type).toBe('EVENT');
    }
  });

  it('a rejected mutation writes no audit row', async () => {
    const event = await createDraft();
    const data = await gate(`/api/events/${event.id}`);

    await invoke(
      publishEvent as never,
      req(`/api/events/${event.id}/publish`, { method: 'POST', body: '{}' }),
      data,
      { id: event.id },
    );

    const rows = db.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_PUBLISHED'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// @vitest-environment node
//
// Regression cover for the endpoints that existed BEFORE the auth rework.
// They had no tests at all, yet Phase 1 changed the response builder and the
// authentication they sit behind. These exercise the real handlers, through the
// real middleware, against the real migrated schema.

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { onRequest } from '../functions/_middleware';
import { onRequestPost as registerHandler } from '../functions/api/register';
import { onRequestPost as loginHandler } from '../functions/api/manager/login';
import { onRequestGet as listAttendees } from '../functions/api/attendees/index';
import { onRequestGet as getAttendee } from '../functions/api/attendees/[id]';
import { onRequestGet as getMetrics } from '../functions/api/metrics';
import { onRequestPost as drawRaffle } from '../functions/api/raffle/draw';
import { onRequestGet as currentRaffle } from '../functions/api/raffle/current';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { Attendee, AttendeeListResponse, Metrics } from '../shared/types';

const PASSWORD = 'a-strong-admin-password';
const ADMIN_EMAIL = 'ada@example.com';

let db: TestDatabase;

const VALID_LEAD = {
  firstName: 'Ana',
  lastName: 'Lopez',
  email: 'ana@example.com',
  phone: '+1 555 123 4567',
  highestLevelOfEducation: 'BACHELORS',
  age: 34,
  zip: '33101',
  city: 'Miami',
  housingStatus: 'OWNER',
  ownsVehicle: true,
  isBusinessOwner: false,
};

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
    env: {
      DB: db.d1,
      RESEND_API_KEY: '',
      RESEND_FROM: '',
      ORGANIZER_EMAIL: 'organizer@example.com',
    },
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

function jsonReq(path: string, body?: unknown, method = 'POST'): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function authed(path: string, token: string, method = 'GET', body?: unknown): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function adminSession(): Promise<string> {
  await new AdminRepository(db.d1).create({
    email: ADMIN_EMAIL,
    normalizedEmail: normalizeEmail(ADMIN_EMAIL),
    displayName: 'Ada',
    passwordHash: await hashPassword(PASSWORD),
  });
  const { response } = await invoke(
    loginHandler as never,
    jsonReq('/api/manager/login', { email: ADMIN_EMAIL, password: PASSWORD }),
  );
  const cookies = response.headers.getSetCookie?.() ?? [];
  const match = new RegExp(`${HOST_SESSION_COOKIE_NAME}=([^;]+)`).exec(cookies.join(' | '));
  if (!match) throw new Error('no session cookie');
  return decodeURIComponent(match[1]);
}

/** Registers a lead through the real public endpoint. */
async function registerLead(overrides: Record<string, unknown> = {}) {
  const { response } = await invoke(
    registerHandler as never,
    jsonReq('/api/register', { ...VALID_LEAD, ...overrides }),
  );
  return response;
}

beforeEach(() => {
  db = createTestDatabase();
  // The organizer notification is fire-and-forget; stub fetch so no test
  // touches the network.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

describe('POST /api/register stays public', () => {
  it('accepts a lead with no session at all', async () => {
    const gate = await invoke(onRequest as never, jsonReq('/api/register', VALID_LEAD));
    expect(gate.nextCalled).toBe(true);

    const response = await registerLead();
    expect(response.status).toBe(201);
    const body = (await response.json()) as { participantNumber: number; id: string };
    expect(body.participantNumber).toBe(1);
    expect(body.id).toEqual(expect.any(String));
  });

  it('assigns sequential participant numbers', async () => {
    await registerLead();
    const second = await registerLead({ email: 'second@example.com' });
    const body = (await second.json()) as { participantNumber: number };
    expect(body.participantNumber).toBe(2);
  });

  it('still rejects a duplicate email with 409', async () => {
    await registerLead();
    const duplicate = await registerLead();
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { error: { code: string } }).error.code).toBe(
      'EMAIL_EXISTS',
    );
  });

  it('still validates the payload', async () => {
    const response = await registerLead({ email: 'not-an-email' });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string; fields?: object } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    // Registration errors DO carry field details (unlike login).
    expect(body.error.fields).toBeDefined();
  });
});

describe('legacy admin endpoints require the new session cookie', () => {
  it('all of them 401 without a session', async () => {
    for (const path of [
      '/api/attendees',
      '/api/attendees/some-id',
      '/api/metrics',
      '/api/raffle/current',
      '/api/raffle/draw',
    ]) {
      const { response, nextCalled } = await invoke(
        onRequest as never,
        new Request(`https://example.com${path}`),
      );
      expect(nextCalled, path).toBe(false);
      expect(response.status, path).toBe(401);
    }
  });

  it('GET /api/attendees works with a session', async () => {
    const token = await adminSession();
    await registerLead();
    await registerLead({ email: 'second@example.com', firstName: 'Beto' });

    const { response } = await invoke(
      listAttendees as never,
      authed('/api/attendees', token),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as AttendeeListResponse;
    expect(body.total).toBe(2);
    expect(body.items).toHaveLength(2);
    // Newest first, as the dashboard expects.
    expect(body.items[0].participantNumber).toBe(2);
  });

  it('GET /api/attendees honours search and pagination', async () => {
    const token = await adminSession();
    await registerLead();
    await registerLead({ email: 'beto@example.com', firstName: 'Beto' });

    const search = await invoke(
      listAttendees as never,
      authed('/api/attendees?search=Beto', token),
    );
    const body = (await search.response.json()) as AttendeeListResponse;
    expect(body.total).toBe(1);
    expect(body.items[0].firstName).toBe('Beto');

    const paged = await invoke(
      listAttendees as never,
      authed('/api/attendees?page=2&pageSize=1', token),
    );
    const pagedBody = (await paged.response.json()) as AttendeeListResponse;
    expect(pagedBody.page).toBe(2);
    expect(pagedBody.items).toHaveLength(1);
  });

  it('GET /api/attendees/:id returns one lead and 404s otherwise', async () => {
    const token = await adminSession();
    const created = await registerLead();
    const { id } = (await created.json()) as { id: string };

    const found = await invoke(
      getAttendee as never,
      authed(`/api/attendees/${id}`, token),
      {},
      { id },
    );
    expect(found.response.status).toBe(200);
    expect(((await found.response.json()) as Attendee).email).toBe('ana@example.com');

    const missing = await invoke(
      getAttendee as never,
      authed('/api/attendees/nope', token),
      {},
      { id: 'nope' },
    );
    expect(missing.response.status).toBe(404);
  });

  it('GET /api/metrics aggregates correctly', async () => {
    const token = await adminSession();
    await registerLead();
    await registerLead({
      email: 'renter@example.com',
      housingStatus: 'RENTER',
      ownsVehicle: false,
    });

    const { response } = await invoke(getMetrics as never, authed('/api/metrics', token));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Metrics;
    expect(body.total).toBe(2);
    expect(body.byHousingStatus.OWNER).toBe(1);
    expect(body.byHousingStatus.RENTER).toBe(1);
    expect(body.byVehicle.yes).toBe(1);
    expect(body.byVehicle.no).toBe(1);
    expect(body.byEducation.BACHELORS).toBe(2);
  });

  it('the raffle still draws, records and reports a winner', async () => {
    const token = await adminSession();
    await registerLead();

    const empty = await invoke(
      currentRaffle as never,
      authed('/api/raffle/current', token),
    );
    expect(await empty.response.json()).toBeNull();

    const draw = await invoke(
      drawRaffle as never,
      authed('/api/raffle/draw', token, 'POST', { mode: 'random' }),
    );
    expect(draw.response.status).toBe(200);
    const drawn = (await draw.response.json()) as { winner: Attendee; drawnAt: string };
    expect(drawn.winner.email).toBe('ana@example.com');

    const current = await invoke(
      currentRaffle as never,
      authed('/api/raffle/current', token),
    );
    const currentBody = (await current.response.json()) as { winner: Attendee };
    expect(currentBody.winner.email).toBe('ana@example.com');

    // Everyone drawn already → the second random draw is refused.
    const again = await invoke(
      drawRaffle as never,
      authed('/api/raffle/draw', token, 'POST', { mode: 'random' }),
    );
    expect(again.response.status).toBe(409);
  });

  it('the raffle rejects an unknown participant number', async () => {
    const token = await adminSession();
    await registerLead();
    const { response } = await invoke(
      drawRaffle as never,
      authed('/api/raffle/draw', token, 'POST', { mode: 'manual', participantNumber: 999 }),
    );
    expect(response.status).toBe(404);
  });

  it('responses still carry a JSON content type after the header rewrite', async () => {
    const token = await adminSession();
    await registerLead();
    const { response } = await invoke(getMetrics as never, authed('/api/metrics', token));
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });
});

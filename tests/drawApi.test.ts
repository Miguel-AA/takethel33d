// @vitest-environment node
//
// The draw endpoint, driven through the real middleware.
//
// Going through the middleware rather than calling the handler directly is what
// makes these tests prove the ROUTING classification as well as the handler: if
// `/api/events` ever left `PROTECTED_ROUTES`, the anonymous cases below would
// return a draw instead of a 401.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as drawRoute from '../functions/api/events/[id]/draw';
import { onRequest as middleware } from '../functions/_middleware';
import { AdminAuthService } from '../functions/_shared/adminAuthService';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import {
  createDrawHarness,
  seedDrawableEvent,
  type DrawHarness,
} from './helpers/drawFlow';
import type { ApiErrorBody, DrawResponse, DrawStatusResponse } from '../shared/types';

let harness: DrawHarness;
let sessionToken: string;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createDrawHarness();

  const login = await new AdminAuthService(harness.db.d1).login(
    { email: 'ada@example.com', password: 'a-strong-admin-password' },
    {
      requestId: 'req-login',
      ipHash: null,
      userAgent: null,
      origin: null,
      method: 'POST',
      pathname: '/api/manager/login',
    },
  );
  if (login.kind !== 'ok') throw new Error(`login failed: ${login.kind}`);
  sessionToken = login.token;
});

afterEach(() => {
  setLogSink(null);
  harness.close();
});

interface CallResult {
  status: number;
  json: unknown;
  headers: Headers;
}

async function call(
  method: 'GET' | 'POST',
  eventId: string,
  options: { body?: unknown; rawBody?: string; anonymous?: boolean } = {},
): Promise<CallResult> {
  const handler = method === 'GET' ? drawRoute.onRequestGet : drawRoute.onRequestPost;
  const path = `/api/events/${eventId}/draw`;

  const request = new Request(`https://example.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.anonymous
        ? {}
        : { Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` }),
    },
    ...(options.rawBody !== undefined
      ? { body: options.rawBody }
      : options.body !== undefined
        ? { body: JSON.stringify(options.body) }
        : {}),
  });

  const pending: Promise<unknown>[] = [];
  const shared = {
    request,
    env: { DB: harness.db.d1 },
    data: {} as Record<string, unknown>,
    params: { id: eventId },
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  };

  const response = await middleware({
    ...shared,
    next: async () => (handler as (ctx: never) => Promise<Response>)({ ...shared } as never),
  } as never);

  await Promise.allSettled(pending);
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

// ---------------------------------------------------------------------------
describe('authentication', () => {
  it('refuses an anonymous read', async () => {
    const { event } = await seedDrawableEvent(harness);
    const result = await call('GET', event.id, { anonymous: true });
    expect(result.status).toBe(401);
  });

  it('refuses an anonymous draw, and draws nothing', async () => {
    const { event } = await seedDrawableEvent(harness);
    const result = await call('POST', event.id, { anonymous: true, body: {} });
    expect(result.status).toBe(401);

    const rows = harness.db.raw.prepare('SELECT COUNT(*) AS n FROM draws').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('GET', () => {
  it('reports readiness before a draw', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [2] });
    const result = await call('GET', event.id);

    expect(result.status).toBe(200);
    const body = result.json as DrawStatusResponse;
    expect(body.draw).toBeNull();
    expect(body.assignments).toEqual([]);
    expect(body.readiness).toMatchObject({
      candidateCount: 4,
      prizeUnitCount: 2,
      plannedWinnerCount: 2,
      canRun: true,
    });
  });

  it('never caches: the body names winners', async () => {
    const { event } = await seedDrawableEvent(harness);
    const result = await call('GET', event.id);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });

  it('404s an event that does not exist', async () => {
    const result = await call('GET', crypto.randomUUID());
    expect(result.status).toBe(404);
    expect((result.json as ApiErrorBody).error.code).toBe('EVENT_NOT_FOUND');
  });

  it('400s an id that is not a UUID, without touching the database', async () => {
    const result = await call('GET', 'not-a-uuid');
    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('INVALID_QUERY');
  });
});

// ---------------------------------------------------------------------------
describe('POST', () => {
  it('runs the draw and answers 201', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 5, prizes: [2] });
    const result = await call('POST', event.id, { body: {} });

    expect(result.status).toBe(201);
    const body = result.json as DrawResponse;
    expect(body.draw?.assignmentCount).toBe(2);
    expect(body.assignments).toHaveLength(2);
    expect(body.eventStatus).toBe('DRAW_COMPLETED');
  });

  it('accepts a request with no body at all', async () => {
    // A parameterless action should not demand a payload with nothing in it.
    const { event } = await seedDrawableEvent(harness);
    const result = await call('POST', event.id);
    expect(result.status).toBe(201);
  });

  it('answers a second draw with 200 and the SAME result', async () => {
    // 201 created it; 200 says it already existed. A retry after a lost
    // response asks for this event to be drawn, and it is drawn — so the answer
    // is the result, and the status code carries the only difference.
    const { event } = await seedDrawableEvent(harness, { participants: 6, prizes: [3] });
    const created = await call('POST', event.id, { body: {} });
    expect(created.status).toBe(201);

    const second = await call('POST', event.id, { body: {} });
    expect(second.status).toBe(200);
    expect(second.json).toEqual(created.json);

    const rows = harness.db.raw.prepare('SELECT COUNT(*) AS n FROM draws').get() as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('409s an event that is not ready, and says which state it is in', async () => {
    const { event } = await seedDrawableEvent(harness, { markReady: false });
    const result = await call('POST', event.id, { body: {} });

    expect(result.status).toBe(409);
    const body = result.json as ApiErrorBody;
    expect(body.error.code).toBe('DRAW_NOT_READY');
    expect(body.error.fields?.eventStatus).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
describe('the body is refused, not ignored', () => {
  // The whole point of `.strict()`. A silently dropped key would let somebody
  // believe they had influenced the draw, and would let a real influence slip
  // in later without a test noticing.
  it.each([
    ['a seed', { seed: 42 }],
    ['a seed as a string', { seed: 'deterministic' }],
    ['a candidate list', { candidates: ['a', 'b'] }],
    ['chosen winners', { winners: ['entry-1'] }],
    ['a specific entry', { entryId: 'entry-1' }],
    ['a specific prize', { prizeId: 'prize-1' }],
    ['a winner count', { count: 99 }],
    ['a manual mode', { mode: 'manual', participantNumber: 3 }],
    ['an algorithm override', { algorithmVersion: 'MINE' }],
    ['a forced timestamp', { completedAt: '2020-01-01T00:00:00.000Z' }],
    ['an actor', { executedByAdminId: 'somebody-else' }],
  ])('refuses %s', async (_label, body) => {
    const { event } = await seedDrawableEvent(harness);
    const result = await call('POST', event.id, { body });

    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');

    // And nothing happened.
    const rows = harness.db.raw.prepare('SELECT COUNT(*) AS n FROM draws').get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  it('refuses a body that is not an object', async () => {
    const { event } = await seedDrawableEvent(harness);
    const result = await call('POST', event.id, { rawBody: '[1,2,3]' });
    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('the response', () => {
  it('carries the winners, in draw order', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 6, prizes: [3] });
    const posted = await call('POST', event.id, { body: {} });
    const body = posted.json as DrawResponse;

    expect(body.assignments.map((a) => a.drawOrder)).toEqual([0, 1, 2]);
    for (const assignment of body.assignments) {
      expect(assignment.winner.firstName).toMatch(/^Person\d$/);
      expect(assignment.prize.name).toBe('Prize 1');
    }
  });

  it('reads back identically through GET', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [2] });
    const posted = (await call('POST', event.id, { body: {} })).json as DrawResponse;
    const fetched = (await call('GET', event.id)).json as DrawStatusResponse;

    expect(fetched.draw).toEqual(posted.draw);
    expect(fetched.assignments).toEqual(posted.assignments);
    expect(fetched.readiness.canRun).toBe(false);
    expect(fetched.readiness.blockers).toEqual(['DRAW_ALREADY_COMPLETED']);
  });
});

// ---------------------------------------------------------------------------
describe('the surface is exactly two methods', () => {
  it('exports GET and POST and nothing that mutates by another name', () => {
    const exported = Object.keys(drawRoute).sort();
    expect(exported).toEqual(['onRequestGet', 'onRequestPost']);
    // No PATCH, PUT or DELETE — and no catch-all `onRequest`, which would
    // accept every method including the ones that have no meaning here.
    for (const forbidden of ['onRequest', 'onRequestPatch', 'onRequestPut', 'onRequestDelete']) {
      expect(exported).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
describe('what the response carries, and what it does not', () => {
  it('names the winners without exposing anything the draw did not need', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [2] });
    const body = (await call('POST', event.id, { body: {} })).json as DrawResponse;
    const serialized = JSON.stringify(body);

    // The administrative surface deliberately carries a name and an email —
    // that is how an operator hands over a prize. Everything else that lives on
    // a participation must stay where it is.
    for (const leak of [
      'dateOfBirth',
      'date_of_birth',
      'calculatedAge',
      'ageEligible',
      'eligibilityReason',
      'phone',
      'answers',
      'ipHash',
      'submissionId',
      'participantId',
      'revision',
    ]) {
      expect(serialized, `response leaked ${leak}`).not.toContain(leak);
    }
  });

  it('stores no personal data on the draw itself', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 3, prizes: [2] });
    await call('POST', event.id, { body: {} });

    // The draw tables reference a participation; they do not COPY it. A name or
    // an address recorded here would be a second home for personal data with no
    // erasure path.
    const drawColumns = (
      harness.db.raw.prepare('PRAGMA table_info(draws)').all() as Array<{ name: string }>
    ).map((row) => row.name);
    const assignmentColumns = (
      harness.db.raw
        .prepare('PRAGMA table_info(draw_assignments)')
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    for (const forbidden of [
      'email',
      'first_name',
      'last_name',
      'phone',
      'date_of_birth',
      'answers',
      'ip_hash',
    ]) {
      expect(drawColumns, `draws.${forbidden}`).not.toContain(forbidden);
      expect(assignmentColumns, `draw_assignments.${forbidden}`).not.toContain(forbidden);
    }

    const rows = harness.db.raw.prepare('SELECT * FROM draw_assignments').all();
    expect(JSON.stringify(rows)).not.toContain('person0@example.com');
  });
});

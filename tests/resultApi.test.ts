// @vitest-environment node
//
// The results endpoints, driven through the real middleware.
//
// Going through the middleware rather than calling the handlers directly is
// what makes these tests prove the ROUTING classification as well as the
// handler: the administrative endpoints must be behind `/api/events`, and the
// public one must be outside it. Both are asserted by driving real requests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as resultsRoute from '../functions/api/events/[id]/results/index';
import * as publishRoute from '../functions/api/events/[id]/results/publish';
import * as publicResultsRoute from '../functions/api/public-events/[slug]/results';
import { onRequest as middleware } from '../functions/_middleware';
import { AdminAuthService } from '../functions/_shared/adminAuthService';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { isProtectedPath } from '../functions/_shared/routes';
import {
  archive,
  createResultHarness,
  seedDrawnEvent,
  seedPublishedEvent,
  type ResultHarness,
} from './helpers/resultFlow';
import type {
  AdminEventResults,
  ApiErrorBody,
  PublicEventResultsDTO,
  PublishResultsResponse,
} from '../shared/types';

let harness: ResultHarness;
let sessionToken: string;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createResultHarness();

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
  if (login.kind !== 'ok') throw new Error('login failed');
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
  handler: (ctx: never) => Promise<Response>,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string>,
  options: { body?: unknown; rawBody?: string; anonymous?: boolean } = {},
): Promise<CallResult> {
  const request = new Request(`https://example.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.9',
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
    params,
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  };

  const response = await middleware({
    ...shared,
    next: async () => handler({ ...shared } as never),
  } as never);

  await Promise.allSettled(pending);
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : null,
    headers: response.headers,
  };
}

const adminResults = (eventId: string, options = {}) =>
  call(
    resultsRoute.onRequestGet as never,
    'GET',
    `/api/events/${eventId}/results`,
    { id: eventId },
    options,
  );

const publish = (eventId: string, options = {}) =>
  call(
    publishRoute.onRequestPost as never,
    'POST',
    `/api/events/${eventId}/results/publish`,
    { id: eventId },
    options,
  );

const publicResults = (slug: string) =>
  call(
    publicResultsRoute.onRequestGet as never,
    'GET',
    `/api/public-events/${slug}/results`,
    { slug },
    { anonymous: true },
  );

// ---------------------------------------------------------------------------
describe('routing', () => {
  it('protects the administrative endpoints and leaves the public one open', () => {
    for (const path of [
      '/api/events/abc/results',
      '/api/events/abc/results/publish',
      '/API/EVENTS/abc/RESULTS',
      '//api//events//abc//results',
      '/api/events/../events/abc/results/publish',
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
    // Public by omission, exactly as its siblings are.
    expect(isProtectedPath('/api/public-events/some-slug/results')).toBe(false);
  });

  it('refuses an anonymous administrative read', async () => {
    const { event } = await seedPublishedEvent(harness);
    const result = await adminResults(event.id, { anonymous: true });
    expect(result.status).toBe(401);
  });

  it('refuses an anonymous publish, and publishes nothing', async () => {
    const { event } = await seedDrawnEvent(harness);
    const result = await publish(event.id, { anonymous: true, body: {} });
    expect(result.status).toBe(401);

    const rows = harness.db.raw
      .prepare('SELECT COUNT(*) AS n FROM result_publications')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the administrative read', () => {
  it('answers at every stage of the event’s life', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 4, prizes: [2] });

    const drawn = (await adminResults(event.id)).json as AdminEventResults;
    expect(drawn.draw).not.toBeNull();
    expect(drawn.publication).toBeNull();
    expect(drawn.canPublish).toBe(true);

    await publish(event.id, { body: {} });
    const published = (await adminResults(event.id)).json as AdminEventResults;
    expect(published.publication).not.toBeNull();
    expect(published.publicationState).toBe('PUBLISHED');
    expect(published.canPublish).toBe(false);

    await archive(harness, event.id);
    const archived = (await adminResults(event.id)).json as AdminEventResults;
    expect(archived.eventStatus).toBe('ARCHIVED');
    expect(archived.draw).toEqual(published.draw);
    expect(archived.assignments).toEqual(published.assignments);
    expect(archived.publication).toEqual(published.publication);
  });

  it('never caches: the body names winners', async () => {
    const { event } = await seedPublishedEvent(harness);
    const result = await adminResults(event.id);
    expect(result.headers.get('Cache-Control')).toBe('no-store');
  });

  it('404s an event that does not exist, and 400s a malformed id', async () => {
    expect((await adminResults(crypto.randomUUID())).status).toBe(404);
    const malformed = await adminResults('not-a-uuid');
    expect(malformed.status).toBe(400);
    expect((malformed.json as ApiErrorBody).error.code).toBe('INVALID_QUERY');
  });
});

// ---------------------------------------------------------------------------
describe('publishing', () => {
  it('publishes and answers 201', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 5, prizes: [3] });
    const result = await publish(event.id, { body: {} });

    expect(result.status).toBe(201);
    const body = result.json as PublishResultsResponse;
    expect(body.results.publication?.winnerCount).toBe(3);
    expect(body.results.publicationState).toBe('PUBLISHED');
  });

  it('accepts a request with no body at all', async () => {
    const { event } = await seedDrawnEvent(harness);
    expect((await publish(event.id)).status).toBe(201);
  });

  it('answers a retry with 200 and the SAME record', async () => {
    const { event } = await seedDrawnEvent(harness, { participants: 5, prizes: [3] });
    const created = await publish(event.id, { body: {} });
    expect(created.status).toBe(201);

    const again = await publish(event.id, { body: {} });
    expect(again.status).toBe(200);
    expect(again.json).toEqual(created.json);

    const rows = harness.db.raw
      .prepare('SELECT COUNT(*) AS n FROM result_publications')
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('409s an event that has not been drawn, naming the blocker', async () => {
    const { event } = await seedDrawnEvent(harness);
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw.exec('DELETE FROM draw_assignments');
    harness.db.raw.exec('DELETE FROM draws');
    harness.db.raw.exec('PRAGMA foreign_keys = ON');
    harness.db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);

    const result = await publish(event.id, { body: {} });
    expect(result.status).toBe(409);
    const body = result.json as ApiErrorBody;
    expect(body.error.code).toBe('RESULTS_NOT_PUBLISHABLE');
    expect(body.error.fields?.blocker).toBe('EVENT_NOT_DRAWN');
  });

  it('409s an archived event, and stays refused forever', async () => {
    const { event } = await seedDrawnEvent(harness);
    await archive(harness, event.id);

    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await publish(event.id, { body: {} });
      expect(result.status).toBe(409);
      expect((result.json as ApiErrorBody).error.fields?.blocker).toBe('EVENT_ARCHIVED');
    }
    const rows = harness.db.raw
      .prepare('SELECT COUNT(*) AS n FROM result_publications')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the publish body is refused, not ignored', () => {
  it.each([
    ['a draw id', { drawId: 'draw-1' }],
    ['winner names', { winnerNames: ['Somebody E.'] }],
    ['display names', { displayNames: { 'entry-1': 'Chosen C.' } }],
    ['assignment ids', { assignmentIds: ['a1'] }],
    ['a winner count', { winnerCount: 99 }],
    ['a publication instant', { publishedAt: '2020-01-01T00:00:00.000Z' }],
    ['an actor', { publishedBy: 'somebody-else' }],
    ['prize names', { prizeNames: ['Something else'] }],
    ['an event id', { eventId: 'another-event' }],
    ['a publication id', { id: 'chosen-publication-id' }],
  ])('refuses %s', async (_label, body) => {
    const { event } = await seedDrawnEvent(harness);
    const result = await publish(event.id, { body });

    expect(result.status).toBe(400);
    expect((result.json as ApiErrorBody).error.code).toBe('VALIDATION_ERROR');

    const rows = harness.db.raw
      .prepare('SELECT COUNT(*) AS n FROM result_publications')
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('refuses a body that is not an object', async () => {
    const { event } = await seedDrawnEvent(harness);
    expect((await publish(event.id, { rawBody: '[1,2,3]' })).status).toBe(400);
  });

  it('strips a raw __proto__ key rather than letting it reach anything', async () => {
    // Sent as RAW JSON on purpose. Written as an object literal, `__proto__:`
    // sets the prototype instead of creating an own property, so
    // `JSON.stringify` would produce `{}` and the test would pass against a
    // completely undefended endpoint.
    //
    // The expected outcome is 201, and that is the phase 9 reader working:
    // `__proto__`, `constructor` and `prototype` are removed during parsing, so
    // what reaches the strict schema is genuinely an empty object. A 400 would
    // mean the keys had survived far enough to be rejected — safe, but a weaker
    // guarantee than never arriving.
    const { event } = await seedDrawnEvent(harness);
    const result = await publish(event.id, {
      rawBody: '{"__proto__":{"polluted":true},"constructor":{"x":1}}',
    });

    expect(result.status).toBe(201);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

// ---------------------------------------------------------------------------
describe('the surface is exactly what it claims', () => {
  it('exports one method per endpoint and nothing that could undo a publication', () => {
    expect(Object.keys(resultsRoute).sort()).toEqual(['onRequestGet']);
    expect(Object.keys(publishRoute).sort()).toEqual(['onRequestPost']);
    expect(Object.keys(publicResultsRoute).sort()).toEqual(['onRequestGet']);

    for (const route of [resultsRoute, publishRoute, publicResultsRoute]) {
      for (const forbidden of [
        'onRequest',
        'onRequestPut',
        'onRequestPatch',
        'onRequestDelete',
      ]) {
        expect(Object.keys(route)).not.toContain(forbidden);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('the public read', () => {
  it('is unavailable before publication, and identically so for every reason', async () => {
    const drawn = await seedDrawnEvent(harness);

    const unknown = await publicResults('no-such-event-anywhere');
    const privateDraw = await publicResults(drawn.event.slug);

    expect(unknown.status).toBe(404);
    expect(privateDraw.status).toBe(404);
    // Byte-identical apart from the correlation id: an attacker must not be
    // able to tell a private draw from an event that never existed.
    const strip = (body: unknown) =>
      JSON.stringify(body).replace(/"requestId":"[^"]*"/, '');
    expect(strip(privateDraw.json)).toBe(strip(unknown.json));
    expect((privateDraw.json as ApiErrorBody).error.code).toBe('RESULTS_NOT_AVAILABLE');
  });

  it('returns the winners once published', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 6, prizes: [3] });
    const result = await publicResults(event.slug);

    expect(result.status).toBe(200);
    const body = result.json as PublicEventResultsDTO;
    expect(body.event).toEqual({ slug: event.slug, name: event.name });
    expect(body.results.winners).toHaveLength(3);
    for (const winner of body.results.winners) {
      expect(winner.displayName).toMatch(/^Person\d T\.$/);
    }
  });

  it('survives archiving', async () => {
    const { event } = await seedPublishedEvent(harness, { participants: 4, prizes: [2] });
    const before = await publicResults(event.slug);
    await archive(harness, event.id);
    const after = await publicResults(event.slug);

    expect(after.status).toBe(200);
    expect(after.json).toEqual(before.json);
  });

  it('stays private forever when an unpublished event is archived', async () => {
    const { event } = await seedDrawnEvent(harness);
    await archive(harness, event.id);
    expect((await publicResults(event.slug)).status).toBe(404);
  });

  it('carries nothing an administrator would see', async () => {
    const { event, draw, entryIds } = await seedPublishedEvent(harness, {
      participants: 4,
      prizes: [2],
    });
    const body = JSON.stringify((await publicResults(event.slug)).json);

    for (const leak of [
      ...entryIds,
      draw.id,
      draw.candidateSetHash,
      draw.algorithmVersion,
      harness.admin.id,
      harness.admin.email,
      '@example.com',
      'email',
      'entryId',
      'assignmentId',
      'participantId',
      'publicationId',
      'candidateCount',
      'assignmentCount',
      'dateOfBirth',
      'phone',
      'eligibility',
      'answers',
    ]) {
      expect(body, `public results leaked ${leak}`).not.toContain(leak);
    }
    // The surname exists only as an initial.
    expect(body).not.toContain('"Test"');
  });

  it('never caches', async () => {
    const { event } = await seedPublishedEvent(harness);
    expect((await publicResults(event.slug)).headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses a malformed slug the same way it refuses an unknown one', async () => {
    const unknown = await publicResults('no-such-event-anywhere');
    const malformed = await publicResults('NOT..A..SLUG');
    expect(malformed.status).toBe(unknown.status);
    expect((malformed.json as ApiErrorBody).error.code).toBe(
      (unknown.json as ApiErrorBody).error.code,
    );
  });
});

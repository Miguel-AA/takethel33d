// @vitest-environment node
//
// The participant-administration endpoints, driven through the real middleware.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as participantsIndex from '../functions/api/events/[id]/participants/index';
import * as participantsSummary from '../functions/api/events/[id]/participants/summary';
import * as participantDetail from '../functions/api/events/[id]/participants/[entryId]/index';
import * as disqualifyRoute from '../functions/api/events/[id]/participants/[entryId]/disqualify';
import * as reinstateRoute from '../functions/api/events/[id]/participants/[entryId]/reinstate';
import { onRequest as middleware } from '../functions/_middleware';
import { AdminAuthService } from '../functions/_shared/adminAuthService';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import {
  answersFor,
  createHarness,
  dobForAge,
  seedPublicEvent,
  DOB_QUESTION,
  type PublicHarness,
} from './helpers/publicFlow';
import type { ApiErrorBody, Event, EventEntry, EventFormVersion } from '../shared/types';

let harness: PublicHarness;
let sessionToken: string;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createHarness();

  // A real session, so every request below goes through the real guard.
  const auth = new AdminAuthService(harness.db.d1);
  const login = await auth.login(
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

/** Runs a request through the REAL middleware and into a handler. */
async function call(
  handler: (ctx: never) => Promise<Response>,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  params: Record<string, string>,
  options: { body?: unknown; anonymous?: boolean } = {},
): Promise<CallResult> {
  const request = new Request(`https://example.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.anonymous
        ? {}
        : { Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}` }),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });

  const pending: Promise<unknown>[] = [];
  const data: Record<string, unknown> = {};
  const shared = {
    request,
    env: { DB: harness.db.d1 },
    data,
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

async function enter(
  event: Event,
  version: EventFormVersion,
  overrides: Record<string, unknown> = {},
): Promise<EventEntry> {
  const result = await harness.registration.register(
    event.id,
    answersFor(version, overrides),
    harness.actor(),
  );
  if (!result.ok) throw new Error(JSON.stringify(result.failure));
  return result.value.entry;
}

const list = (eventId: string, query = '') =>
  call(
    participantsIndex.onRequestGet as never,
    'GET',
    `/api/events/${eventId}/participants${query}`,
    { id: eventId },
  );

const detail = (eventId: string, entryId: string) =>
  call(
    participantDetail.onRequestGet as never,
    'GET',
    `/api/events/${eventId}/participants/${entryId}`,
    { id: eventId, entryId },
  );

const disqualify = (eventId: string, entryId: string, body: unknown) =>
  call(
    disqualifyRoute.onRequestPost as never,
    'POST',
    `/api/events/${eventId}/participants/${entryId}/disqualify`,
    { id: eventId, entryId },
    { body },
  );

const reinstate = (eventId: string, entryId: string, body: unknown) =>
  call(
    reinstateRoute.onRequestPost as never,
    'POST',
    `/api/events/${eventId}/participants/${entryId}/reinstate`,
    { id: eventId, entryId },
    { body },
  );

// ---------------------------------------------------------------------------
describe('authentication', () => {
  it('every participant route demands a session', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const routes: Array<[string, () => Promise<CallResult>]> = [
      [
        'list',
        () =>
          call(
            participantsIndex.onRequestGet as never,
            'GET',
            `/api/events/${event.id}/participants`,
            { id: event.id },
            { anonymous: true },
          ),
      ],
      [
        'summary',
        () =>
          call(
            participantsSummary.onRequestGet as never,
            'GET',
            `/api/events/${event.id}/participants/summary`,
            { id: event.id },
            { anonymous: true },
          ),
      ],
      [
        'detail',
        () =>
          call(
            participantDetail.onRequestGet as never,
            'GET',
            `/api/events/${event.id}/participants/${entry.id}`,
            { id: event.id, entryId: entry.id },
            { anonymous: true },
          ),
      ],
      [
        'disqualify',
        () =>
          call(
            disqualifyRoute.onRequestPost as never,
            'POST',
            `/api/events/${event.id}/participants/${entry.id}/disqualify`,
            { id: event.id, entryId: entry.id },
            { anonymous: true, body: { expectedRevision: 1, reason: 'x' } },
          ),
      ],
      [
        'reinstate',
        () =>
          call(
            reinstateRoute.onRequestPost as never,
            'POST',
            `/api/events/${event.id}/participants/${entry.id}/reinstate`,
            { id: event.id, entryId: entry.id },
            { anonymous: true, body: { expectedRevision: 1 } },
          ),
      ],
    ];

    for (const [name, invoke] of routes) {
      const result = await invoke();
      expect(result.status, name).toBe(401);
    }

    // And nothing was written by any of them.
    const row = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    expect(row).toEqual({ status: 'ELIGIBLE', revision: 1 });
  });
});

// ---------------------------------------------------------------------------
describe('the listing', () => {
  it('carries the revision and the disposition, but no date of birth', async () => {
    const { event, version } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    await enter(event, version, { date_of_birth: dobForAge(30) });

    const result = await list(event.id);
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe('no-store');

    const raw = JSON.stringify(result.json);
    expect(raw).toContain('"revision"');
    expect(raw).toContain('"disqualifiedAt"');
    expect(raw).not.toContain('dateOfBirth');
    expect(raw).not.toContain('"phone"');
    expect(raw).not.toContain(dobForAge(30));
  });

  it('carries a fixed key set — no row is spread into the DTO', async () => {
    // The guard against somebody "simplifying" the projection into `...row`.
    // A raw row carries the disqualification reason, the recorded previous
    // status and the submission id, none of which belong in a table: the
    // reason in particular is an administrator's note about a person, and it
    // belongs behind the click that is audited.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    await disqualify(event.id, entry.id, {
      expectedRevision: 1,
      reason: 'A private administrative note',
    });

    const result = await list(event.id);
    const body = result.json as { items: Array<Record<string, unknown>> };

    expect(Object.keys(body.items[0]).sort()).toEqual(
      [
        'answerCount',
        'calculatedAge',
        'disqualifiedAt',
        'eligibilityReason',
        'email',
        'entryId',
        'firstName',
        'formVersionId',
        'formVersionNumber',
        'lastName',
        'overallEligible',
        'participantId',
        'revision',
        'status',
        'submittedAt',
      ].sort(),
    );

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('A private administrative note');
    expect(raw).not.toContain('pre_disqualification_status');
    expect(raw).not.toContain('submission_id');
  });

  it('refuses a malformed filter instead of silently widening it', async () => {
    // A quiet fallback to "ALL" would show an operator more people than they
    // asked for and give them no reason to doubt the answer.
    const { event } = await seedPublicEvent(harness);

    for (const query of [
      '?status=BANANA',
      '?eligibility=MAYBE',
      '?formVersionId=not-a-uuid',
      '?pageSize=99999',
      '?page=0',
    ]) {
      const result = await list(event.id, query);
      expect(result.status, query).toBe(400);
      expect((result.json as ApiErrorBody).error.code, query).toBe('INVALID_QUERY');
    }
  });

  it('never echoes the search term back in an error', async () => {
    // `q` is free text an operator may well have typed an address into.
    const { event } = await seedPublicEvent(harness);
    const result = await list(event.id, '?q=someone@example.com&status=NONSENSE');

    expect(result.status).toBe(400);
    expect(JSON.stringify(result.json)).not.toContain('someone@example.com');
  });

  it('does not audit a listing', async () => {
    const { event, version } = await seedPublicEvent(harness);
    await enter(event, version);
    harness.db.raw.prepare("DELETE FROM audit_logs WHERE action = 'EVENT_ENTRY_VIEWED'").run();

    await list(event.id);

    const audits = harness.db.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_VIEWED'")
      .get() as { n: number };
    expect(audits.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the summary', () => {
  it('is reachable at its own path and counts correctly', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    await enter(event, version, { email: 'a@x.com', date_of_birth: dobForAge(30) });
    await enter(event, version, { email: 'b@x.com', date_of_birth: dobForAge(20) });

    const result = await call(
      participantsSummary.onRequestGet as never,
      'GET',
      `/api/events/${event.id}/participants/summary`,
      { id: event.id },
    );

    expect(result.status).toBe(200);
    expect((result.json as { summary: Record<string, number> }).summary).toEqual({
      total: 2,
      eligible: 1,
      ineligible: 1,
      submitted: 0,
      disqualified: 0,
      drawEligible: 1,
    });
  });

  it('is not shadowed by the detail route', async () => {
    // `summary` is a static segment beside `[entryId]`. Even if precedence were
    // reversed, the detail handler narrows its parameter to a UUID, so the
    // worst case is a clean 400 rather than a lookup for an entry named
    // "summary".
    const { event } = await seedPublicEvent(harness);
    const asDetail = await call(
      participantDetail.onRequestGet as never,
      'GET',
      `/api/events/${event.id}/participants/summary`,
      { id: event.id, entryId: 'summary' },
    );
    expect(asDetail.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('the detail', () => {
  it('carries the personal data the table withholds, and audits the read', async () => {
    const { event, version } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    const entry = await enter(event, version, { date_of_birth: dobForAge(30) });

    const result = await detail(event.id, entry.id);
    expect(result.status).toBe(200);

    const raw = JSON.stringify(result.json);
    expect(raw).toContain('dateOfBirth');
    expect(raw).toContain('"answers"');

    const audits = harness.db.raw
      .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_VIEWED'")
      .get() as { n: number };
    expect(audits.n).toBe(1);
  });

  it('reports an entry from another event as NOT FOUND', async () => {
    const a = await seedPublicEvent(harness, { slug: 'first' });
    const b = await seedPublicEvent(harness, { slug: 'second' });
    const entry = await enter(a.event, a.version, { email: 'ana@example.com' });

    const result = await detail(b.event.id, entry.id);
    expect(result.status).toBe(404);
    // Nothing about the real owner leaks through the refusal.
    expect(JSON.stringify(result.json)).not.toContain('ana@example.com');
  });

  it('refuses a malformed id before it reaches a query', async () => {
    const { event } = await seedPublicEvent(harness);
    const result = await detail(event.id, 'not-a-uuid');
    expect(result.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('disqualify', () => {
  it('records the disposition and returns the new revision', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const result = await disqualify(event.id, entry.id, {
      expectedRevision: 1,
      reason: 'Entered twice',
    });

    expect(result.status).toBe(200);
    const body = result.json as { participant: { entryRevision: number; entry: { status: string } } };
    expect(body.participant.entryRevision).toBe(2);
    expect(body.participant.entry.status).toBe('DISQUALIFIED');
  });

  it('refuses every server-owned field', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const forbidden = [
      'status',
      'preDisqualificationStatus',
      'disqualifiedAt',
      'disqualifiedByAdminId',
      'revision',
      'eventId',
      'entryId',
      'overallEligible',
      'calculatedAge',
      'eligibilityReason',
      'submittedAt',
    ];

    for (const field of forbidden) {
      const result = await disqualify(event.id, entry.id, {
        expectedRevision: 1,
        reason: 'Entered twice',
        [field]: 'injected',
      });
      expect(result.status, field).toBe(400);
    }

    const row = harness.db.raw
      .prepare('SELECT status FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string };
    expect(row.status).toBe('ELIGIBLE');
  });

  it('demands a reason with something in it', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    for (const reason of ['', '   ', 'a', 'x'.repeat(501), null, 42]) {
      const result = await disqualify(event.id, entry.id, {
        expectedRevision: 1,
        reason,
      });
      expect(result.status, String(reason)).toBe(400);
    }
  });

  it('demands a revision', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    for (const body of [
      { reason: 'x'.repeat(10) },
      { expectedRevision: 0, reason: 'valid reason' },
      { expectedRevision: -1, reason: 'valid reason' },
      { expectedRevision: '1', reason: 'valid reason' },
    ]) {
      const result = await disqualify(event.id, entry.id, body);
      expect(result.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('reports a stale revision as a conflict, with the current one', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    await disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'First' });
    await reinstate(event.id, entry.id, { expectedRevision: 2 });

    const stale = await disqualify(event.id, entry.id, {
      expectedRevision: 1,
      reason: 'Stale attempt',
    });

    expect(stale.status).toBe(409);
    const body = stale.json as ApiErrorBody;
    expect(body.error.code).toBe('ENTRY_REVISION_CONFLICT');
    expect(body.error.fields?.currentRevision).toBe('3');
  });

  it('refuses when the event has moved past the point of no return', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    harness.db.raw
      .prepare("UPDATE events SET status = 'DRAW_COMPLETED' WHERE id = ?")
      .run(event.id);

    const result = await disqualify(event.id, entry.id, {
      expectedRevision: 1,
      reason: 'Too late',
    });

    expect(result.status).toBe(409);
    expect((result.json as ApiErrorBody).error.code).toBe('EVENT_PARTICIPANTS_NOT_EDITABLE');
  });

  it('cannot reach an entry belonging to another event', async () => {
    const a = await seedPublicEvent(harness, { slug: 'first' });
    const b = await seedPublicEvent(harness, { slug: 'second' });
    const entry = await enter(a.event, a.version);

    const result = await disqualify(b.event.id, entry.id, {
      expectedRevision: 1,
      reason: 'Wrong event',
    });

    expect(result.status).toBe(404);
    const row = harness.db.raw
      .prepare('SELECT status, revision FROM event_entries WHERE id = ?')
      .get(entry.id) as { status: string; revision: number };
    expect(row).toEqual({ status: 'ELIGIBLE', revision: 1 });
    expect(
      (
        harness.db.raw
          .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_DISQUALIFIED'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('reinstate', () => {
  it('returns the entry to its recorded previous status', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const entry = await enter(event, version, { date_of_birth: dobForAge(20) });

    await disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'Some reason' });
    const result = await reinstate(event.id, entry.id, { expectedRevision: 2 });

    expect(result.status).toBe(200);
    const body = result.json as { participant: { entry: { status: string } } };
    // Never qualified, so it goes back to INELIGIBLE.
    expect(body.participant.entry.status).toBe('INELIGIBLE');
  });

  it('takes no target status from the caller', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);
    await disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'Some reason' });

    const result = await reinstate(event.id, entry.id, {
      expectedRevision: 2,
      status: 'ELIGIBLE',
    });
    expect(result.status).toBe(400);
  });

  it('refuses an entry that is not disqualified', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    const result = await reinstate(event.id, entry.id, { expectedRevision: 1 });
    expect(result.status).toBe(409);
    expect((result.json as ApiErrorBody).error.code).toBe('ENTRY_NOT_DISQUALIFIED');
  });
});

// ---------------------------------------------------------------------------
describe('the surface offers nothing else', () => {
  it('exposes no PATCH, PUT or DELETE anywhere', async () => {
    for (const [name, module] of [
      ['participants/index', participantsIndex],
      ['participants/summary', participantsSummary],
      ['participants/[entryId]/index', participantDetail],
      ['participants/[entryId]/disqualify', disqualifyRoute],
      ['participants/[entryId]/reinstate', reinstateRoute],
    ] as const) {
      const handlers = Object.keys(module).filter((key) => key.startsWith('onRequest'));
      for (const handler of handlers) {
        expect(handler, `${name}.${handler}`).not.toMatch(/Patch|Put|Delete/);
      }
      // And no catch-all, which would answer every verb.
      expect(handlers, name).not.toContain('onRequest');
    }
  });

  it('offers no generic status mutation', () => {
    // A `PATCH { status }` would accept any status the caller named, including
    // promoting somebody who never qualified.
    expect('onRequestPatch' in participantDetail).toBe(false);
    expect('onRequestPost' in participantDetail).toBe(false);
  });
});

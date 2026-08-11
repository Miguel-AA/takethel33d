// @vitest-environment node
//
// Privacy and isolation of the participant-administration surface.
//
// This surface carries the most personal data in the system — names, email
// addresses, phone numbers, dates of birth and every answer somebody gave — so
// the interesting assertions are about what never leaves it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as participantsIndex from '../functions/api/events/[id]/participants/index';
import * as participantsSummary from '../functions/api/events/[id]/participants/summary';
import * as participantDetail from '../functions/api/events/[id]/participants/[entryId]/index';
import * as disqualifyRoute from '../functions/api/events/[id]/participants/[entryId]/disqualify';
import * as reinstateRoute from '../functions/api/events/[id]/participants/[entryId]/reinstate';
import { onRequest as middleware } from '../functions/_middleware';
import { ParticipantAdministrationService } from '../functions/_shared/participantAdministrationService';
import { AdminAuthService } from '../functions/_shared/adminAuthService';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { setLogSink } from '../functions/_shared/logger';
import { isProtectedPath } from '../functions/_shared/routes';
import {
  answersFor,
  createHarness,
  dobForAge,
  seedPublicEvent,
  DOB_QUESTION,
  type PublicHarness,
} from './helpers/publicFlow';
import type { Event, EventEntry, EventFormVersion } from '../shared/types';

let harness: PublicHarness;
let service: ParticipantAdministrationService;
let sessionToken: string;
let lines: string[];

beforeEach(async () => {
  lines = [];
  setLogSink((_level, line) => lines.push(line));
  harness = await createHarness();
  service = new ParticipantAdministrationService(harness.db.d1);

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
  if (login.kind !== 'ok') throw new Error('login failed');
  sessionToken = login.token;
});

afterEach(() => {
  setLogSink(null);
  harness.close();
});

const actor = () => ({
  admin: harness.admin,
  requestContext: {
    requestId: 'req-admin',
    ipHash: null,
    userAgent: null,
    origin: null,
    method: 'POST',
    pathname: '/x',
  },
});

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

async function call(
  handler: (ctx: never) => Promise<Response>,
  method: 'GET' | 'POST',
  path: string,
  params: Record<string, string>,
  body?: unknown,
) {
  const request = new Request(`https://example.com${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const pending: Promise<unknown>[] = [];
  const shared = {
    request,
    env: { DB: harness.db.d1 },
    data: {},
    params,
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  };

  const response = await middleware({
    ...shared,
    next: async () => handler({ ...shared } as never),
  } as never);
  await Promise.allSettled(pending);
  const text = await response.text();
  return { status: response.status, raw: text, headers: response.headers };
}

// ---------------------------------------------------------------------------
describe('the administrative surface is guarded like every other', () => {
  it('every participant path is inside a protected prefix', () => {
    for (const path of [
      '/api/events/abc/participants',
      '/api/events/abc/participants/summary',
      '/api/events/abc/participants/xyz',
      '/api/events/abc/participants/xyz/disqualify',
      '/api/events/abc/participants/xyz/reinstate',
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it('no traversal reaches it from the public namespace', () => {
    for (const hostile of [
      '/api/public-events/x/../../events/abc/participants',
      '/api/public-events/../events/abc/participants/xyz/disqualify',
      '/api/EVENTS/abc/PARTICIPANTS',
      '/api/%65vents/abc/participants',
    ]) {
      // Normalising toward MORE matches: any of these resolves into the
      // protected tree and is refused before a handler runs.
      expect(isProtectedPath(hostile), hostile).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('logging discloses nothing personal', () => {
  it('never writes a search term, an address, a date of birth or an answer', async () => {
    const { event, version } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    const dob = dobForAge(30);
    await enter(event, version, { email: 'private.person@example.com', date_of_birth: dob });

    await call(
      participantsIndex.onRequestGet as never,
      'GET',
      `/api/events/${event.id}/participants?q=private.person@example.com`,
      { id: event.id },
    );
    await call(
      participantsIndex.onRequestGet as never,
      'GET',
      `/api/events/${event.id}/participants?q=private.person@example.com&status=NONSENSE`,
      { id: event.id },
    );

    const output = lines.join('\n');
    expect(output).not.toContain('private.person@example.com');
    expect(output).not.toContain(dob);
    expect(output).not.toContain('Ana');
  });

  it('never writes a disqualification reason, which is free text', async () => {
    // An operator may well type a person's details into it.
    const { event, version } = await seedPublicEvent(harness);
    const entry = await enter(event, version);

    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 1, reason: 'Duplicate of ana@example.com, born 1990-03-15' },
      actor(),
    );

    // Force the failure path too, which is where a careless log would appear.
    await service.disqualify(
      event.id,
      entry.id,
      { expectedRevision: 99, reason: 'Duplicate of ana@example.com, born 1990-03-15' },
      actor(),
    );

    const output = lines.join('\n');
    expect(output).not.toContain('ana@example.com');
    expect(output).not.toContain('1990-03-15');
  });
});

// ---------------------------------------------------------------------------
describe('errors disclose nothing about the row they refuse', () => {
  it('a cross-event refusal names nobody', async () => {
    const a = await seedPublicEvent(harness, { slug: 'first' });
    const b = await seedPublicEvent(harness, { slug: 'second' });
    const entry = await enter(a.event, a.version, { email: 'ana@example.com' });

    for (const [handler, method, path, params, body] of [
      [
        participantDetail.onRequestGet,
        'GET',
        `/api/events/${b.event.id}/participants/${entry.id}`,
        { id: b.event.id, entryId: entry.id },
        undefined,
      ],
      [
        disqualifyRoute.onRequestPost,
        'POST',
        `/api/events/${b.event.id}/participants/${entry.id}/disqualify`,
        { id: b.event.id, entryId: entry.id },
        { expectedRevision: 1, reason: 'Wrong event entirely' },
      ],
      [
        reinstateRoute.onRequestPost,
        'POST',
        `/api/events/${b.event.id}/participants/${entry.id}/reinstate`,
        { id: b.event.id, entryId: entry.id },
        { expectedRevision: 1 },
      ],
    ] as const) {
      const result = await call(handler as never, method, path, params as never, body);
      // 404, never 403: a 403 confirms it exists somewhere.
      expect(result.status, path).toBe(404);
      expect(result.raw).not.toContain('ana@example.com');
      expect(result.raw).not.toContain(entry.participantId);
    }
  });

  it('a revision conflict names the revision and nothing else', async () => {
    const { event, version } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    const dob = dobForAge(30);
    const entry = await enter(event, version, { date_of_birth: dob });
    // Round-tripped so the entry is live again at revision 3: a stale revision
    // on an ALREADY disqualified entry reports the permission blocker instead,
    // which is the right order — telling somebody "the revision moved" when the
    // real problem is "this is already disqualified" sends them to refetch and
    // try again for nothing.
    await service.disqualify(event.id, entry.id, { expectedRevision: 1, reason: 'First' }, actor());
    await service.reinstate(event.id, entry.id, { expectedRevision: 2 }, actor());

    const result = await call(
      disqualifyRoute.onRequestPost as never,
      'POST',
      `/api/events/${event.id}/participants/${entry.id}/disqualify`,
      { id: event.id, entryId: entry.id },
      { expectedRevision: 1, reason: 'Stale attempt' },
    );

    expect(result.status).toBe(409);
    expect(result.raw).toContain('currentRevision');
    // Not the reason already recorded, not the person it concerns.
    expect(result.raw).not.toContain('First');
    expect(result.raw).not.toContain(dob);
    expect(result.raw).not.toContain('ana@example.com');
  });
});

// ---------------------------------------------------------------------------
describe('nothing is ever deleted', () => {
  it('phase 10 introduced no physical delete of a person or a participation', () => {
    // An entry is the record that somebody took part. Nothing in this phase may
    // unrecord it — disqualification is a disposition, not an erasure.
    const roots = ['functions', 'shared'];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const source = readFileSync(path, 'utf8');
        for (const forbidden of [
          'DELETE FROM participants',
          'DELETE FROM event_entries',
          'DELETE FROM event_entry_answers',
        ]) {
          if (source.includes(forbidden)) offenders.push(`${path}: ${forbidden}`);
        }
      }
    };

    for (const root of roots) walk(join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });

  it('exposes no generic status mutation anywhere on the surface', () => {
    for (const module of [
      participantsIndex,
      participantsSummary,
      participantDetail,
      disqualifyRoute,
      reinstateRoute,
    ]) {
      const handlers = Object.keys(module).filter((key) => key.startsWith('onRequest'));
      for (const handler of handlers) {
        expect(handler).not.toMatch(/Patch|Put|Delete/);
      }
      expect(handlers).not.toContain('onRequest');
    }
  });
});

// ---------------------------------------------------------------------------
describe('one participant across two events', () => {
  it('disqualifying in one leaves the other untouched', async () => {
    const a = await seedPublicEvent(harness, { slug: 'first' });
    const b = await seedPublicEvent(harness, { slug: 'second' });

    // The SAME identity enters both: one participant row, two entries.
    const entryA = await enter(a.event, a.version, { email: 'shared@example.com' });
    const entryB = await enter(b.event, b.version, { email: 'shared@example.com' });
    expect(entryA.participantId).toBe(entryB.participantId);

    const profileBefore = harness.db.raw
      .prepare('SELECT * FROM participants WHERE id = ?')
      .get(entryA.participantId);

    await service.disqualify(
      a.event.id,
      entryA.id,
      { expectedRevision: 1, reason: 'Only in this event' },
      actor(),
    );

    const other = harness.db.raw
      .prepare('SELECT status, revision, disqualified_at FROM event_entries WHERE id = ?')
      .get(entryB.id) as Record<string, unknown>;
    expect(other).toEqual({ status: 'ELIGIBLE', revision: 1, disqualified_at: null });

    // And the shared identity itself is not administrative state.
    expect(
      harness.db.raw.prepare('SELECT * FROM participants WHERE id = ?').get(entryA.participantId),
    ).toEqual(profileBefore);
  });
});

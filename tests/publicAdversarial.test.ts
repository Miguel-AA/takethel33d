// @vitest-environment node
//
// Attacks on phase 9 that go beyond "what status came back": which handler
// actually ran, what was written, and what a future change could break.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { onRequest as middleware } from '../functions/_middleware';
import { onRequestGet } from '../functions/api/public-events/[slug]/index';
import { onRequestPost } from '../functions/api/public-events/[slug]/entries';
import { PROTECTED_ROUTES, isProtectedPath } from '../functions/_shared/routes';
import { setLogSink } from '../functions/_shared/logger';
import { derivePublicEventStatus, toPublicEventDto } from '../shared/publicEvent';
import { entryWindowProblem } from '../shared/entryLifecycle';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import {
  answersFor,
  createHarness,
  dobForAge,
  invokePublic,
  seedPublicEvent,
  DOB_QUESTION,
  type PublicHarness,
} from './helpers/publicFlow';
import type { Event, PublicEventResponse } from '../shared/types';

let harness: PublicHarness;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createHarness();
});

afterEach(() => {
  setLogSink(null);
  harness.close();
});

const uuid = () => crypto.randomUUID();

async function tokenFor(event: Event): Promise<string> {
  const response = await invokePublic(
    harness.db,
    onRequestGet as never,
    'GET',
    `/api/public-events/${event.slug}`,
    { slug: event.slug },
  );
  return ((await response.json()) as PublicEventResponse).event.formToken!;
}

const count = (sql: string) => (harness.db.raw.prepare(sql).get() as { n: number }).n;

// ---------------------------------------------------------------------------
// Which handler actually runs
// ---------------------------------------------------------------------------

describe('routing: the handler that runs, not just the status', () => {
  /** Drives the real middleware and reports whether `next()` was reached. */
  async function classify(path: string) {
    let downstreamReached = false;
    const request = new Request(`https://example.com${path}`);
    const pending: Promise<unknown>[] = [];

    const response = await middleware({
      request,
      env: { DB: harness.db.d1 },
      data: {},
      params: {},
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      next: async () => {
        downstreamReached = true;
        return new Response('downstream', { status: 200 });
      },
    } as never);

    await Promise.allSettled(pending);
    return { status: response.status, downstreamReached };
  }

  it('lets a public path through to its handler', async () => {
    const result = await classify('/api/public-events/summer');
    expect(result.downstreamReached).toBe(true);
    expect(result.status).toBe(200);
  });

  it('stops every administrative path BEFORE any handler runs', async () => {
    // The assertion that matters: not "401 came back" but "no administrative
    // code executed". A guard that returned 401 after the handler had already
    // read the database would still have leaked the work.
    for (const path of [
      '/api/events',
      '/api/events/abc',
      '/api/events/abc/entries',
      '/api/audit',
      '/api/audit/xyz',
      '/api/attendees',
      '/api/metrics',
      '/api/raffle/draw',
      '/api/manager/me',
      '/api/manager/logout',
    ]) {
      const result = await classify(path);
      expect(result.downstreamReached, `${path} reached a handler`).toBe(false);
      expect(result.status, path).toBe(401);
    }
  });

  it('no encoding or traversal moves an admin path into the public namespace', async () => {
    for (const hostile of [
      '//api/events',
      '/api//events',
      '/API/EVENTS',
      '/api/%65vents',
      '/api/%2565vents',
      '/api/public-events/../events',
      '/api/public-events/%2e%2e/events',
      '/api/public-events/%252e%252e/events',
      '/api/public-events/foo/../../events',
      '/api\\events',
      '/api/public-events\\..\\events',
      '/api/./events',
      '/api/events/./../events',
    ]) {
      const result = await classify(hostile);
      expect(result.downstreamReached, `${hostile} reached a handler`).toBe(false);
      expect(result.status, hostile).toBe(401);
    }
  });

  it('the public handler refuses a slug that is not a slug', async () => {
    // Reaching the public handler, a hostile path parameter resolves to nothing
    // rather than to a database round trip with a hostile string.
    for (const slug of ['UPPER', 'has space', '-leading', 'a/b', '%00']) {
      const response = await invokePublic(
        harness.db,
        onRequestGet as never,
        'GET',
        `/api/public-events/${encodeURIComponent(slug)}`,
        { slug },
      );
      expect([400, 404], slug).toContain(response.status);
    }
  });

  it('a traversal-shaped slug is caught by the GUARD, not by the handler', async () => {
    // `..%2Fevents` decodes to `../events`, which normalises the whole path to
    // `/api/events` — protected. The request is refused with 401 before the
    // public handler is entered at all. Normalising toward MORE matches is the
    // safe direction, and this is what it looks like from the outside.
    for (const slug of ['../events', '..%2fevents', 'a/../../events']) {
      const response = await invokePublic(
        harness.db,
        onRequestGet as never,
        'GET',
        `/api/public-events/${encodeURIComponent(slug)}`,
        { slug },
      );
      expect(response.status, slug).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// The deny-list, as a structural invariant
// ---------------------------------------------------------------------------

describe('the deny-list cannot silently miss a future endpoint', () => {
  it('every administrative API directory sits under a protected prefix', () => {
    // THE RISK THE MODEL CARRIES: routes are public unless listed, so an
    // endpoint added tomorrow under an unlisted prefix would be world-readable
    // and nothing would say so. This test walks the actual filesystem, so the
    // day somebody adds `functions/api/reports/`, it fails here rather than in
    // production.
    const apiRoot = join(process.cwd(), 'functions', 'api');

    const namespaces = readdirSync(apiRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // Namespaces that are public BY DESIGN and have been reviewed as such.
    const REVIEWED_PUBLIC = new Set(['public-events']);

    // `manager` is protected per ENDPOINT rather than per namespace, because
    // `login` must be reachable without a session. Its members are asserted
    // individually below.
    const PER_ENDPOINT = new Set(['manager']);

    for (const namespace of namespaces) {
      if (REVIEWED_PUBLIC.has(namespace)) {
        expect(isProtectedPath(`/api/${namespace}`), namespace).toBe(false);
        continue;
      }
      if (PER_ENDPOINT.has(namespace)) continue;
      expect(
        isProtectedPath(`/api/${namespace}`),
        `functions/api/${namespace} is not covered by PROTECTED_ROUTES — add it there or add it to REVIEWED_PUBLIC with a reason`,
      ).toBe(true);
    }
  });

  it('every manager endpoint except login is protected', () => {
    const managerRoot = join(process.cwd(), 'functions', 'api', 'manager');
    const endpoints = readdirSync(managerRoot)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => name.replace(/\.ts$/, ''));

    for (const endpoint of endpoints) {
      const expected = endpoint !== 'login';
      expect(
        isProtectedPath(`/api/manager/${endpoint}`),
        `/api/manager/${endpoint} protection`,
      ).toBe(expected);
    }
    // Login is deliberately reachable: it is how a session is obtained. It has
    // its own rate limiter instead.
    expect(endpoints).toContain('login');
  });

  it('the only unprotected top-level API files are the reviewed legacy ones', () => {
    const apiRoot = join(process.cwd(), 'functions', 'api');
    const files = readdirSync(apiRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name.replace(/\.ts$/, ''));

    // `register` is the legacy public lead-capture intake; `metrics` is guarded.
    const REVIEWED = new Set(['register', 'metrics']);
    for (const file of files) {
      expect(REVIEWED.has(file), `unreviewed top-level endpoint /api/${file}`).toBe(true);
    }
  });

  it('PROTECTED_ROUTES still names every administrative root', () => {
    for (const route of [
      '/api/manager/me',
      '/api/manager/logout',
      '/api/attendees',
      '/api/metrics',
      '/api/raffle',
      '/api/audit',
      '/api/events',
    ]) {
      expect(PROTECTED_ROUTES).toContain(route);
    }
  });
});

// ---------------------------------------------------------------------------
// The projection is an allow-list, provably
// ---------------------------------------------------------------------------

describe('DTO projection', () => {
  it('a new Event column is invisible to the public by default', () => {
    // The guard against somebody "simplifying" the projection into a spread.
    const contaminated = {
      id: 'internal-id',
      slug: 'summer',
      name: 'Summer',
      description: null,
      bannerUrl: null,
      locationName: null,
      timezone: 'UTC',
      registrationOpensAt: null,
      registrationClosesAt: null,
      startsAt: null,
      endsAt: null,
      minimumAge: null,
      maxEntriesPerIdentity: 1,
      status: 'OPEN',
      confirmationTitle: null,
      confirmationMessage: null,
      ineligibleTitle: null,
      ineligibleMessage: null,
      revision: 3,
      createdBy: 'admin-1',
      updatedBy: 'admin-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: null,
      openedAt: null,
      closedAt: null,
      cancelledAt: null,
      archivedAt: null,
      publishedFormVersionId: 'version-1',
      // A column a future phase might add.
      internalRiskScore: 'HIGHLY-SENSITIVE',
      operatorNotes: 'do not disclose',
    } as unknown as Event;

    const dto = toPublicEventDto({
      event: contaminated,
      registrationStatus: 'OPEN',
      form: null,
      prizes: [],
      formToken: null,
    });

    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('HIGHLY-SENSITIVE');
    expect(serialized).not.toContain('do not disclose');
    expect(serialized).not.toContain('internal-id');
    expect(serialized).not.toContain('version-1');
  });
});

// ---------------------------------------------------------------------------
// The page and the guard must never disagree
// ---------------------------------------------------------------------------

describe('GET and POST agree about whether the event is open', () => {
  it('across every status and both window edges', () => {
    // A page that says OPEN while the submission guard says CLOSED invites
    // somebody to fill in a form that cannot be accepted.
    const now = '2026-05-10T12:00:00.000Z';
    const before = '2026-05-01T00:00:00.000Z';
    const after = '2026-05-20T00:00:00.000Z';

    const windows: Array<[string | null, string | null]> = [
      [before, after],
      [after, null],
      [null, before],
      [now, after],
      [before, now],
      [null, null],
    ];

    for (const status of EVENT_STATUSES) {
      for (const [opens, closes] of windows) {
        const event = {
          status,
          registrationOpensAt: opens,
          registrationClosesAt: closes,
        };

        const publicStatus = derivePublicEventStatus(
          { ...event, hasServableForm: true },
          now,
        );
        const guard = entryWindowProblem(event, now);

        // OPEN in the projection must mean the guard admits, and vice versa.
        expect(
          publicStatus === 'OPEN',
          `${status} ${opens}..${closes}: page=${publicStatus} guard=${guard}`,
        ).toBe(guard === null);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A corrupt published version must never be served in pieces
// ---------------------------------------------------------------------------

describe('VERSION corruption', () => {
  async function get(slug: string) {
    return invokePublic(
      harness.db,
      onRequestGet as never,
      'GET',
      `/api/public-events/${slug}`,
      { slug },
    );
  }

  /**
   * TWO SHAPES OF REFUSAL, and the difference is deliberate.
   *
   * A pointer that names nothing, names another event's version, or names one
   * with no questions left is a corruption we can still render a coherent PAGE
   * around: the event's name and prizes are intact, so the visitor gets 200 with
   * `registrationStatus: 'UNAVAILABLE'`, no form and no token. That is the same
   * answer the DTO gives for any other non-open state, and it tells them the
   * truth — "not open right now" — without inventing "you are too late".
   *
   * A failure to build the page at all (no signing key, a projection that
   * cannot be assembled) is 503 PUBLIC_EVENT_UNAVAILABLE.
   *
   * Neither discloses the cause, and neither ever serves a partial form. What
   * every case below asserts is the security-relevant invariant: no form, no
   * token, no hint of what broke.
   */
  async function expectUnservable(slug: string, forbidden: string[] = []) {
    const response = await get(slug);
    const raw = await response.text();

    if (response.status === 200) {
      const payload = JSON.parse(raw) as PublicEventResponse;
      expect(payload.event.registrationStatus).toBe('UNAVAILABLE');
      expect(payload.event.form).toBeNull();
      expect(payload.event.formToken).toBeNull();
    } else {
      expect(response.status).toBe(503);
      expect(raw).toContain('PUBLIC_EVENT_UNAVAILABLE');
    }

    for (const secret of forbidden) expect(raw).not.toContain(secret);
    return response.status;
  }

  it('never serves a form when the pointer names nothing', async () => {
    const { event } = await seedPublicEvent(harness);
    // Foreign keys are enforced in the harness, so the corruption is written
    // with them off — as a stray console session or a bad migration would.
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw
      .prepare("UPDATE events SET published_form_version_id = 'ghost' WHERE id = ?")
      .run(event.id);
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    await expectUnservable(event.slug, ['ghost']);
  });

  it('never serves ANOTHER event’s version', async () => {
    // The single most damaging thing this table could get wrong: people being
    // shown, and answering, a form belonging to somebody else's event.
    const a = await seedPublicEvent(harness, { slug: 'first' });
    const b = await seedPublicEvent(harness, { slug: 'second' });

    harness.db.raw
      .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
      .run(b.version.id, a.event.id);

    await expectUnservable(a.event.slug, [b.version.id]);
  });

  it('never serves a version that has lost its questions', async () => {
    const { event, version } = await seedPublicEvent(harness);
    harness.db.raw
      .prepare("DELETE FROM form_questions WHERE form_owner_type = 'VERSION' AND form_owner_id = ?")
      .run(version.id);

    await expectUnservable(event.slug, [version.id]);
  });

  it('never serves a step whose questions are all inactive', async () => {
    const { event, version } = await seedPublicEvent(harness);
    harness.db.raw
      .prepare("UPDATE form_questions SET active = 0 WHERE form_owner_type = 'VERSION' AND form_owner_id = ?")
      .run(version.id);

    await expectUnservable(event.slug, [version.id]);
  });

  it('never falls back to another version when the token’s one is gone', async () => {
    // Failing closed matters more than failing gracefully: silently validating
    // against a different form is the exact harm the token prevents.
    const { event, version } = await seedPublicEvent(harness);
    const token = await tokenFor(event);

    harness.db.raw
      .prepare('UPDATE event_entries SET form_version_id = form_version_id')
      .run();
    harness.db.raw.prepare('UPDATE events SET published_form_version_id = NULL WHERE id = ?').run(event.id);
    harness.db.raw.prepare('DELETE FROM form_questions WHERE form_owner_id = ?').run(version.id);
    harness.db.raw.prepare('DELETE FROM form_steps WHERE form_owner_id = ?').run(version.id);
    harness.db.raw.prepare('DELETE FROM event_form_versions WHERE id = ?').run(version.id);

    const response = await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      { body: { formToken: token, submissionId: uuid(), answers: [] } },
    );

    expect(response.status).toBe(503);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exactly what is written, once
// ---------------------------------------------------------------------------

describe('what one public submission writes', () => {
  it('writes exactly two audit rows, both attributed to no administrator', async () => {
    // PARTICIPANT_CREATED and EVENT_ENTRY_CREATED: what happened to the
    // IDENTITY and what happened to the EVENT are two different facts about two
    // different entities.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });

    await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      {
        body: {
          formToken: await tokenFor(event),
          submissionId: uuid(),
          answers: answersFor(version, { date_of_birth: dobForAge(30) }),
        },
      },
    );

    // Filtered to the submission's own actions: seeding the event, the form and
    // the publication legitimately wrote their own administrative rows.
    const rows = harness.db.raw
      .prepare(
        `SELECT action, actor_admin_id FROM audit_logs
          WHERE action IN ('PARTICIPANT_CREATED', 'PARTICIPANT_UPDATED', 'EVENT_ENTRY_CREATED')
          ORDER BY action`,
      )
      .all() as Array<{ action: string; actor_admin_id: string | null }>;

    expect(rows.map((row) => row.action)).toEqual([
      'EVENT_ENTRY_CREATED',
      'PARTICIPANT_CREATED',
    ]);
    for (const row of rows) expect(row.actor_admin_id).toBeNull();
  });

  it('writes nothing at all when the submission is refused', async () => {
    const { event, version } = await seedPublicEvent(harness);
    await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      {
        body: {
          formToken: 'v1.bogus.bogus',
          submissionId: uuid(),
          answers: answersFor(version),
        },
      },
    );

    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
    expect(
      count(
        `SELECT COUNT(*) AS n FROM audit_logs
          WHERE action IN ('PARTICIPANT_CREATED', 'PARTICIPANT_UPDATED', 'EVENT_ENTRY_CREATED')`,
      ),
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The identity gate must not disagree with the pipeline it guards
// ---------------------------------------------------------------------------

describe('identityGate', () => {
  it('sees the same normalized address the participant row is keyed by', async () => {
    // If the gate hashed a differently-normalized string, two spellings of one
    // address would consume different buckets while resolving to one identity —
    // and the rate limit would be trivially side-stepped by changing case.
    const { event, version } = await seedPublicEvent(harness);

    await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      {
        body: {
          formToken: await tokenFor(event),
          submissionId: uuid(),
          answers: answersFor(version, { email: '  Ana@EXAMPLE.com ' }),
        },
      },
    );

    const participant = harness.db.raw
      .prepare('SELECT normalized_email FROM participants LIMIT 1')
      .get() as { normalized_email: string };
    expect(participant.normalized_email).toBe('ana@example.com');
  });

  it('creates nothing when it refuses', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const answers = answersFor(version, { email: 'gated@example.com' });

    // Burn the composite bucket from this address.
    for (let i = 0; i < 6; i++) {
      await invokePublic(
        harness.db,
        onRequestPost as never,
        'POST',
        `/api/public-events/${event.slug}/entries`,
        { slug: event.slug },
        { body: { formToken: await tokenFor(event), submissionId: uuid(), answers } },
      );
    }

    // At most one entry exists — the first attempt. Every later refusal, from
    // the gate or from the duplicate index, wrote nothing.
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBeLessThanOrEqual(1);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// A legitimate retry must not be punished as abuse
// ---------------------------------------------------------------------------

describe('idempotent retry against the rate limiter', () => {
  it('a replay does not consume the identity buckets', async () => {
    // The replay returns before the gate is ever called, so retrying after a
    // dropped response cannot burn the allowance that protects the address.
    const { event, version } = await seedPublicEvent(harness);
    const submissionId = uuid();
    const answers = answersFor(version, { email: 'retry@example.com' });

    for (let i = 0; i < 3; i++) {
      await invokePublic(
        harness.db,
        onRequestPost as never,
        'POST',
        `/api/public-events/${event.slug}/entries`,
        { slug: event.slug },
        { body: { formToken: await tokenFor(event), submissionId, answers } },
      );
    }

    const identityBuckets = count(
      "SELECT COUNT(*) AS n FROM admin_login_attempts WHERE bucket_key LIKE 'pub_entry_ip_email:%'",
    );
    // One, from the first genuine attempt.
    expect(identityBuckets).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Admin sessions in every state must not change a public response
// ---------------------------------------------------------------------------

describe('public GET ignores administrative state entirely', () => {
  it('is identical with no cookie, a malformed cookie and a bogus session', async () => {
    const { event } = await seedPublicEvent(harness);
    const strip = (raw: string) =>
      raw.replace(/"formToken":"[^"]*"/, '"formToken":"<t>"');

    const bodies: string[] = [];
    for (const cookie of [
      undefined,
      '__Host-session=not-a-real-token',
      '__Host-session=',
      'session=%%%malformed%%%',
    ]) {
      const response = await invokePublic(
        harness.db,
        onRequestGet as never,
        'GET',
        `/api/public-events/${event.slug}`,
        { slug: event.slug },
        cookie === undefined ? {} : { cookie },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Set-Cookie')).toBeNull();
      bodies.push(strip(await response.text()));
    }

    expect(new Set(bodies).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Nothing secret reaches a shipped artefact
// ---------------------------------------------------------------------------

describe('source hygiene', () => {
  it('no fixture secret or weak hash appears in shipped source', () => {
    // The mock is dynamically imported behind a constant the bundler folds, so
    // it is eliminated from a production build — but a fixture secret leaking
    // into `src/` or `functions/` would ship regardless.
    const roots = ['src', 'functions', 'shared'];
    const offenders: string[] = [];

    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const source = readFileSync(path, 'utf8');
        for (const marker of [
          'test-only-public-form-token-secret',
          'pbkdf2-sha256$1$',
          'A@x.com',
          'dev-fallback-secret',
        ]) {
          if (source.includes(marker)) offenders.push(`${path}: ${marker}`);
        }
      }
    };

    for (const root of roots) walk(join(process.cwd(), root));
    expect(offenders).toEqual([]);
  });

  it('.dev.vars is ignored and carries no committed secret', () => {
    const ignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');
    expect(ignore).toContain('.dev.vars');

    const example = readFileSync(join(process.cwd(), '.dev.vars.example'), 'utf8');
    // The NAME of the binding is documentation a developer needs; a value would
    // be a committed secret.
    expect(example).toContain('PUBLIC_FORM_TOKEN_SECRET');
    expect(example).not.toMatch(/PUBLIC_FORM_TOKEN_SECRET\s*=\s*"?\S+/);
  });
});

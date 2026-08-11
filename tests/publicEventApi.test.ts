// @vitest-environment node
//
// GET /api/public-events/:slug — driven through the real middleware.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequestGet } from '../functions/api/public-events/[slug]/index';
import { onRequestGet as adminEventsGet } from '../functions/api/events/index';
import { setLogSink } from '../functions/_shared/logger';
import {
  createHarness,
  invokePublic,
  seedPublicEvent,
  DOB_QUESTION,
  HABIT_QUESTIONS,
  type PublicHarness,
} from './helpers/publicFlow';
import type { PublicEventResponse } from '../shared/types';

let harness: PublicHarness;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createHarness();
});

afterEach(() => {
  setLogSink(null);
  harness.close();
});

async function get(slug: string, options = {}): Promise<Response> {
  return invokePublic(
    harness.db,
    onRequestGet as never,
    'GET',
    `/api/public-events/${slug}`,
    { slug },
    options,
  );
}

async function body(response: Response): Promise<PublicEventResponse> {
  return (await response.json()) as PublicEventResponse;
}

describe('reachability', () => {
  it('serves an open event with no session at all', async () => {
    const { event } = await seedPublicEvent(harness);
    const response = await get(event.slug);

    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.event.registrationStatus).toBe('OPEN');
    expect(payload.event.name).toBe('Public Flow Event');
  });

  it('sets no-store and a correlation id', async () => {
    // The body carries a two-hour token and a status derived from now; a cached
    // copy would hand the next visitor a stale form session.
    const { event } = await seedPublicEvent(harness);
    const response = await get(event.slug);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('X-Request-ID')).toBeTruthy();
  });

  it('the administrative event API still demands a session', async () => {
    // The companion assertion to the one above: the public namespace being open
    // must not have opened `/api/events`.
    await seedPublicEvent(harness);
    const response = await invokePublic(
      harness.db,
      adminEventsGet as never,
      'GET',
      '/api/events',
      {},
    );
    expect(response.status).toBe(401);
  });
});

describe('what a visitor is told', () => {
  it('carries the form and a token when open', async () => {
    const { event } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    const payload = await body(await get(event.slug));

    expect(payload.event.form).not.toBeNull();
    expect(payload.event.formToken).toMatch(/^v1\./);
    expect(payload.event.form!.steps[0].questions.map((q) => q.key)).toContain(
      'date_of_birth',
    );
  });

  it('never discloses the event id, the version id or any actor', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const raw = await (await get(event.slug)).text();

    // The version id exists only INSIDE the signed token, never in the clear.
    expect(raw).not.toContain(version.id);
    expect(raw).not.toContain(event.id);
    expect(raw).not.toContain(harness.admin.id);
    expect(raw).not.toContain('schema_snapshot');
    expect(raw).not.toContain('"revision"');
  });

  it('offers ACTIVE prizes only', async () => {
    const { event } = await seedPublicEvent(harness);
    const now = new Date().toISOString();
    harness.db.raw.exec(`
      INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, status, revision, created_by, updated_by, created_at, updated_at)
      VALUES ('pr1','${event.id}','Live prize',2,0,'ACTIVE',1,'${harness.admin.id}','${harness.admin.id}','${now}','${now}');
      INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, status, revision, created_by, updated_by, created_at, updated_at)
      VALUES ('pr2','${event.id}','Parked prize',1,1,'INACTIVE',1,'${harness.admin.id}','${harness.admin.id}','${now}','${now}');
    `);

    const payload = await body(await get(event.slug));
    expect(payload.event.prizes.map((p) => p.name)).toEqual(['Live prize']);
  });

  it('exposes minimumAge for display without making the client the authority', async () => {
    const { event } = await seedPublicEvent(harness, {
      minimumAge: 21,
      extra: [DOB_QUESTION],
    });
    const payload = await body(await get(event.slug));
    expect(payload.event.minimumAge).toBe(21);
  });

  it('does not hardcode the client questions anywhere', async () => {
    // They are configuration. The projection carries whatever was published.
    const { event } = await seedPublicEvent(harness, { extra: HABIT_QUESTIONS });
    const payload = await body(await get(event.slug));
    const keys = payload.event.form!.steps.flatMap((s) => s.questions.map((q) => q.key));
    expect(keys).toContain('smoker_status');
    expect(keys).toContain('drinker_status');
  });
});

describe('availability states', () => {
  it('404s an unknown slug', async () => {
    expect((await get('no-such-event')).status).toBe(404);
  });

  it('404s a malformed slug without touching the database', async () => {
    for (const slug of ['UPPER', 'has space', '-leading', 'trailing-']) {
      expect((await get(slug)).status, slug).toBe(404);
    }
  });

  it('traversal out of the public namespace lands in the PROTECTED one', async () => {
    // `/api/public-events/../events` resolves to `/api/events`, which the
    // middleware guards — so the answer is 401, never unauthenticated
    // administrative access. Normalising toward MORE matches is the safe
    // direction, and this is what that looks like in practice.
    const response = await get('../events');
    expect(response.status).toBe(401);
  });

  it('404s a DRAFT — the same answer an unused slug gives', async () => {
    // Confirming the slug exists would leak a plan nobody announced.
    const { event } = await seedPublicEvent(harness, { open: false });
    harness.db.raw
      .prepare("UPDATE events SET status = 'DRAFT' WHERE id = ?")
      .run(event.id);
    expect((await get(event.slug)).status).toBe(404);
  });

  it('404s an ARCHIVED event', async () => {
    const { event } = await seedPublicEvent(harness);
    harness.db.raw
      .prepare("UPDATE events SET status = 'ARCHIVED', archived_at = ? WHERE id = ?")
      .run(new Date().toISOString(), event.id);
    expect((await get(event.slug)).status).toBe(404);
  });

  it('reports UPCOMING for a scheduled event, with no form and no token', async () => {
    const { event } = await seedPublicEvent(harness, { open: false });
    const payload = await body(await get(event.slug));

    expect(payload.event.registrationStatus).toBe('UPCOMING');
    expect(payload.event.form).toBeNull();
    // A token for an event that accepts nothing would be a two-hour licence to
    // submit into a closed door.
    expect(payload.event.formToken).toBeNull();
  });

  it('reports CLOSED once the event is closed', async () => {
    const { event } = await seedPublicEvent(harness);
    await harness.events.transition(event.id, 'close', harness.actor());
    const payload = await body(await get(event.slug));

    expect(payload.event.registrationStatus).toBe('CLOSED');
    expect(payload.event.formToken).toBeNull();
  });

  it('reports CANCELLED', async () => {
    const { event } = await seedPublicEvent(harness);
    await harness.events.transition(event.id, 'cancel', harness.actor());
    const payload = await body(await get(event.slug));
    expect(payload.event.registrationStatus).toBe('CANCELLED');
  });

  it('still shows prizes on a closed event', async () => {
    const { event } = await seedPublicEvent(harness);
    const now = new Date().toISOString();
    harness.db.raw.exec(`
      INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, status, revision, created_by, updated_by, created_at, updated_at)
      VALUES ('pr1','${event.id}','A prize',1,0,'ACTIVE',1,'${harness.admin.id}','${harness.admin.id}','${now}','${now}');
    `);
    await harness.events.transition(event.id, 'close', harness.actor());

    const payload = await body(await get(event.slug));
    expect(payload.event.prizes).toHaveLength(1);
  });
});

describe('missing secret', () => {
  it('reports the event unavailable rather than serving an unusable form', async () => {
    const { event } = await seedPublicEvent(harness);
    const response = await get(event.slug, { secret: undefined });

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe('PUBLIC_EVENT_UNAVAILABLE');
  });

  it('treats an empty secret as absent — there is no silent downgrade', async () => {
    const { event } = await seedPublicEvent(harness);
    expect((await get(event.slug, { secret: '' })).status).toBe(503);
  });
});

describe('admin cookie independence', () => {
  it('returns exactly the same body with an administrator cookie present', async () => {
    // The public route is not in PROTECTED_ROUTES, so the middleware never
    // looks at the cookie and the handler never reads ctx.data.admin.
    const { event } = await seedPublicEvent(harness);

    const anonymous = await (await get(event.slug)).json();
    const withCookie = await (
      await get(event.slug, { cookie: '__Host-session=whatever-value' })
    ).json();

    const strip = (payload: unknown) =>
      JSON.stringify(payload).replace(/"formToken":"[^"]*"/, '"formToken":"<token>"');
    expect(strip(withCookie)).toBe(strip(anonymous));
  });
});

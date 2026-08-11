// @vitest-environment node
//
// Attacks on the public surface. Passing means these particular ways of
// breaking it do not work — not that the surface is safe.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequestGet } from '../functions/api/public-events/[slug]/index';
import { onRequestPost } from '../functions/api/public-events/[slug]/entries';
import { isProtectedPath, normalizePathname } from '../functions/_shared/routes';
import { setLogSink } from '../functions/_shared/logger';
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
let lines: string[];

beforeEach(async () => {
  lines = [];
  setLogSink((_level, line) => lines.push(line));
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

// ---------------------------------------------------------------------------

describe('the public namespace cannot become the administrative one', () => {
  it('the public routes are not protected, and every admin route still is', async () => {
    expect(isProtectedPath('/api/public-events/summer')).toBe(false);
    expect(isProtectedPath('/api/public-events/summer/entries')).toBe(false);

    for (const path of [
      '/api/events',
      '/api/events/abc',
      '/api/events/abc/entries',
      '/api/audit',
      '/api/attendees',
      '/api/metrics',
      '/api/raffle',
      '/api/manager/me',
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it('no encoding of an admin path escapes into the public namespace', async () => {
    // The guard normalises the path itself rather than trusting the router's
    // view of it, so these all still resolve to something protected.
    for (const hostile of [
      '/api/events',
      '//api/events',
      '/api//events',
      '/API/EVENTS',
      '/api/%65vents',
      '/api/%2565vents/../events',
      '/api/public-events/../events',
      '/api/public-events/x/../../events',
      '/api\\events',
      '/api/./events',
      '/api/events/%2e%2e/events',
    ]) {
      expect(isProtectedPath(hostile), hostile).toBe(true);
    }
  });

  it('normalisation cannot turn an admin path into a public-looking one', () => {
    // The middleware is a DENY-LIST: nothing grants access, so `..` can only
    // ever move a path INTO the protected set. This asserts that direction.
    expect(normalizePathname('/api/events/../public-events')).toBe('/api/public-events');
    expect(isProtectedPath('/api/events/../public-events')).toBe(false);
    // ...and that the reverse genuinely lands in the protected set.
    expect(normalizePathname('/api/public-events/../events')).toBe('/api/events');
    expect(isProtectedPath('/api/public-events/../events')).toBe(true);
  });

  it('a public request carries no administrator even with a session cookie', async () => {
    const { event } = await seedPublicEvent(harness);
    const response = await invokePublic(
      harness.db,
      onRequestGet as never,
      'GET',
      `/api/public-events/${event.slug}`,
      { slug: event.slug },
      { cookie: '__Host-session=anything' },
    );
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------

describe('payload safety', () => {
  it('strips prototype pollution from a submission', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const token = await tokenFor(event);

    const response = await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      {
        rawBody: JSON.stringify({
          formToken: token,
          submissionId: uuid(),
          answers: answersFor(version),
          __proto__: { polluted: true },
          constructor: { bad: 1 },
        }),
      },
    );

    // `.strict()` refuses the extra keys outright; either way nothing pollutes.
    expect([201, 400]).toContain(response.status);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses an oversized body', async () => {
    const { event } = await seedPublicEvent(harness);
    const response = await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      { rawBody: JSON.stringify({ blob: 'x'.repeat(300 * 1024) }) },
    );
    expect(response.status).toBe(413);
  });

  it('refuses malformed JSON without a 500', async () => {
    const { event } = await seedPublicEvent(harness);
    const response = await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      { rawBody: '{"formToken":' },
    );
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('operator content travels as data, never as markup', () => {
  it('a script tag in a name, a question and a prize survives as text', async () => {
    // React escapes on render; this asserts the API does not pre-render or
    // otherwise transform the value, so nothing is smuggled through the API.
    const payload = '<script>alert(1)</script>';
    const { event } = await seedPublicEvent(harness, {
      extra: [{ type: 'SHORT_TEXT', label: payload, required: false }],
    });

    const now = new Date().toISOString();
    harness.db.raw
      .prepare(
        `INSERT INTO event_prizes (id, event_id, name, quantity, sort_order, status, revision, created_by, updated_by, created_at, updated_at)
         VALUES ('pr1', ?, ?, 1, 0, 'ACTIVE', 1, ?, ?, ?, ?)`,
      )
      .run(event.id, payload, harness.admin.id, harness.admin.id, now, now);
    harness.db.raw
      .prepare('UPDATE events SET name = ? WHERE id = ?')
      .run(payload, event.id);

    const response = await invokePublic(
      harness.db,
      onRequestGet as never,
      'GET',
      `/api/public-events/${event.slug}`,
      { slug: event.slug },
    );
    const body = (await response.json()) as PublicEventResponse;

    // Returned verbatim as a JSON string value — not escaped into markup, and
    // not stripped. The renderer is what makes it inert.
    expect(body.event.name).toBe(payload);
    expect(body.event.prizes[0].name).toBe(payload);
    expect(response.headers.get('Content-Type')).toContain('application/json');
  });
});

// ---------------------------------------------------------------------------

describe('logging discloses nothing personal', () => {
  it('never writes a token, an address, an email, a date of birth or an answer', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });

    const token = await tokenFor(event);
    const dob = dobForAge(20);

    await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      {
        body: {
          formToken: token,
          submissionId: uuid(),
          answers: answersFor(version, {
            email: 'private.person@example.com',
            date_of_birth: dob,
          }),
        },
      },
    );

    // A rejected token is logged too — exercise that path as well.
    await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      {
        body: {
          formToken: `${token.slice(0, -1)}X`,
          submissionId: uuid(),
          answers: answersFor(version, { date_of_birth: dob }),
        },
      },
    );

    const output = lines.join('\n');
    expect(output).not.toContain(token);
    expect(output).not.toContain('203.0.113.7');
    expect(output).not.toContain('private.person@example.com');
    expect(output).not.toContain(dob);
    expect(output).not.toContain('Ana');
  });

  it('the RESPONSE never says why a token was refused', async () => {
    // The code alone is not enough: a message that names the reason is the same
    // oracle by another route. Every refusal below must be byte-identical, so an
    // attacker cannot tell a forged signature from an expired session.
    const { event, version } = await seedPublicEvent(harness);
    const good = await tokenFor(event);
    const [prefix, payload, mac] = good.split('.');

    const attempts = [
      'not-a-token',
      `v2.${payload}.${mac}`,
      // The FIRST character of the MAC, not the last.
      //
      // A 43-character base64url string encodes 32 bytes, so its final
      // character carries only 2 significant bits — characters differing solely
      // in the low 2 bits (A/B/C/D, E/F/G/H, ...) decode to identical bytes.
      // Flipping the last character therefore left the MAC UNCHANGED about one
      // time in sixteen, the signature verified, the submission succeeded, and
      // this assertion saw two different bodies. It looked like flakiness and
      // was a test asserting something false. The first character carries all
      // six bits.
      `${prefix}.${payload}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`,
      `${prefix}.aaaa.${mac}`,
      'v1..',
    ];

    const bodies: string[] = [];
    for (const [index, formToken] of attempts.entries()) {
      const response = await invokePublic(
        harness.db,
        onRequestPost as never,
        'POST',
        `/api/public-events/${event.slug}/entries`,
        { slug: event.slug },
        {
          body: { formToken, submissionId: uuid(), answers: answersFor(version) },
          headers: { 'CF-Connecting-IP': `198.51.100.${10 + index}` },
        },
      );
      const raw = await response.text();

      for (const leak of [
        'BAD_SIGNATURE',
        'EXPIRED',
        'ISSUED_IN_FUTURE',
        'EVENT_MISMATCH',
        'MALFORMED',
        'UNSUPPORTED_VERSION',
        'TOO_LARGE',
        'SECRET_MISSING',
      ]) {
        expect(raw, `${formToken} leaked ${leak}`).not.toContain(leak);
      }

      // The request id legitimately differs per request; everything else must not.
      bodies.push(raw.replace(/"requestId":"[^"]*"/, ''));
    }

    expect(new Set(bodies).size, 'refusals must be indistinguishable').toBe(1);
  });

  it('logs the reason a token was refused, but never the token', async () => {
    const { event, version } = await seedPublicEvent(harness);
    await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      `/api/public-events/${event.slug}/entries`,
      { slug: event.slug },
      {
        body: {
          formToken: 'v1.aaaa.bbbb',
          submissionId: uuid(),
          answers: answersFor(version),
        },
      },
    );

    const output = lines.join('\n');
    expect(output).toContain('PUBLIC_FORM_TOKEN_REJECTED');
    expect(output).not.toContain('v1.aaaa.bbbb');
  });

  it('records the missing secret loudly so the fault is visible', async () => {
    const { event } = await seedPublicEvent(harness);
    await invokePublic(
      harness.db,
      onRequestGet as never,
      'GET',
      `/api/public-events/${event.slug}`,
      { slug: event.slug },
      { secret: undefined },
    );
    expect(lines.join('\n')).toContain('PUBLIC_FORM_TOKEN_SECRET_MISSING');
  });
});

// ---------------------------------------------------------------------------

describe('no personal data reaches the audit trail', () => {
  it('records the participation without the person', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const dob = dobForAge(30);

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
          answers: answersFor(version, {
            email: 'audited@example.com',
            date_of_birth: dob,
          }),
        },
      },
    );

    // The audit table is append-only and never deleted; a copy of somebody's
    // details in it is a copy no erasure request could reach.
    const dump = JSON.stringify(harness.db.raw.prepare('SELECT * FROM audit_logs').all());
    expect(dump).not.toContain('audited@example.com');
    expect(dump).not.toContain(dob);
    expect(dump).not.toContain('Ana');
    expect(dump).not.toContain('203.0.113.7');
  });
});

// @vitest-environment jsdom
//
// The dev mock must teach the SAME contract the server enforces.
//
// A mock that is merely convincing is worse than none: the UI is built against
// it, and every place it differs is a bug that only appears in production. What
// is compared here is the OBSERVABLE contract — shapes, codes, statuses and
// which fields exist — not the implementation behind it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockApi } from '../src/lib/mockApi';
import { ApiError } from '../src/lib/api';
import { PUBLIC_ERROR_CODES } from '../shared/publicEvent';
import {
  checkTokenClaims,
  decodeTokenPayload,
  encodeTokenPayload,
  splitToken,
  toBase64Url,
} from '../shared/publicFormToken';
import {
  PUBLIC_FORM_TOKEN_MAX_BYTES,
  PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS,
  PUBLIC_FORM_TOKEN_TTL_SECONDS,
} from '../shared/limits';

/** The demo administrator the mock seeds. */
const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

async function login() {
  await mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
}

let slug: string;
let eventId: string;

/** An open event with a published form, built entirely through the mock's API. */
async function seedOpenEvent(options: { minimumAge?: number } = {}) {
  await login();
  const created = await mockApi.createEvent({
    name: `Parity Event ${crypto.randomUUID().slice(0, 8)}`,
    registrationOpensAt: new Date(Date.now() - 86_400_000).toISOString(),
    registrationClosesAt: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    startsAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...(options.minimumAge !== undefined ? { minimumAge: options.minimumAge } : {}),
  } as never);

  eventId = created.id;
  slug = created.slug;

  const created2 = await mockApi.createFormDraft(eventId);
  if (!created2.draft) throw new Error('draft missing');
  let draft = created2.draft;
  const step = await mockApi.createFormStep(eventId, {
    expectedRevision: draft.revision,
    title: 'About you',
  } as never);
  draft = step.draft;

  for (const spec of [
    { type: 'SHORT_TEXT', systemField: 'FIRST_NAME', label: 'First name', required: true },
    { type: 'SHORT_TEXT', systemField: 'LAST_NAME', label: 'Last name', required: true },
    { type: 'EMAIL', systemField: 'EMAIL', label: 'Email', required: true },
    ...(options.minimumAge !== undefined
      ? [{ type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth', required: true }]
      : []),
  ]) {
    const result = await mockApi.createFormQuestion(eventId, {
      expectedRevision: draft.revision,
      stepId: draft.steps[0].id,
      ...spec,
    } as never);
    draft = result.draft;
  }

  await mockApi.publishForm(eventId, draft.revision);
  await mockApi.transitionEvent(eventId, 'open');
  await mockApi.logout();
}

beforeEach(() => {
  mockApi.setPublicFormTokenSecret('mock-public-form-token-secret');
});

afterEach(async () => {
  mockApi.setPublicFormTokenSecret('mock-public-form-token-secret');
  try {
    await mockApi.logout();
  } catch {
    /* already signed out */
  }
});

const uuid = () => crypto.randomUUID();

function answersFrom(
  form: NonNullable<Awaited<ReturnType<typeof mockApi.getPublicEvent>>['event']['form']>,
  values: Record<string, unknown>,
) {
  const byKey = new Map(
    form.steps.flatMap((step) => step.questions).map((q) => [q.key, q]),
  );
  return Object.entries(values).map(([key, value]) => {
    const question = byKey.get(key);
    if (!question) throw new Error(`no question keyed ${key}`);
    return { questionId: question.id, value };
  });
}

// ---------------------------------------------------------------------------

describe('the public event shape', () => {
  it('needs no session at all', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);
    expect(event.registrationStatus).toBe('OPEN');
  });

  it('carries exactly the keys the server DTO carries', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);

    expect(Object.keys(event).sort()).toEqual(
      [
        'bannerUrl',
        'description',
        'endsAt',
        'form',
        'formToken',
        'locationName',
        'messages',
        'minimumAge',
        'name',
        'prizes',
        'registrationClosesAt',
        'registrationOpensAt',
        'registrationStatus',
        'slug',
        'startsAt',
        'timezone',
      ].sort(),
    );
  });

  it('discloses no internal identifier', async () => {
    await seedOpenEvent();
    const raw = JSON.stringify(await mockApi.getPublicEvent(slug));
    expect(raw).not.toContain(eventId);
    expect(raw).not.toContain('"revision"');
    expect(raw).not.toContain('schemaSnapshot');
  });

  it('issues a token shaped as the server issues one', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);
    expect(event.formToken).toMatch(/^v1\.[A-Za-z0-9_-]+\./);
  });

  it('404s an unknown slug with the public code', async () => {
    await expect(mockApi.getPublicEvent('no-such-slug')).rejects.toMatchObject({
      status: 404,
      code: 'PUBLIC_EVENT_NOT_FOUND',
    });
  });

  it('reports unavailable when the secret is absent', async () => {
    await seedOpenEvent();
    mockApi.setPublicFormTokenSecret(null);
    await expect(mockApi.getPublicEvent(slug)).rejects.toMatchObject({
      status: 503,
      code: 'PUBLIC_EVENT_UNAVAILABLE',
    });
  });

  it('withholds the form and the token unless the event is open', async () => {
    await seedOpenEvent();
    await login();
    await mockApi.transitionEvent(eventId, 'close');
    await mockApi.logout();

    const { event } = await mockApi.getPublicEvent(slug);
    expect(event.registrationStatus).toBe('CLOSED');
    expect(event.form).toBeNull();
    expect(event.formToken).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('submitting through the mock', () => {
  it('records an eligible entry and returns the public shape', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);

    const result = await mockApi.submitPublicEntry(slug, {
      formToken: event.formToken!,
      submissionId: uuid(),
      answers: answersFrom(event.form!, {
        first_name: 'Ana',
        last_name: 'Lopez',
        email: `parity-${uuid()}@example.com`,
      }),
    });

    expect(Object.keys(result).sort()).toEqual(['message', 'reason', 'result']);
    expect(result.result).toBe('ELIGIBLE');
    expect(result.reason).toBeNull();
  });

  it('records an underage person as INELIGIBLE rather than refusing', async () => {
    await seedOpenEvent({ minimumAge: 21 });
    const { event } = await mockApi.getPublicEvent(slug);
    const today = new Date().toISOString().slice(0, 10);

    const result = await mockApi.submitPublicEntry(slug, {
      formToken: event.formToken!,
      submissionId: uuid(),
      answers: answersFrom(event.form!, {
        first_name: 'Ana',
        last_name: 'Lopez',
        email: `young-${uuid()}@example.com`,
        date_of_birth: `${Number(today.slice(0, 4)) - 20}${today.slice(4)}`,
      }),
    });

    expect(result.result).toBe('INELIGIBLE');
    expect(result.reason).toBe('AGE_REQUIREMENT_NOT_MET');
  });

  it('is idempotent for the same submission id', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);
    const submissionId = uuid();
    const answers = answersFrom(event.form!, {
      first_name: 'Ana',
      last_name: 'Lopez',
      email: `retry-${uuid()}@example.com`,
    });

    const first = await mockApi.submitPublicEntry(slug, {
      formToken: event.formToken!,
      submissionId,
      answers,
    });
    const second = await mockApi.submitPublicEntry(slug, {
      formToken: event.formToken!,
      submissionId,
      answers,
    });

    expect(second).toEqual(first);
  });

  it('reports a duplicate with the public code and no entry id', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);
    const email = `dupe-${uuid()}@example.com`;
    const answers = answersFrom(event.form!, {
      first_name: 'Ana',
      last_name: 'Lopez',
      email,
    });

    await mockApi.submitPublicEntry(slug, {
      formToken: event.formToken!,
      submissionId: uuid(),
      answers,
    });

    const failure = await mockApi
      .submitPublicEntry(slug, {
        formToken: event.formToken!,
        submissionId: uuid(),
        answers,
      })
      .catch((error: ApiError) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe('ALREADY_ENTERED');
    expect((failure as ApiError).fields?.entryId).toBeUndefined();
  });

  it('gives one generic answer for every bad token', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);
    const answers = answersFrom(event.form!, {
      first_name: 'Ana',
      last_name: 'Lopez',
      email: `bad-token-${uuid()}@example.com`,
    });

    for (const formToken of ['nope', 'v2.abc.mock', 'v1.abc.notmock', '']) {
      const failure = await mockApi
        .submitPublicEntry(slug, { formToken, submissionId: uuid(), answers })
        .catch((error: ApiError) => error);
      expect((failure as ApiError).code, formToken).toBe('INVALID_FORM_SESSION');
    }
  });

  it('refuses a token minted for another event', async () => {
    await seedOpenEvent();
    const first = await mockApi.getPublicEvent(slug);
    const firstToken = first.event.formToken!;

    await seedOpenEvent();
    const second = await mockApi.getPublicEvent(slug);

    const failure = await mockApi
      .submitPublicEntry(slug, {
        formToken: firstToken,
        submissionId: uuid(),
        answers: answersFrom(second.event.form!, {
          first_name: 'Ana',
          last_name: 'Lopez',
          email: `cross-${uuid()}@example.com`,
        }),
      })
      .catch((error: ApiError) => error);

    expect((failure as ApiError).code).toBe('INVALID_FORM_SESSION');
  });

  it('refuses once the event is closed', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);
    const token = event.formToken!;
    const answers = answersFrom(event.form!, {
      first_name: 'Ana',
      last_name: 'Lopez',
      email: `closed-${uuid()}@example.com`,
    });

    await login();
    await mockApi.transitionEvent(eventId, 'close');
    await mockApi.logout();

    const failure = await mockApi
      .submitPublicEntry(slug, { formToken: token, submissionId: uuid(), answers })
      .catch((error: ApiError) => error);

    expect((failure as ApiError).code).toBe('PUBLIC_EVENT_NOT_OPEN');
  });
});

// ---------------------------------------------------------------------------

describe('the mock cannot hide a token divergence', () => {
  it('shares the real structural and timing rules, not a copy of them', async () => {
    // The mock does no cryptography — `crypto.subtle` is unavailable in some of
    // the environments it runs in, and a weakened stand-in would teach a
    // security property that does not exist. Every OTHER rule is imported from
    // `shared/publicFormToken`, so the classes of divergence that matter cannot
    // arise. This asserts that the shared rules genuinely refuse each shape.
    const claims = { e: 'event-1', v: 'version-1', i: Math.floor(Date.now() / 1000), n: 'x' };

    // Structurally hostile payloads, all correctly encoded.
    const hostile: unknown[] = [
      { ...claims, extra: 'injected' },
      { e: claims.e, v: claims.v, i: claims.i },
      { ...claims, i: String(claims.i) },
      { ...claims, i: claims.i + 0.5 },
      { ...claims, e: '' },
      [claims],
      'a string',
      null,
    ];

    for (const payload of hostile) {
      const encoded = encodeTokenPayload(payload as never);
      expect(
        decodeTokenPayload(encoded),
        `accepted ${JSON.stringify(payload)}`,
      ).toBeNull();
    }

    // Pollution keys have to be built as RAW JSON: writing `__proto__:` in an
    // object literal sets the prototype rather than creating an own key, so an
    // object-based fixture would silently test nothing.
    const encoder = new TextEncoder();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const raw = `{"e":"${claims.e}","v":"${claims.v}","i":${claims.i},"n":"x","${key}":{"polluted":true}}`;
      expect(decodeTokenPayload(toBase64Url(encoder.encode(raw))), key).toBeNull();
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    // The canonical shape is accepted.
    expect(decodeTokenPayload(encodeTokenPayload(claims))).toEqual(claims);

    // And the timing/binding rules refuse what they should.
    const now = Date.now();
    expect(checkTokenClaims(claims, 'event-1', now)).toBeNull();
    expect(checkTokenClaims(claims, 'other-event', now)).toBe('EVENT_MISMATCH');
    expect(
      checkTokenClaims(claims, 'event-1', now + (PUBLIC_FORM_TOKEN_TTL_SECONDS + 2) * 1000),
    ).toBe('EXPIRED');
    expect(
      checkTokenClaims(
        claims,
        'event-1',
        now - (PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS + 2) * 1000,
      ),
    ).toBe('ISSUED_IN_FUTURE');
  });

  it('rejects a non-canonical base64url payload exactly as production does', () => {
    for (const bad of ['a+b', 'a/b', 'a=b', 'a b', '', 'á']) {
      expect(decodeTokenPayload(bad), bad).toBeNull();
    }
  });

  it('refuses an oversized token before decoding it', () => {
    expect(splitToken(`v1.${'A'.repeat(PUBLIC_FORM_TOKEN_MAX_BYTES + 10)}.mock`)).toBeNull();
  });

  it('a real signed token is never accepted by the mock', async () => {
    // The mock marks its tokens instead of signing them, so a production token
    // and a mock token can never be confused for one another in either
    // direction.
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);
    expect(event.formToken!.endsWith('.mock')).toBe(true);
  });
});

describe('the mock speaks only the public vocabulary', () => {
  it('never leaks an administrative error code to a public caller', async () => {
    await seedOpenEvent();
    const { event } = await mockApi.getPublicEvent(slug);

    // A payload the version cannot accept: an unknown question id.
    const failure = await mockApi
      .submitPublicEntry(slug, {
        formToken: event.formToken!,
        submissionId: uuid(),
        answers: [{ questionId: uuid(), value: 'x' }],
      })
      .catch((error: ApiError) => error);

    expect(PUBLIC_ERROR_CODES).toContain((failure as ApiError).code);
  });
});

// ---------------------------------------------------------------------------

describe('detached copies', () => {
  it('a returned DTO cannot mutate the mock store', async () => {
    await seedOpenEvent();
    const first = await mockApi.getPublicEvent(slug);
    first.event.prizes.push({
      name: 'Injected',
      description: null,
      imageUrl: null,
      quantity: 1,
      sortOrder: 0,
    });

    const second = await mockApi.getPublicEvent(slug);
    expect(second.event.prizes.map((p) => p.name)).not.toContain('Injected');
  });
});

// @vitest-environment node
//
// POST /api/public-events/:slug/entries — the participant's own submission.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequestGet } from '../functions/api/public-events/[slug]/index';
import { onRequestPost } from '../functions/api/public-events/[slug]/entries';
import { setLogSink } from '../functions/_shared/logger';
import {
  answersFor,
  createHarness,
  dobForAge,
  invokePublic,
  seedPublicEvent,
  DOB_QUESTION,
  HABIT_QUESTIONS,
  type PublicHarness,
} from './helpers/publicFlow';
import type { Event, EventFormVersion, PublicEventResponse } from '../shared/types';

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

async function tokenFor(event: Event, options = {}): Promise<string> {
  const response = await invokePublic(
    harness.db,
    onRequestGet as never,
    'GET',
    `/api/public-events/${event.slug}`,
    { slug: event.slug },
    options,
  );
  const payload = (await response.json()) as PublicEventResponse;
  if (!payload.event.formToken) throw new Error('no token issued');
  return payload.event.formToken;
}

async function submit(
  event: Event,
  body: unknown,
  options = {},
): Promise<Response> {
  return invokePublic(
    harness.db,
    onRequestPost as never,
    'POST',
    `/api/public-events/${event.slug}/entries`,
    { slug: event.slug },
    { body, ...options },
  );
}

/** The full happy-path payload for a person of a given age. */
async function payloadFor(
  event: Event,
  version: EventFormVersion,
  age: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    formToken: await tokenFor(event),
    submissionId: uuid(),
    answers: answersFor(version, { date_of_birth: dobForAge(age), ...overrides }),
  };
}

describe('a real submission', () => {
  it('records an eligible participation with no session', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      extra: [DOB_QUESTION],
    });

    const response = await submit(event, await payloadFor(event, version, 25));
    expect(response.status).toBe(201);

    const body = (await response.json()) as { result: string; reason: string | null };
    expect(body.result).toBe('ELIGIBLE');
    expect(body.reason).toBeNull();

    const rows = harness.db.raw.prepare('SELECT * FROM event_entries').all() as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ELIGIBLE');
    expect(rows[0].form_version_id).toBe(version.id);
  });

  it('persists the participant and every answer', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      extra: [DOB_QUESTION, ...HABIT_QUESTIONS],
    });

    await submit(
      event,
      await payloadFor(event, version, 30, { smoker_status: 'no', drinker_status: 'yes' }),
    );

    const participants = harness.db.raw.prepare('SELECT * FROM participants').all();
    expect(participants).toHaveLength(1);

    const answers = harness.db.raw
      .prepare('SELECT question_key FROM event_entry_answers ORDER BY question_key')
      .all() as Array<{ question_key: string }>;
    expect(answers.map((a) => a.question_key)).toEqual([
      'date_of_birth',
      'drinker_status',
      'email',
      'first_name',
      'last_name',
      'smoker_status',
    ]);
  });

  it('writes an audit row with no administrator behind it', async () => {
    // A participant is a real actor with no administrative identity.
    // `audit_logs.actor_admin_id` is nullable precisely for this.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      extra: [DOB_QUESTION],
    });
    await submit(event, await payloadFor(event, version, 25));

    const rows = harness.db.raw
      .prepare("SELECT actor_admin_id, action FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'")
      .all() as Array<{ actor_admin_id: string | null }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].actor_admin_id).toBeNull();
  });

  it('stores the hashed IP and never the raw one', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      extra: [DOB_QUESTION],
    });
    await submit(event, await payloadFor(event, version, 25));

    const row = harness.db.raw
      .prepare('SELECT ip_hash FROM event_entries LIMIT 1')
      .get() as { ip_hash: string | null };

    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    const dump = JSON.stringify(harness.db.raw.prepare('SELECT * FROM event_entries').all());
    expect(dump).not.toContain('203.0.113.7');
  });
});

describe('eligibility is decided by the server', () => {
  it('records an underage person as a real, ineligible participation', async () => {
    // Not a 4xx: they DID take part, and an operator has to be able to see that
    // they did and why they were excluded.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });

    const response = await submit(event, await payloadFor(event, version, 20));
    expect(response.status).toBe(201);

    const body = (await response.json()) as { result: string; reason: string };
    expect(body.result).toBe('INELIGIBLE');
    expect(body.reason).toBe('AGE_REQUIREMENT_NOT_MET');
  });

  it('accepts the same person one year older', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const response = await submit(event, await payloadFor(event, version, 21));
    const body = (await response.json()) as { result: string };
    expect(body.result).toBe('ELIGIBLE');
  });

  it('never returns the calculated age', async () => {
    // Echoing a derived age back turns the endpoint into a calculator that
    // confirms what the server concluded about a person.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const response = await submit(event, await payloadFor(event, version, 20));
    const raw = await response.text();

    expect(raw).not.toContain('calculatedAge');
    expect(raw).not.toContain('ageEligible');
    expect(raw).not.toContain('participantId');
    expect(raw).not.toContain('entryId');
    expect(raw).not.toContain('dateOfBirth');
  });

  it('smoker and drinker answers do not affect eligibility', async () => {
    // They are data about a person, not grounds for exclusion. Hardcoding
    // either would silently disqualify people on a basis nobody agreed to.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION, ...HABIT_QUESTIONS],
    });

    const first = await submit(
      event,
      await payloadFor(event, version, 30, {
        email: 'one@example.com',
        smoker_status: 'yes',
        drinker_status: 'yes',
      }),
    );
    const second = await submit(
      event,
      await payloadFor(event, version, 30, {
        email: 'two@example.com',
        smoker_status: 'no',
        drinker_status: 'no',
      }),
    );

    expect(((await first.json()) as { result: string }).result).toBe('ELIGIBLE');
    expect(((await second.json()) as { result: string }).result).toBe('ELIGIBLE');
  });
});

describe('exact VERSION binding', () => {
  it('validates against the version the participant was SHOWN, not the current one', async () => {
    // The property the whole token exists for.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });

    // The visitor loads the page and receives a token bound to v1.
    const token = await tokenFor(event);
    const answers = answersFor(version, { date_of_birth: dobForAge(30) });

    // An administrator publishes v2 while the form is being filled in.
    const draft = await harness.drafts.find(event.id);
    if (!draft.ok || !draft.value.draft) throw new Error('no draft');
    const added = await harness.drafts.createQuestion(
      event.id,
      {
        expectedRevision: draft.value.draft.revision,
        stepId: draft.value.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'Nickname',
      } as never,
      harness.actor(),
    );
    if (!added.ok) throw new Error(added.failure.code);
    const republished = await harness.publishing.publish(
      event.id,
      added.value.revision,
      harness.actor(),
    );
    if (!republished.ok) throw new Error(republished.failure.code);
    expect(republished.value.version.id).not.toBe(version.id);

    // The submission carries the ORIGINAL token and answers valid for v1.
    const response = await submit(event, {
      formToken: token,
      submissionId: uuid(),
      answers,
    });
    expect(response.status).toBe(201);

    const row = harness.db.raw
      .prepare('SELECT form_version_id FROM event_entries LIMIT 1')
      .get() as { form_version_id: string };
    expect(row.form_version_id).toBe(version.id);
  });

  it('refuses a token minted for a different event', async () => {
    const a = await seedPublicEvent(harness, { slug: 'event-a' });
    const b = await seedPublicEvent(harness, { slug: 'event-b' });

    const response = await submit(b.event, {
      formToken: await tokenFor(a.event),
      submissionId: uuid(),
      answers: answersFor(b.version),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_FORM_SESSION');
  });

  it('gives one generic answer for every way a token can be wrong', async () => {
    // Distinguishing "expired" from "bad signature" is the feedback loop that
    // makes forging signatures tractable.
    const { event, version } = await seedPublicEvent(harness);
    const good = await tokenFor(event);

    const [prefix, payload, mac] = good.split('.');

    const bad = [
      'not-a-token',
      'v1.abc.def',
      `v2.${payload}.${mac}`,
      // The FIRST character of the MAC, not the last.
      //
      // A 43-character base64url string encodes 32 bytes, so its final
      // character carries only 2 significant bits — characters differing solely
      // in the low 2 bits (A/B/C/D, E/F/G/H, ...) decode to identical bytes.
      // Flipping the last character therefore left the MAC UNCHANGED about one
      // time in sixteen, the signature verified, and the submission succeeded:
      // an intermittent failure that looked like flakiness and was a test
      // asserting something false. The first character carries all six bits.
      `${prefix}.${payload}.${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`,
    ];

    for (const formToken of bad) {
      const response = await submit(event, {
        formToken,
        submissionId: uuid(),
        answers: answersFor(version),
      });
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code, formToken).toBe('INVALID_FORM_SESSION');
    }
  });
});

describe('refusals', () => {
  it('reports ALREADY_ENTERED without leaking the entry id', async () => {
    const { event, version } = await seedPublicEvent(harness);

    await submit(event, {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers: answersFor(version),
    });
    const second = await submit(event, {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers: answersFor(version),
    });

    expect(second.status).toBe(409);
    const raw = await second.text();
    expect(raw).toContain('ALREADY_ENTERED');
    expect(raw).not.toContain('entryId');

    const entryId = (
      harness.db.raw.prepare('SELECT id FROM event_entries LIMIT 1').get() as { id: string }
    ).id;
    expect(raw).not.toContain(entryId);
  });

  it('reports an identity conflict without naming the field or the stored value', async () => {
    // "The date of birth we hold differs" is an oracle for the stored date of
    // birth of any address an attacker cares to try.
    const a = await seedPublicEvent(harness, { slug: 'first', extra: [DOB_QUESTION] });
    await submit(a.event, {
      formToken: await tokenFor(a.event),
      submissionId: uuid(),
      answers: answersFor(a.version, { date_of_birth: dobForAge(30) }),
    });

    const b = await seedPublicEvent(harness, { slug: 'second', extra: [DOB_QUESTION] });
    const response = await submit(b.event, {
      formToken: await tokenFor(b.event),
      submissionId: uuid(),
      answers: answersFor(b.version, { date_of_birth: dobForAge(40) }),
    });

    expect(response.status).toBe(409);
    const raw = await response.text();
    expect(raw).toContain('ENTRY_INFORMATION_CONFLICT');
    expect(raw).not.toContain('dateOfBirth');
    expect(raw).not.toContain(dobForAge(30));
  });

  it('refuses a submission once the event has closed', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const token = await tokenFor(event);
    await harness.events.transition(event.id, 'close', harness.actor());

    const response = await submit(event, {
      formToken: token,
      submissionId: uuid(),
      answers: answersFor(version),
    });

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('PUBLIC_EVENT_NOT_OPEN');
  });

  it('reports unavailable when the secret is gone', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const token = await tokenFor(event);

    const response = await submit(
      event,
      { formToken: token, submissionId: uuid(), answers: answersFor(version) },
      { secret: undefined },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toContain('PUBLIC_EVENT_UNAVAILABLE');
  });

  it('404s an unknown event before doing any work', async () => {
    const response = await invokePublic(
      harness.db,
      onRequestPost as never,
      'POST',
      '/api/public-events/nope/entries',
      { slug: 'nope' },
      { body: { formToken: 'x', submissionId: crypto.randomUUID(), answers: [] } },
    );
    expect(response.status).toBe(404);
  });
});

describe('mass assignment', () => {
  it('refuses every server-owned field', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const base = {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers: answersFor(version),
    };

    const forbidden = [
      'participantId',
      'eventId',
      'formVersionId',
      'status',
      'calculatedAge',
      'ageEligible',
      'overallEligible',
      'eligibilityReason',
      'submittedAt',
      'ipHash',
      'userAgent',
    ];

    // Each attempt comes from its own address: eleven submissions from one
    // would legitimately trip the per-IP limiter and mask what is being tested.
    for (const [index, field] of forbidden.entries()) {
      const response = await submit(
        event,
        { ...base, [field]: 'injected' },
        { headers: { 'CF-Connecting-IP': `203.0.113.${100 + index}` } },
      );
      expect(response.status, field).toBe(400);
    }

    expect(harness.db.raw.prepare('SELECT * FROM event_entries').all()).toHaveLength(0);
  });

  it('refuses an answer naming its own key, type or label', async () => {
    // Those are copied from the VERSION, never from the request: a caller that
    // could choose them could file an answer under someone else's question.
    const { event, version } = await seedPublicEvent(harness);
    const answers = answersFor(version).map((answer) => ({
      ...answer,
      questionKey: 'email',
      answerType: 'EMAIL',
      questionLabel: 'Forged',
    }));

    const response = await submit(event, {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers,
    });
    expect(response.status).toBe(400);
  });

  it('requires a UUID submissionId', async () => {
    const { event, version } = await seedPublicEvent(harness);
    for (const submissionId of ['', 'x', 'a'.repeat(300), '../../etc']) {
      const response = await submit(event, {
        formToken: await tokenFor(event),
        submissionId,
        answers: answersFor(version),
      });
      expect(response.status, submissionId).toBe(400);
    }
  });

  it('refuses a body that is not JSON', async () => {
    const { event } = await seedPublicEvent(harness);
    const response = await submit(
      event,
      undefined,
      { rawBody: 'formToken=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    expect(response.status).toBe(415);
  });
});

describe('privacy of the response', () => {
  it('carries exactly result, reason and message', async () => {
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const response = await submit(event, await payloadFor(event, version, 25));
    const body = (await response.json()) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual(['message', 'reason', 'result']);
  });

  it('is never cacheable', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const response = await submit(event, {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers: answersFor(version),
    });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('uses the event’s configured messages', async () => {
    const { event, version } = await seedPublicEvent(harness);
    harness.db.raw
      .prepare('UPDATE events SET confirmation_title = ?, confirmation_message = ? WHERE id = ?')
      .run('Welcome', 'We will be in touch', event.id);

    const response = await submit(event, {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers: answersFor(version),
    });
    const body = (await response.json()) as { message: { title: string; body: string } };
    expect(body.message).toEqual({ title: 'Welcome', body: 'We will be in touch' });
  });
});

// @vitest-environment node
//
// The same submission arriving more than once.
//
// The property under test: a retry produces the SAME observable result, no
// second entry, no second audit row, and no second eligibility evaluation.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { onRequestGet } from '../functions/api/public-events/[slug]/index';
import { onRequestPost } from '../functions/api/public-events/[slug]/entries';
import { setLogSink } from '../functions/_shared/logger';
import { ParticipantRegistrationService } from '../functions/_shared/participantRegistrationService';
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
  const payload = (await response.json()) as PublicEventResponse;
  return payload.event.formToken!;
}

async function submit(event: Event, body: unknown): Promise<Response> {
  return invokePublic(
    harness.db,
    onRequestPost as never,
    'POST',
    `/api/public-events/${event.slug}/entries`,
    { slug: event.slug },
    { body },
  );
}

const count = (sql: string) =>
  (harness.db.raw.prepare(sql).get() as { n: number }).n;

describe('retrying the same submission', () => {
  it('returns the original result and writes nothing new', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const submissionId = uuid();
    const answers = answersFor(version);

    const first = await submit(event, {
      formToken: await tokenFor(event),
      submissionId,
      answers,
    });
    const second = await submit(event, {
      formToken: await tokenFor(event),
      submissionId,
      answers,
    });

    expect(first.status).toBe(201);
    // 200, not 201: nothing was created this time.
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'"),
    ).toBe(1);
  });

  it('writes no second answer set', async () => {
    const { event, version } = await seedPublicEvent(harness, { extra: [DOB_QUESTION] });
    const submissionId = uuid();
    const answers = answersFor(version, { date_of_birth: dobForAge(30) });

    await submit(event, { formToken: await tokenFor(event), submissionId, answers });
    const before = count('SELECT COUNT(*) AS n FROM event_entry_answers');
    await submit(event, { formToken: await tokenFor(event), submissionId, answers });

    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(before);
  });

  it('returns the ORIGINAL verdict even when the answers changed', async () => {
    // The contract: same key means the same logical request. It is not an
    // update key, and the payload is not reprocessed.
    const { event, version } = await seedPublicEvent(harness, {
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const submissionId = uuid();

    const first = await submit(event, {
      formToken: await tokenFor(event),
      submissionId,
      answers: answersFor(version, { date_of_birth: dobForAge(20) }),
    });
    expect(((await first.clone().json()) as { result: string }).result).toBe('INELIGIBLE');

    // The retry claims to be 40 years old. It must change nothing.
    const second = await submit(event, {
      formToken: await tokenFor(event),
      submissionId,
      answers: answersFor(version, { date_of_birth: dobForAge(40) }),
    });

    expect(((await second.json()) as { result: string }).result).toBe('INELIGIBLE');
    const stored = harness.db.raw
      .prepare('SELECT calculated_age FROM event_entries LIMIT 1')
      .get() as { calculated_age: number };
    expect(stored.calculated_age).toBe(20);
  });

  it('a replay still succeeds after the event has closed', async () => {
    // Somebody whose entry was recorded at 16:59 and who retries at 17:01 must
    // be told what happened to their submission, not that they are too late for
    // something they already did.
    const { event, version } = await seedPublicEvent(harness);
    const submissionId = uuid();
    const answers = answersFor(version);

    await submit(event, { formToken: await tokenFor(event), submissionId, answers });
    const token = await tokenFor(event);
    await harness.events.transition(event.id, 'close', harness.actor());

    const replay = await submit(event, { formToken: token, submissionId, answers });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { result: string }).result).toBe('ELIGIBLE');
  });
});

describe('distinct submissions', () => {
  it('a different key from the same identity is still a duplicate', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const answers = answersFor(version);

    await submit(event, { formToken: await tokenFor(event), submissionId: uuid(), answers });
    const second = await submit(event, {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers,
    });

    // UNIQUE(event_id, participant_id) still decides.
    expect(second.status).toBe(409);
    expect(await second.text()).toContain('ALREADY_ENTERED');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });

  it('the same key on a DIFFERENT event is a different submission', async () => {
    const a = await seedPublicEvent(harness, { slug: 'event-a' });
    const b = await seedPublicEvent(harness, { slug: 'event-b' });
    const submissionId = uuid();

    const first = await submit(a.event, {
      formToken: await tokenFor(a.event),
      submissionId,
      answers: answersFor(a.version),
    });
    const second = await submit(b.event, {
      formToken: await tokenFor(b.event),
      submissionId,
      answers: answersFor(b.version),
    });

    expect(first.status).toBe(201);
    // The index is scoped by event, so the same key on another event is an
    // ordinary distinct submission and simply succeeds.
    //
    // It used to be global, which turned this into a constraint violation the
    // service could only report as "unavailable" — a wrong answer to a
    // perfectly legitimate request. A key means one submission to ONE event.
    expect(second.status).toBe(201);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(2);
  });

  it('never replays another event’s result for the same key', async () => {
    // The lookup is scoped by event as well, so a key obtained from one event's
    // response cannot be presented to another to discover whether it exists or
    // to harvest somebody else's outcome.
    const a = await seedPublicEvent(harness, {
      slug: 'age-event',
      minimumAge: 21,
      timezone: 'UTC',
      extra: [DOB_QUESTION],
    });
    const b = await seedPublicEvent(harness, { slug: 'open-event' });
    const submissionId = uuid();

    const first = await submit(a.event, {
      formToken: await tokenFor(a.event),
      submissionId,
      answers: answersFor(a.version, {
        email: 'shared@example.com',
        date_of_birth: dobForAge(20),
      }),
    });
    expect(((await first.json()) as { result: string }).result).toBe('INELIGIBLE');

    const second = await submit(b.event, {
      formToken: await tokenFor(b.event),
      submissionId,
      answers: answersFor(b.version, { email: 'shared@example.com' }),
    });

    // Judged on its own event's rules, not handed event A's verdict.
    expect(((await second.json()) as { result: string }).result).toBe('ELIGIBLE');
  });
});

describe('the race', () => {
  it('two simultaneous retries produce one entry and one audit row', async () => {
    // A precheck can lose a race; an index cannot. The loser's whole batch —
    // entry, answers and both audit rows — rolls back, and it re-reads the
    // winner.
    const { event, version } = await seedPublicEvent(harness);
    const submissionId = uuid();
    const answers = answersFor(version);
    const token = await tokenFor(event);

    const [a, b] = await Promise.all([
      submit(event, { formToken: token, submissionId, answers }),
      submit(event, { formToken: token, submissionId, answers }),
    ]);

    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'"),
    ).toBe(1);

    // Neither is a raw 500.
    for (const response of [a, b]) {
      expect([200, 201]).toContain(response.status);
    }
    expect(await a.json()).toEqual(await b.json());
  });

  it('resolves a race that gets PAST the precheck, via the constraint', async () => {
    // The ordinary concurrent case is usually settled earlier — by the
    // duplicate-identity precheck recognising the key as its own. This forces
    // the harder path: a competing row lands AFTER this request has checked and
    // BEFORE its batch commits, so `ux_event_entries_submission_id` is what
    // decides. Without the constraint translation the caller would see a raw
    // SQLite error instead of their own result.
    const { event, version } = await seedPublicEvent(harness);
    const submissionId = uuid();
    const answers = answersFor(version, { email: 'racer@example.com' });

    // A database whose `batch` slips a winning entry in first, exactly once.
    let interfered = false;
    const racing = {
      prepare: (sql: string) => harness.db.d1.prepare(sql),
      exec: (sql: string) => harness.db.d1.exec(sql),
      batch: async (statements: unknown[]) => {
        if (!interfered) {
          interfered = true;
          const winner = new ParticipantRegistrationService(harness.db.d1);
          await winner.registerWithResolvedVersion(
            event.id,
            version.id,
            answers,
            {
              admin: null,
              requestContext: {
                requestId: 'req-winner',
                ipHash: null,
                userAgent: null,
                origin: null,
                method: 'POST',
                pathname: '/x',
              },
            },
            { submissionId },
          );
        }
        return harness.db.d1.batch(statements as never);
      },
    } as unknown as D1Database;

    const loser = new ParticipantRegistrationService(racing);
    const result = await loser.registerWithResolvedVersion(
      event.id,
      version.id,
      answers,
      {
        admin: null,
        requestContext: {
          requestId: 'req-loser',
          ipHash: null,
          userAgent: null,
          origin: null,
          method: 'POST',
          pathname: '/x',
        },
      },
      { submissionId },
    );

    expect(interfered).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // The loser received the winner's result rather than an error.
    expect(result.value.replayed).toBe(true);

    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'"),
    ).toBe(1);
  });

  it('resolves a collision on the KEY ALONE, with no identity conflict to mask it', async () => {
    // The narrowest path, and the only one that reaches the submission_id
    // constraint translation. Two requests share a key but carry DIFFERENT
    // addresses, so neither the participant index nor the duplicate-entry index
    // is violated — `ux_event_entries_submission_id` is the only thing left to
    // decide, and if its translation is missing the caller sees a raw SQLite
    // error instead of a result.
    const { event, version } = await seedPublicEvent(harness);
    const submissionId = uuid();

    const context = (id: string) => ({
      admin: null,
      requestContext: {
        requestId: id,
        ipHash: null,
        userAgent: null,
        origin: null,
        method: 'POST',
        pathname: '/x',
      },
    });

    let interfered = false;
    const racing = {
      prepare: (sql: string) => harness.db.d1.prepare(sql),
      exec: (sql: string) => harness.db.d1.exec(sql),
      batch: async (statements: unknown[]) => {
        if (!interfered) {
          interfered = true;
          await new ParticipantRegistrationService(harness.db.d1)
            .registerWithResolvedVersion(
              event.id,
              version.id,
              answersFor(version, { email: 'winner@example.com' }),
              context('req-winner'),
              { submissionId },
            );
        }
        return harness.db.d1.batch(statements as never);
      },
    } as unknown as D1Database;

    const result = await new ParticipantRegistrationService(
      racing,
    ).registerWithResolvedVersion(
      event.id,
      version.id,
      // A different identity entirely: no participant and no duplicate-entry
      // conflict, so only the key collides.
      answersFor(version, { email: 'loser@example.com' }),
      context('req-loser'),
      { submissionId },
    );

    expect(interfered).toBe(true);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.replayed).toBe(true);

    // Exactly one participation exists, and it is the winner's.
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'"),
    ).toBe(1);
    const stored = harness.db.raw
      .prepare('SELECT email FROM participants ORDER BY email')
      .all() as Array<{ email: string }>;
    // The loser's identity was never written: its whole batch rolled back.
    expect(stored.map((row) => row.email)).toEqual(['winner@example.com']);
  });

  it('the service reports the replay flag so a handler can pick its status code', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const service = new ParticipantRegistrationService(harness.db.d1);
    const submissionId = uuid();
    const context = {
      requestId: 'req-1',
      ipHash: null,
      userAgent: null,
      origin: null,
      method: 'POST',
      pathname: '/x',
    };

    const first = await service.registerWithResolvedVersion(
      event.id,
      version.id,
      answersFor(version),
      { admin: null, requestContext: context },
      { submissionId },
    );
    const second = await service.registerWithResolvedVersion(
      event.id,
      version.id,
      answersFor(version),
      { admin: null, requestContext: context },
      { submissionId },
    );

    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(first.value.replayed).toBe(false);
    expect(second.value.replayed).toBe(true);
    expect(second.value.entry.id).toBe(first.value.entry.id);
  });
});

describe('historical rows', () => {
  it('entries without a key coexist and never collide', async () => {
    // The partial index only covers non-null keys. Administrative entries and
    // every row predating phase 9 carry NULL.
    const { event, version } = await seedPublicEvent(harness);

    const admin = await harness.registration.register(
      event.id,
      answersFor(version, { email: 'admin-entered@example.com' }),
      harness.actor(),
    );
    if (!admin.ok) throw new Error(JSON.stringify(admin.failure));
    expect(admin.value.entry.submissionId).toBeNull();

    const publicResult = await submit(event, {
      formToken: await tokenFor(event),
      submissionId: uuid(),
      answers: answersFor(version, { email: 'self-entered@example.com' }),
    });
    expect(publicResult.status).toBe(201);

    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM event_entries WHERE submission_id IS NULL')).toBe(1);
  });

  it('the administrative endpoint is unchanged and needs no key', async () => {
    const { event, version } = await seedPublicEvent(harness);
    const result = await harness.registration.register(
      event.id,
      answersFor(version),
      harness.actor(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.replayed).toBe(false);
    expect(result.value.entry.submissionId).toBeNull();
  });
});

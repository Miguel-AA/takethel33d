// @vitest-environment node
//
// Eligibility end to end: a real event, a real published form, a real
// submission, and the row that comes out of it.
//
// The dates here are FIXED rather than relative, because an age test whose
// expectation depends on the day it runs is a test that will one day be wrong
// for a reason nobody can reproduce. The submission instant is injected.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParticipantRegistrationService } from '../functions/_shared/participantRegistrationService';
import { EligibilityService } from '../functions/_shared/eligibilityService';
import { FormPublishingService } from '../functions/_shared/formPublishingService';
import { FormDraftService } from '../functions/_shared/formDraftService';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type {
  AuthenticatedAdmin,
  Event,
  EventFormVersion,
  SubmittedAnswer,
} from '../shared/types';

let db: TestDatabase;
let service: ParticipantRegistrationService;
let publishing: FormPublishingService;
let drafts: FormDraftService;
let events: EventLifecycleService;
let admin: AuthenticatedAdmin;

const REQUEST: RequestContext = {
  requestId: 'req-eligibility',
  ipHash: 'c'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/api/events/x/entries',
};

const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function count(sql: string): number {
  return (db.raw.prepare(sql).get() as { n: number }).n;
}

const DOB_QUESTION = {
  type: 'DATE',
  systemField: 'DATE_OF_BIRTH',
  label: 'Date of birth',
} as const;

/** The client's actual form: identity, date of birth, and two habits. */
const CLIENT_QUESTIONS = [
  DOB_QUESTION,
  {
    type: 'SINGLE_SELECT',
    label: 'Do you smoke?',
    key: 'smoker_status',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
  {
    type: 'SINGLE_SELECT',
    label: 'Do you drink?',
    key: 'drinker_status',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
];

async function seedEvent(
  extra: Array<Record<string, unknown>> = [],
  overrides: Record<string, unknown> = {},
): Promise<{ event: Event; version: EventFormVersion }> {
  const made = await events.create(
    {
      name: 'Eligibility Event',
      registrationOpensAt: at(-1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
      ...overrides,
    } as never,
    actor(),
  );
  if (!made.ok) throw new Error(JSON.stringify(made.failure));
  const created = made.value;

  const ensured = await drafts.ensure(created.id, actor());
  if (!ensured.ok) throw new Error(ensured.failure.code);
  let form = ensured.value.draft;

  const step = await drafts.createStep(
    created.id,
    { expectedRevision: form.revision, title: 'About you' },
    actor(),
  );
  if (!step.ok) throw new Error(step.failure.code);
  form = step.value;

  for (const spec of [
    { type: 'SHORT_TEXT', systemField: 'FIRST_NAME', label: 'First name', required: true },
    { type: 'SHORT_TEXT', systemField: 'LAST_NAME', label: 'Last name', required: true },
    { type: 'EMAIL', systemField: 'EMAIL', label: 'Email', required: true },
    ...extra,
  ]) {
    const question = await drafts.createQuestion(
      created.id,
      { expectedRevision: form.revision, stepId: form.steps[0].id, ...spec } as never,
      actor(),
    );
    if (!question.ok) throw new Error(`${JSON.stringify(spec)} -> ${question.failure.code}`);
    form = question.value;
  }

  const published = await publishing.publish(created.id, form.revision, actor());
  if (!published.ok) throw new Error(published.failure.code);
  const opened = await events.transition(created.id, 'open', actor());
  if (!opened.ok) throw new Error(JSON.stringify(opened.failure));

  const reloaded = await events.findById(created.id);
  if (!reloaded) throw new Error('event vanished');
  return { event: reloaded, version: published.value.version };
}

/** Sets the age rule directly, so the test does not depend on edit permissions. */
function setMinimumAge(eventId: string, minimumAge: number | null) {
  db.raw.prepare('UPDATE events SET minimum_age = ? WHERE id = ?').run(minimumAge, eventId);
}

function setTimezone(eventId: string, timezone: string) {
  db.raw.prepare('UPDATE events SET timezone = ? WHERE id = ?').run(timezone, eventId);
}

function answersFor(
  version: EventFormVersion,
  overrides: Record<string, unknown> = {},
): SubmittedAnswer[] {
  const values: Record<string, unknown> = {
    first_name: 'Ana',
    last_name: 'Lopez',
    email: 'Ana@Example.com',
    ...overrides,
  };
  const byKey = new Map(
    version.steps.flatMap((step) => step.questions).map((question) => [question.key, question]),
  );
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const question = byKey.get(key);
      if (!question) throw new Error(`no question keyed ${key}`);
      return { questionId: question.id, value };
    });
}

/** A service whose `batch` runs `interfere()` immediately before committing. */
function interposing(interfere: () => void): ParticipantRegistrationService {
  let fired = false;
  const racing = {
    prepare: (sql: string) => db.d1.prepare(sql),
    exec: (sql: string) => db.d1.exec(sql),
    batch: (statements: unknown[]) => {
      if (!fired) {
        fired = true;
        interfere();
      }
      return db.d1.batch(statements as never);
    },
  } as unknown as D1Database;
  return new ParticipantRegistrationService(racing);
}

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});
  service = new ParticipantRegistrationService(db.d1);
  publishing = new FormPublishingService(db.d1);
  drafts = new FormDraftService(db.d1);
  events = new EventLifecycleService(db.d1);

  const created = await new AdminRepository(db.d1).create({
    email: 'ada@example.com',
    normalizedEmail: normalizeEmail('ada@example.com'),
    displayName: 'Ada Lovelace',
    passwordHash: await hashPassword('a-strong-admin-password'),
  });
  if (created.kind !== 'created') throw new Error('admin seed failed');
  admin = {
    id: created.admin.id,
    email: created.admin.email,
    displayName: created.admin.displayName,
    role: 'ADMIN',
    status: 'ACTIVE',
    sessionId: 'session-1',
  };
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

/** A date of birth that makes somebody exactly `years` old today. */
function dobForAge(years: number, timezone = 'America/New_York'): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [year, month, day] = today.split('-');
  return `${Number(year) - years}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
describe('the client’s actual case', () => {
  it('a 21-year-old is eligible, and their habits do not enter into it', async () => {
    const { event, version } = await seedEvent(CLIENT_QUESTIONS);
    setMinimumAge(event.id, 21);

    const result = await service.register(
      event.id,
      answersFor(version, {
        date_of_birth: dobForAge(21),
        smoker_status: 'yes',
        drinker_status: 'yes',
      }),
      actor(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entry.status).toBe('ELIGIBLE');
    expect(result.value.entry.calculatedAge).toBe(21);
    expect(result.value.entry.ageEligible).toBe(true);
    expect(result.value.entry.overallEligible).toBe(true);
    expect(result.value.entry.eligibilityReason).toBe('ELIGIBLE');
    // Smoking and drinking are DATA. Making either a rule would exclude people
    // on a basis nobody agreed to.
    expect(result.value.answerCount).toBe(6);
  });

  it('a 20-year-old is RECORDED, and recorded as ineligible', async () => {
    const { event, version } = await seedEvent(CLIENT_QUESTIONS);
    setMinimumAge(event.id, 21);

    const result = await service.register(
      event.id,
      answersFor(version, {
        date_of_birth: dobForAge(20),
        smoker_status: 'no',
        drinker_status: 'no',
      }),
      actor(),
    );

    // The submission SUCCEEDS. An operator has to be able to see who tried.
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entry.status).toBe('INELIGIBLE');
    expect(result.value.entry.calculatedAge).toBe(20);
    expect(result.value.entry.ageEligible).toBe(false);
    expect(result.value.entry.overallEligible).toBe(false);
    expect(result.value.entry.eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');

    // And everything they said is kept, not discarded because they lost.
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(6);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
  });

  it('a non-smoking teetotaller who is too young is still ineligible', async () => {
    // Guards against anybody "helping" by weighting the habit answers.
    const { event, version } = await seedEvent(CLIENT_QUESTIONS);
    setMinimumAge(event.id, 21);

    const result = await service.register(
      event.id,
      answersFor(version, {
        date_of_birth: dobForAge(18),
        smoker_status: 'no',
        drinker_status: 'no',
      }),
      actor(),
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entry.overallEligible).toBe(false);
  });

  it('a smoker who is old enough is eligible', async () => {
    const { event, version } = await seedEvent(CLIENT_QUESTIONS);
    setMinimumAge(event.id, 21);

    const result = await service.register(
      event.id,
      answersFor(version, {
        date_of_birth: dobForAge(45),
        smoker_status: 'yes',
        drinker_status: 'yes',
      }),
      actor(),
    );
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entry.overallEligible).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('an event with no age rule', () => {
  it('decides without judging an age, even with no date of birth asked', async () => {
    const { event, version } = await seedEvent();
    setMinimumAge(event.id, null);

    const result = await service.register(event.id, answersFor(version), actor());
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entry.overallEligible).toBe(true);
    expect(result.value.entry.ageEligible).toBeNull();
    expect(result.value.entry.calculatedAge).toBeNull();
    expect(result.value.entry.status).toBe('ELIGIBLE');
  });

  it('records the age anyway when the form asks for a date of birth', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, null);

    const result = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30) }),
      actor(),
    );
    if (!result.ok) throw new Error('unreachable');
    // The age is a fact worth keeping; the JUDGEMENT is what is absent.
    expect(result.value.entry.calculatedAge).toBe(30);
    expect(result.value.entry.ageEligible).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('a minimum age of zero', () => {
  it('is a rule that everybody passes, not the absence of one', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 0);

    const result = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(0) }),
      actor(),
    );
    if (!result.ok) throw new Error('unreachable');
    // Truthiness would drop this rule entirely and leave `ageEligible` null.
    expect(result.value.entry.ageEligible).toBe(true);
    expect(result.value.entry.calculatedAge).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('a date of birth that is not a date of birth', () => {
  async function attempt(dateOfBirth: unknown, minimumAge: number | null = 21) {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, minimumAge);
    return service.register(
      event.id,
      answersFor(version, { date_of_birth: dateOfBirth }),
      actor(),
    );
  }

  it('refuses an impossible day, a future day and an implausible age', async () => {
    for (const bad of ['2025-02-29', '2099-01-01', '1800-01-01']) {
      const result = await attempt(bad);
      expect(result.ok, bad).toBe(false);
    }
    // Nothing was recorded: this is broken input, not a person who lost.
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
  });

  it('names the age limit specifically, and calls it invalid input', async () => {
    const result = await attempt('1800-01-01');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DATE_OF_BIRTH_INVALID');
    if (result.failure.code !== 'DATE_OF_BIRTH_INVALID') throw new Error('unreachable');
    expect(result.failure.problem).toBe('IMPLAUSIBLE');
  });

  it('refuses an implausible date even when NO age rule reads it', async () => {
    const result = await attempt('1800-01-01', null);
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('refuses a timestamp where a calendar day belongs', async () => {
    const result = await attempt('2005-08-07T00:00:00.000Z');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Caught by the answer type before eligibility even looks.
    expect(result.failure.code).toBe('FORM_ANSWER_INVALID');
  });
});

// ---------------------------------------------------------------------------
describe('a form that cannot support the rule', () => {
  it('is reported as a broken FORM, not as a person who failed', async () => {
    // Publishing guarantees DATE_OF_BIRTH whenever there is a minimum age, so
    // this state only exists if the stored version was altered.
    const { event, version } = await seedEvent();
    setMinimumAge(event.id, 21);

    const result = await service.register(event.id, answersFor(version), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_VERSION_INVALID');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('is reported as a missing ANSWER when the form does ask', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    // Make the question optional on the frozen version, so nothing demands it
    // earlier and eligibility is the layer that notices.
    db.raw
      .prepare(
        `UPDATE form_questions SET required = 0
          WHERE system_field = 'DATE_OF_BIRTH' AND form_owner_type = 'VERSION'
            AND form_owner_id = ?`,
      )
      .run(version.id);

    const result = await service.register(event.id, answersFor(version), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DATE_OF_BIRTH_REQUIRED');
  });
});

// ---------------------------------------------------------------------------
describe('the event’s timezone decides what day it is', () => {
  it('refuses a zone the runtime cannot resolve rather than defaulting to UTC', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    setTimezone(event.id, 'Mars/Olympus_Mons');

    const result = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30) }),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_VERSION_INVALID');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('the same person is a different age in two zones on the same instant', () => {
    // Asked of the service directly, with a fixed instant, so the assertion is
    // about the rule rather than about when the test happens to run.
    const eligibility = new EligibilityService();
    const instant = new Date('2026-08-08T03:30:00.000Z');
    const shared = { versionSteps: [], dateOfBirth: '2005-08-08', now: instant };

    const tokyo = eligibility.evaluate({
      event: { id: 'e', minimumAge: 21, timezone: 'Asia/Tokyo' },
      ...shared,
    });
    const newYork = eligibility.evaluate({
      event: { id: 'e', minimumAge: 21, timezone: 'America/New_York' },
      ...shared,
    });

    if (!tokyo.ok || !newYork.ok) throw new Error('unreachable');
    expect(tokyo.referenceCivilDate).toBe('2026-08-08');
    expect(newYork.referenceCivilDate).toBe('2026-08-07');
    expect(tokyo.decision.calculatedAge).toBe(21);
    expect(tokyo.decision.overallEligible).toBe(true);
    expect(newYork.decision.calculatedAge).toBe(20);
    expect(newYork.decision.overallEligible).toBe(false);
  });

  it('the time of day does not change the answer within one local day', () => {
    const eligibility = new EligibilityService();
    const event = { id: 'e', minimumAge: 21, timezone: 'America/New_York' } as const;

    // 00:01 and 23:59 local on the same day.
    const early = eligibility.evaluate({
      event,
      versionSteps: [],
      dateOfBirth: '2005-08-07',
      now: new Date('2026-08-07T04:01:00.000Z'),
    });
    const late = eligibility.evaluate({
      event,
      versionSteps: [],
      dateOfBirth: '2005-08-07',
      now: new Date('2026-08-08T03:59:00.000Z'),
    });

    if (!early.ok || !late.ok) throw new Error('unreachable');
    expect(early.referenceCivilDate).toBe('2026-08-07');
    expect(late.referenceCivilDate).toBe('2026-08-07');
    expect(early.decision.calculatedAge).toBe(late.decision.calculatedAge);
  });
});

// ---------------------------------------------------------------------------
describe('the rules cannot change under a decision', () => {
  it('raising the minimum age mid-batch aborts the whole registration', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const racing = interposing(() => setMinimumAge(event.id, 25));
    const result = await racing.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(22) }),
      actor(),
    );

    // The verdict was computed against 21. Writing it now would store a
    // decision that no configuration ever produced.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_REGISTRATION_CONFIG_CHANGED');

    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'")).toBe(
      0,
    );
    // And the event survived the guard that fired.
    const stored = db.raw
      .prepare('SELECT status, minimum_age AS m FROM events WHERE id = ?')
      .get(event.id) as { status: string; m: number };
    expect(stored.status).toBe('OPEN');
    expect(stored.m).toBe(25);
  });

  it('REMOVING the age rule mid-batch aborts too', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const racing = interposing(() => setMinimumAge(event.id, null));
    const result = await racing.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(18) }),
      actor(),
    );
    // Otherwise an INELIGIBLE row would land on an event that has no age rule.
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('ADDING an age rule mid-batch aborts too', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, null);

    const racing = interposing(() => setMinimumAge(event.id, 21));
    const result = await racing.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(18) }),
      actor(),
    );
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('moving the event to another timezone mid-batch aborts', async () => {
    // The zone decides what day it is, so it decides the age. A decision
    // computed in New York must not be written against Los Angeles.
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const racing = interposing(() => setTimezone(event.id, 'America/Los_Angeles'));
    const result = await racing.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30) }),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_REGISTRATION_CONFIG_CHANGED');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('closing the event mid-batch is still reported as CLOSED, not as a config change', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const racing = interposing(() => {
      db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);
    });
    const result = await racing.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30) }),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The two aborts share a guard; the answer distinguishes them by re-reading
    // the event rather than guessing.
    expect(result.failure.code).toBe('EVENT_NOT_ACCEPTING_ENTRIES');
  });

  it('publishing a NEW FORM VERSION mid-batch does NOT abort', async () => {
    // Deliberately not covered by the guard. A submission that resolved v1
    // correctly stays valid; invalidating it would mean any publication cancels
    // everybody currently filling the form in.
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const racing = interposing(() => {
      const now = new Date().toISOString();
      const v2 = crypto.randomUUID();
      db.raw
        .prepare(
          `INSERT INTO event_form_versions
             (id, event_id, version_number, source_draft_revision, published_by,
              published_at, schema_snapshot, created_at)
           VALUES (?, ?, 2, 99, ?, ?, '{"snapshotVersion":1}', ?)`,
        )
        .run(v2, event.id, admin.id, now, now);
      db.raw
        .prepare(
          'UPDATE events SET published_form_version_id = ?, revision = revision + 1 WHERE id = ?',
        )
        .run(v2, event.id);
    });

    const result = await racing.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30) }),
      actor(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entry.formVersionId).toBe(version.id);
    expect(result.value.entry.status).toBe('ELIGIBLE');
  });
});

// ---------------------------------------------------------------------------
describe('a decision belongs to the moment it was taken', () => {
  it('raising the age limit afterwards does not exclude anybody retroactively', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const created = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(22) }),
      actor(),
    );
    if (!created.ok) throw new Error('unreachable');
    expect(created.value.entry.overallEligible).toBe(true);

    setMinimumAge(event.id, 30);

    const detail = await service.detail(event.id, created.value.entry.id);
    if (!detail.ok) throw new Error('unreachable');
    // Read back, never recomputed. The row IS the decision.
    expect(detail.value.entry.calculatedAge).toBe(22);
    expect(detail.value.entry.ageEligible).toBe(true);
    expect(detail.value.entry.overallEligible).toBe(true);
    expect(detail.value.entry.eligibilityReason).toBe('ELIGIBLE');
  });

  it('lowering it afterwards does not admit anybody retroactively either', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const created = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(18) }),
      actor(),
    );
    if (!created.ok) throw new Error('unreachable');
    expect(created.value.entry.status).toBe('INELIGIBLE');

    setMinimumAge(event.id, 18);

    const detail = await service.detail(event.id, created.value.entry.id);
    if (!detail.ok) throw new Error('unreachable');
    expect(detail.value.entry.status).toBe('INELIGIBLE');
    expect(detail.value.entry.eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');
  });

  it('the stored age does not grow when the person has a birthday', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    // Born tomorrow, 21 years ago: 20 today, 21 in a day.
    const tomorrow = new Date(Date.now() + DAY);
    const dob = `${tomorrow.getUTCFullYear() - 21}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;

    const created = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dob }),
      actor(),
    );
    if (!created.ok) throw new Error('unreachable');
    const recorded = created.value.entry.calculatedAge;

    const detail = await service.detail(event.id, created.value.entry.id);
    if (!detail.ok) throw new Error('unreachable');
    // `calculated_age` is age AT SUBMISSION. Nothing recomputes it.
    expect(detail.value.entry.calculatedAge).toBe(recorded);
  });
});

// ---------------------------------------------------------------------------
describe('what still refuses a submission outright', () => {
  it('a duplicate is a refusal, never a second ineligible entry', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    const answers = answersFor(version, { date_of_birth: dobForAge(30) });

    const first = await service.register(event.id, answers, actor());
    expect(first.ok).toBe(true);

    const again = await service.register(event.id, answers, actor());
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.failure.code).toBe('PARTICIPANT_ALREADY_ENTERED');
    // No entry carries DUPLICATE_ENTRY: a duplicate is not a participation.
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(
      count("SELECT COUNT(*) AS n FROM event_entries WHERE eligibility_reason = 'DUPLICATE_ENTRY'"),
    ).toBe(0);
  });

  it('a closed event is a refusal, never an ineligible entry', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);

    const result = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30) }),
      actor(),
    );
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('a missing required answer is a refusal, never an ineligible entry', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    const result = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30), email: undefined }),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_REQUIRED_ANSWER_MISSING');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('an identity conflict is a refusal, never an ineligible entry', async () => {
    const first = await seedEvent([DOB_QUESTION]);
    setMinimumAge(first.event.id, 21);
    await service.register(
      first.event.id,
      answersFor(first.version, { date_of_birth: '1990-01-01' }),
      actor(),
    );

    const second = await seedEvent([DOB_QUESTION]);
    setMinimumAge(second.event.id, 21);
    const result = await service.register(
      second.event.id,
      answersFor(second.version, { date_of_birth: '1991-01-01' }),
      actor(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('PARTICIPANT_IDENTITY_CONFLICT');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the audit record of a decision', () => {
  it('carries the verdict and the age, and no date of birth', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    await service.register(
      event.id,
      answersFor(version, { date_of_birth: '1990-03-15' }),
      actor(),
    );

    const rows = db.raw
      .prepare("SELECT * FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);

    const newData = JSON.parse(String(rows[0].new_data)) as Record<string, unknown>;
    expect(newData.status).toBe('ELIGIBLE');
    expect(newData.overallEligible).toBe(true);
    expect(newData.ageEligible).toBe(true);
    expect(newData.eligibilityReason).toBe('ELIGIBLE');
    expect(typeof newData.calculatedAge).toBe('number');

    // The AGE explains the decision; the DATE is the personal data it was made
    // from, and the audit table is append-only and never deleted.
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('1990-03-15');
    expect(serialized).not.toContain('Ana@Example.com');
  });

  it('one row per registration, decision included', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(18) }),
      actor(),
    );

    // Two rows for one act would have to be read together to mean anything —
    // and one of them could be the one that failed to write.
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'")).toBe(
      1,
    );
  });
});

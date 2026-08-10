// @vitest-environment node
//
// Adversarial validation of phase 8.
//
// Every test here is an attack on a defence the implementation claims to have.
// Passing is not proof the feature works — it is proof that this particular way
// of breaking it does not.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParticipantRegistrationService } from '../functions/_shared/participantRegistrationService';
import { EligibilityService } from '../functions/_shared/eligibilityService';
import { EventRepository } from '../functions/_shared/eventRepository';
import { FormPublishingService } from '../functions/_shared/formPublishingService';
import { FormDraftService } from '../functions/_shared/formDraftService';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { calculateAgeOnDate, civilDateInEventZone } from '../shared/eligibility';
import { isValidTimeZone } from '../shared/timezone';
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
  requestId: 'req-elig-adv',
  ipHash: 'd'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/api/events/x/entries',
};

const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const count = (sql: string) => (db.raw.prepare(sql).get() as { n: number }).n;

const DOB_QUESTION = {
  type: 'DATE',
  systemField: 'DATE_OF_BIRTH',
  label: 'Date of birth',
} as const;

const HABITS = [
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
): Promise<{ event: Event; version: EventFormVersion }> {
  const made = await events.create(
    {
      name: 'Adversarial Eligibility',
      registrationOpensAt: at(-1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    },
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

const setMinimumAge = (eventId: string, value: number | null) =>
  db.raw.prepare('UPDATE events SET minimum_age = ? WHERE id = ?').run(value, eventId);

const setTimezone = (eventId: string, value: string) =>
  db.raw.prepare('UPDATE events SET timezone = ? WHERE id = ?').run(value, eventId);

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

/** A date of birth that makes somebody exactly `years` old, in a zone. */
function dobForAge(years: number, timezone = 'America/New_York'): string {
  const today = civilDateInEventZone(new Date(), timezone);
  const [year, month, day] = today.split('-');
  return `${Number(year) - years}-${month}-${day}`;
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

// ---------------------------------------------------------------------------
describe('the guard’s NULL semantics', () => {
  // SQL's `NULL <> 21` is NULL, not true, and `NULL = NULL` is not true either.
  // A guard written the obvious way would silently fail to abort in exactly the
  // transitions that matter most.
  async function raceMinimumAge(before: number | null, after: number | null) {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, before);

    const racing = interposing(() => setMinimumAge(event.id, after));
    const result = await racing.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(30) }),
      actor(),
    );
    return result;
  }

  it('aborts on every transition of the age rule, including to and from null', async () => {
    for (const [before, after] of [
      [21, 25],
      [21, null],
      [null, 21],
      [0, 21],
      [21, 0],
      [0, null],
      [null, 0],
    ] as const) {
      db.close();
      db = createTestDatabase();
      service = new ParticipantRegistrationService(db.d1);
      publishing = new FormPublishingService(db.d1);
      drafts = new FormDraftService(db.d1);
      events = new EventLifecycleService(db.d1);
      const seeded = await new AdminRepository(db.d1).create({
        email: 'ada@example.com',
        normalizedEmail: normalizeEmail('ada@example.com'),
        displayName: 'Ada Lovelace',
        passwordHash: await hashPassword('a-strong-admin-password'),
      });
      if (seeded.kind !== 'created') throw new Error('admin seed failed');
      admin = { ...admin, id: seeded.admin.id };

      const label = `${before} -> ${after}`;
      const result = await raceMinimumAge(before, after);
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code, label).toBe('EVENT_REGISTRATION_CONFIG_CHANGED');
      expect(count('SELECT COUNT(*) AS n FROM event_entries'), label).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM participants'), label).toBe(0);
    }
  });

  it('does NOT abort when the rule is unchanged, in either representation', async () => {
    for (const value of [null, 0, 21] as const) {
      db.close();
      db = createTestDatabase();
      service = new ParticipantRegistrationService(db.d1);
      publishing = new FormPublishingService(db.d1);
      drafts = new FormDraftService(db.d1);
      events = new EventLifecycleService(db.d1);
      const seeded = await new AdminRepository(db.d1).create({
        email: 'ada@example.com',
        normalizedEmail: normalizeEmail('ada@example.com'),
        displayName: 'Ada Lovelace',
        passwordHash: await hashPassword('a-strong-admin-password'),
      });
      if (seeded.kind !== 'created') throw new Error('admin seed failed');
      admin = { ...admin, id: seeded.admin.id };

      // A guard that over-fires is as broken as one that under-fires: it would
      // refuse every ordinary registration.
      const result = await raceMinimumAge(value, value);
      expect(result.ok, String(value)).toBe(true);
    }
  });

  it('the SQL itself compares null-safely, asked of the statement directly', async () => {
    const { event } = await seedEvent();
    const repository = new EventRepository(db.d1);
    const now = new Date().toISOString();

    async function guardFires(stored: number | null, expected: number | null) {
      setMinimumAge(event.id, stored);
      // Re-open the event: a previous abort leaves it however it was.
      db.raw.prepare("UPDATE events SET status = 'OPEN' WHERE id = ?").run(event.id);
      try {
        await db.d1.batch([
          repository.abortUnlessAcceptingEntriesStatement(event.id, now, {
            minimumAge: expected,
            timezone: event.timezone,
          }),
        ]);
        return false;
      } catch {
        return true;
      }
    }

    // Same value: no abort. Different value, in any direction: abort.
    expect(await guardFires(null, null)).toBe(false);
    expect(await guardFires(21, 21)).toBe(false);
    expect(await guardFires(0, 0)).toBe(false);
    expect(await guardFires(null, 21)).toBe(true);
    expect(await guardFires(21, null)).toBe(true);
    expect(await guardFires(0, null)).toBe(true);
    expect(await guardFires(null, 0)).toBe(true);
    expect(await guardFires(0, 21)).toBe(true);
  });

  it('the guard fires on a timezone change, and not on an identical one', async () => {
    const { event } = await seedEvent();
    const repository = new EventRepository(db.d1);
    const now = new Date().toISOString();

    const fires = async (timezone: string) => {
      db.raw.prepare("UPDATE events SET status = 'OPEN' WHERE id = ?").run(event.id);
      try {
        await db.d1.batch([
          repository.abortUnlessAcceptingEntriesStatement(event.id, now, {
            minimumAge: null,
            timezone,
          }),
        ]);
        return false;
      } catch {
        return true;
      }
    };

    expect(await fires(event.timezone)).toBe(false);
    expect(await fires('America/Los_Angeles')).toBe(true);
    // Compared as an exact value: no silent normalisation to an equivalent.
    expect(await fires('UTC')).toBe(true);
    expect(await fires(event.timezone.toUpperCase())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('one instant, whatever the clock does', () => {
  it('a clock crossing midnight mid-operation cannot change the age', async () => {
    // Every read of the clock during one registration must be the same read.
    // Otherwise somebody submitting at 23:59:59.9 could be judged against
    // today and recorded against tomorrow — or have a birthday mid-request.
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    setTimezone(event.id, 'UTC');

    const readings: number[] = [];
    const RealDate = Date;

    // The instants are DERIVED from the real clock; writing a calendar date in
    // here is what broke this test once already. `seedEvent` opens registration
    // at `now - 1 day`, so a fixed date drifts outside that window as the real
    // date advances, and the registration is then refused with
    // REGISTRATION_NOT_STARTED before the property under test is ever reached —
    // a green test rotting into a red one that blames the wrong thing.
    //
    // The next UTC midnight is always strictly after now and at most one day
    // ahead, so it always falls inside the seeded window.
    const midnightAfter = (from: number): number => {
      const midnight =
        RealDate.parse(`${new RealDate(from).toISOString().slice(0, 10)}T00:00:00.000Z`) + DAY;
      // A 29 February boundary would need a birth date of 29 February in a year
      // that need not have one. The next day is just as good a boundary, is
      // always a real date, and is still well inside the window.
      return new RealDate(midnight).toISOString().slice(5, 10) === '02-29'
        ? midnight + DAY
        : midnight;
    };

    const targetMidnight = midnightAfter(RealDate.now());
    // The civil day that BEGINS at that midnight. The event's zone is UTC (set
    // above), so the UTC calendar day is the event's calendar day.
    const targetCivilDate = new RealDate(targetMidnight).toISOString().slice(0, 10);
    // Turns 21 on `targetCivilDate`: 20 the millisecond before it, 21 from it.
    const dateOfBirth = `${Number(targetCivilDate.slice(0, 4)) - 21}${targetCivilDate.slice(4)}`;

    // One millisecond before midnight, then midnight, then the day after.
    const instants = [targetMidnight - 1, targetMidnight, targetMidnight + DAY];
    let index = 0;

    class DriftingDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) {
          const value = instants[Math.min(index++, instants.length - 1)];
          readings.push(value);
          super(value);
          return;
        }
        super(...(args as []));
      }
      static now() {
        const value = instants[Math.min(index++, instants.length - 1)];
        readings.push(value);
        return value;
      }
    }
    globalThis.Date = DriftingDate as unknown as DateConstructor;

    try {
      const result = await service.register(
        event.id,
        answersFor(version, { date_of_birth: dateOfBirth }),
        actor(),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');

      // The clock genuinely DRIFTED during the operation. Without this the rest
      // of the assertions could pass simply because nothing ever read the clock
      // a second time, and the test would be proving nothing.
      expect(readings.length).toBeGreaterThan(1);
      expect(readings[0]).toBe(instants[0]);
      expect(readings[1]).toBe(instants[1]);

      // The FIRST reading is the authoritative one; a second reading would have
      // made this person 21 instead of 20.
      expect(result.value.entry.calculatedAge).toBe(20);
      expect(result.value.entry.status).toBe('INELIGIBLE');
      // And the recorded submission moment is that same instant.
      expect(result.value.entry.submittedAt).toBe(
        new RealDate(instants[0]).toISOString(),
      );
    } finally {
      globalThis.Date = RealDate;
    }
  });
});

// ---------------------------------------------------------------------------
describe('the event’s zone is the authority for "today"', () => {
  const eligibility = new EligibilityService();

  it('decides by the local calendar in every zone the contract names', () => {
    // 03:30 UTC on the 8th. Somebody whose 21st birthday is the 8th.
    const now = new Date('2026-08-08T03:30:00.000Z');
    const expectations: Record<string, number> = {
      UTC: 21,
      'Asia/Tokyo': 21,
      'Pacific/Kiritimati': 21,
      'Europe/London': 21,
      'America/New_York': 20,
      'America/Los_Angeles': 20,
      'Pacific/Honolulu': 20,
    };

    for (const [timezone, expected] of Object.entries(expectations)) {
      const result = eligibility.evaluate({
        event: { id: 'e', minimumAge: 21, timezone },
        versionSteps: [],
        dateOfBirth: '2005-08-08',
        now,
      });
      if (!result.ok) throw new Error(`${timezone}: ${JSON.stringify(result.failure)}`);
      expect(result.decision.calculatedAge, timezone).toBe(expected);
      expect(result.decision.overallEligible, timezone).toBe(expected >= 21);
    }
  });

  it('a birthday that is "tomorrow" locally is a date in the FUTURE locally', async () => {
    // The date is today at UTC+14 and tomorrow in Honolulu. The event's zone
    // decides, so a Honolulu event must refuse it.
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setTimezone(event.id, 'Pacific/Honolulu');
    setMinimumAge(event.id, 21);

    const tomorrowInKiritimati = civilDateInEventZone(
      new Date(Date.now() + DAY),
      'Pacific/Kiritimati',
    );
    const result = await service.register(
      event.id,
      answersFor(version, { date_of_birth: tomorrowInKiritimati }),
      actor(),
    );
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('survives both DST transitions without moving the day', () => {
    for (const [instant, expected] of [
      // Spring forward in New York: 02:00 local does not exist on 2026-03-08.
      ['2026-03-08T06:59:00.000Z', '2026-03-08'],
      ['2026-03-08T07:01:00.000Z', '2026-03-08'],
      // Fall back: 01:00 local happens twice on 2026-11-01.
      ['2026-11-01T05:30:00.000Z', '2026-11-01'],
      ['2026-11-01T06:30:00.000Z', '2026-11-01'],
    ] as const) {
      expect(civilDateInEventZone(new Date(instant), 'America/New_York'), instant).toBe(expected);
    }

    // And the age never comes from a duration: a year containing a DST shift is
    // still exactly one year.
    expect(calculateAgeOnDate('2005-03-08', '2026-03-08')).toBe(21);
    expect(calculateAgeOnDate('2005-11-01', '2026-11-01')).toBe(21);
  });
});

// ---------------------------------------------------------------------------
describe('a timezone that is not one', () => {
  it('cannot even be STORED when it is empty or unbounded', async () => {
    // The column CHECK is the first line: a zone must be 1..64 characters.
    const { event } = await seedEvent();
    for (const corrupt of ['', 'x'.repeat(200)]) {
      expect(() => setTimezone(event.id, corrupt), JSON.stringify(corrupt)).toThrow(/CHECK/i);
    }
  });

  it('is refused rather than falling back to UTC, in every storable corrupt shape', async () => {
    // `+05:30` matters most: modern runtimes RESOLVE a raw offset, so Intl
    // alone would accept it — and an offset does not observe daylight saving.
    for (const corrupt of ['   ', 'Mars/Olympus_Mons', '+05:30', '-0500', 'Not/AZone']) {
      db.close();
      db = createTestDatabase();
      service = new ParticipantRegistrationService(db.d1);
      publishing = new FormPublishingService(db.d1);
      drafts = new FormDraftService(db.d1);
      events = new EventLifecycleService(db.d1);
      const seeded = await new AdminRepository(db.d1).create({
        email: 'ada@example.com',
        normalizedEmail: normalizeEmail('ada@example.com'),
        displayName: 'Ada Lovelace',
        passwordHash: await hashPassword('a-strong-admin-password'),
      });
      if (seeded.kind !== 'created') throw new Error('admin seed failed');
      admin = { ...admin, id: seeded.admin.id };

      const { event, version } = await seedEvent([DOB_QUESTION]);
      setMinimumAge(event.id, 21);
      setTimezone(event.id, corrupt);

      const result = await service.register(
        event.id,
        answersFor(version, { date_of_birth: dobForAge(30) }),
        actor(),
      );
      expect(result.ok, JSON.stringify(corrupt)).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code, JSON.stringify(corrupt)).toBe('FORM_VERSION_INVALID');
      expect(count('SELECT COUNT(*) AS n FROM event_entries'), corrupt).toBe(0);
      // A controlled refusal, not an exception escaping with a stack.
      expect(JSON.stringify(result.failure)).not.toMatch(/at .*\.ts:\d+/);
    }
  });
});

// ---------------------------------------------------------------------------
describe('habits are data, never rules', () => {
  it('the same age decides the same way for all four combinations', async () => {
    const results: Array<{ label: string; eligible: boolean; age: number | null }> = [];

    for (const [smoker, drinker] of [
      ['yes', 'yes'],
      ['yes', 'no'],
      ['no', 'yes'],
      ['no', 'no'],
    ] as const) {
      const { event, version } = await seedEvent([DOB_QUESTION, ...HABITS]);
      setMinimumAge(event.id, 21);

      const result = await service.register(
        event.id,
        answersFor(version, {
          date_of_birth: dobForAge(30),
          smoker_status: smoker,
          drinker_status: drinker,
          email: `${smoker}-${drinker}@example.com`,
        }),
        actor(),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.failure));
      results.push({
        label: `${smoker}/${drinker}`,
        eligible: result.value.entry.overallEligible!,
        age: result.value.entry.calculatedAge,
      });
    }

    // Four different answers, one identical verdict.
    expect(results.every((entry) => entry.eligible)).toBe(true);
    expect(new Set(results.map((entry) => entry.age)).size).toBe(1);
  });

  it('and the same is true when the age fails', async () => {
    const verdicts = new Set<string>();
    for (const [smoker, drinker] of [
      ['yes', 'yes'],
      ['no', 'no'],
    ] as const) {
      const { event, version } = await seedEvent([DOB_QUESTION, ...HABITS]);
      setMinimumAge(event.id, 21);
      const result = await service.register(
        event.id,
        answersFor(version, {
          date_of_birth: dobForAge(18),
          smoker_status: smoker,
          drinker_status: drinker,
          email: `${smoker}-${drinker}-young@example.com`,
        }),
        actor(),
      );
      if (!result.ok) throw new Error(JSON.stringify(result.failure));
      verdicts.add(`${result.value.entry.status}:${result.value.entry.eligibilityReason}`);
    }
    expect([...verdicts]).toEqual(['INELIGIBLE:AGE_REQUIREMENT_NOT_MET']);
  });
});

// ---------------------------------------------------------------------------
describe('a participation recorded before eligibility existed', () => {
  it('is read exactly as it was written, and never re-judged', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);

    // A phase 7 row, written directly as that phase wrote them.
    const now = new Date().toISOString();
    const participantId = crypto.randomUUID();
    const entryId = crypto.randomUUID();
    db.raw
      .prepare(
        `INSERT INTO participants
           (id, email, normalized_email, first_name, last_name, created_at, updated_at)
         VALUES (?, 'Old@Example.com', 'old@example.com', 'Old', 'Row', ?, ?)`,
      )
      .run(participantId, now, now);
    db.raw
      .prepare(
        `INSERT INTO event_entries
           (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)`,
      )
      .run(entryId, event.id, participantId, version.id, now, now, now);

    const detail = await service.detail(event.id, entryId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error('unreachable');
    expect(detail.value.entry.status).toBe('SUBMITTED');
    expect(detail.value.entry.overallEligible).toBeNull();
    expect(detail.value.entry.ageEligible).toBeNull();
    expect(detail.value.entry.calculatedAge).toBeNull();
    expect(detail.value.entry.eligibilityReason).toBeNull();

    // Listing it does not judge it either.
    const list = await service.list(event.id, { page: 1, pageSize: 25, search: null });
    if (!list.ok) throw new Error('unreachable');
    expect(list.value.items[0].status).toBe('SUBMITTED');
    expect(list.value.items[0].overallEligible).toBeNull();

    // And reading it changed nothing on disk.
    const stored = db.raw
      .prepare('SELECT status, overall_eligible AS o, updated_at AS u FROM event_entries WHERE id = ?')
      .get(entryId) as { status: string; o: number | null; u: string };
    expect(stored.status).toBe('SUBMITTED');
    expect(stored.o).toBeNull();
    expect(stored.u).toBe(now);
  });
});

// ---------------------------------------------------------------------------
describe('a refused submission leaves nothing at all', () => {
  it('an existing participant is not even touched when the date is impossible', async () => {
    // The profile update lives inside the batch, so a rejection that happens
    // BEFORE the batch must not have written anything either.
    const first = await seedEvent([DOB_QUESTION]);
    setMinimumAge(first.event.id, 21);
    const created = await service.register(
      first.event.id,
      answersFor(first.version, { date_of_birth: '1990-03-15' }),
      actor(),
    );
    if (!created.ok) throw new Error('unreachable');
    const before = created.value.participant;

    const second = await seedEvent([DOB_QUESTION]);
    setMinimumAge(second.event.id, 21);
    const rejected = await service.register(
      second.event.id,
      answersFor(second.version, { date_of_birth: '1800-01-01', first_name: 'Renamed' }),
      actor(),
    );
    expect(rejected.ok).toBe(false);

    const stored = db.raw
      .prepare('SELECT first_name AS f, updated_at AS u, date_of_birth AS d FROM participants WHERE id = ?')
      .get(before.id) as { f: string; u: string; d: string };
    expect(stored.f).toBe('Ana');
    expect(stored.u).toBe(before.updatedAt);
    expect(stored.d).toBe('1990-03-15');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });

  it('an audit row is never written for a registration that did not happen', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    await service.register(
      event.id,
      answersFor(version, { date_of_birth: '2099-01-01' }),
      actor(),
    );
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'")).toBe(
      0,
    );
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'PARTICIPANT_CREATED'")).toBe(
      0,
    );
  });
});

// ---------------------------------------------------------------------------
describe('atomicity under an injected failure', () => {
  /** Fails the batch by corrupting the statement at `position`. */
  async function failAt(position: number) {
    const { event, version } = await seedEvent([DOB_QUESTION, ...HABITS]);
    setMinimumAge(event.id, 21);

    const breaking = {
      prepare: (sql: string) => db.d1.prepare(sql),
      exec: (sql: string) => db.d1.exec(sql),
      batch: (statements: unknown[]) => {
        const doomed = [...(statements as unknown[])];
        if (position < doomed.length) {
          // A statement that always fails, standing where the real one was.
          doomed[position] = db.d1.prepare('INSERT INTO participants (id) VALUES (NULL)');
        }
        return db.d1.batch(doomed as never);
      },
    } as unknown as D1Database;

    const result = await new ParticipantRegistrationService(breaking).register(
      event.id,
      answersFor(version, {
        date_of_birth: dobForAge(30),
        smoker_status: 'no',
        drinker_status: 'no',
      }),
      actor(),
    );
    return result;
  }

  it('leaves no partial state wherever the batch breaks', async () => {
    // Guard, participant, entry, answers, audit: whichever fails, none of it
    // happened.
    for (const position of [0, 1, 2, 3, 4, 5]) {
      db.close();
      db = createTestDatabase();
      service = new ParticipantRegistrationService(db.d1);
      publishing = new FormPublishingService(db.d1);
      drafts = new FormDraftService(db.d1);
      events = new EventLifecycleService(db.d1);
      const seeded = await new AdminRepository(db.d1).create({
        email: 'ada@example.com',
        normalizedEmail: normalizeEmail('ada@example.com'),
        displayName: 'Ada Lovelace',
        passwordHash: await hashPassword('a-strong-admin-password'),
      });
      if (seeded.kind !== 'created') throw new Error('admin seed failed');
      admin = { ...admin, id: seeded.admin.id };

      const result = await failAt(position);
      expect(result.ok, `position ${position}`).toBe(false);
      expect(count('SELECT COUNT(*) AS n FROM participants'), `position ${position}`).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM event_entries'), `position ${position}`).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM event_entry_answers'), `position ${position}`).toBe(
        0,
      );
      expect(
        count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'"),
        `position ${position}`,
      ).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the boundary cases the contract names', () => {
  it('exactly 130 is a person; 131 is bad input', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 130);

    const exactly = await service.register(
      event.id,
      answersFor(version, { date_of_birth: dobForAge(130) }),
      actor(),
    );
    expect(exactly.ok).toBe(true);
    if (!exactly.ok) throw new Error('unreachable');
    expect(exactly.value.entry.calculatedAge).toBe(130);
    expect(exactly.value.entry.overallEligible).toBe(true);

    const beyond = await seedEvent([DOB_QUESTION]);
    setMinimumAge(beyond.event.id, 130);
    const tooOld = await service.register(
      beyond.event.id,
      answersFor(beyond.version, {
        date_of_birth: dobForAge(131),
        email: 'ancient@example.com',
      }),
      actor(),
    );
    // Not "ineligible because too old" — bad input, which records nothing.
    expect(tooOld.ok).toBe(false);
    if (tooOld.ok) throw new Error('unreachable');
    expect(tooOld.failure.code).toBe('DATE_OF_BIRTH_INVALID');
  });

  it('the day before a 21st birthday fails and the day itself passes', async () => {
    const eligibility = new EligibilityService();
    const event = { id: 'e', minimumAge: 21, timezone: 'UTC' } as const;

    const before = eligibility.evaluate({
      event,
      versionSteps: [],
      dateOfBirth: '2005-08-08',
      now: new Date('2026-08-07T12:00:00.000Z'),
    });
    const onTheDay = eligibility.evaluate({
      event,
      versionSteps: [],
      dateOfBirth: '2005-08-08',
      now: new Date('2026-08-08T12:00:00.000Z'),
    });

    if (!before.ok || !onTheDay.ok) throw new Error('unreachable');
    expect(before.decision.calculatedAge).toBe(20);
    expect(before.decision.overallEligible).toBe(false);
    expect(onTheDay.decision.calculatedAge).toBe(21);
    expect(onTheDay.decision.overallEligible).toBe(true);
  });

  it('somebody born on 29 February turns 21 on 1 March, not 28 February', () => {
    const eligibility = new EligibilityService();
    const event = { id: 'e', minimumAge: 21, timezone: 'UTC' } as const;

    const results = ['2025-02-27', '2025-02-28', '2025-03-01'].map((day) => {
      const outcome = eligibility.evaluate({
        event,
        versionSteps: [],
        dateOfBirth: '2004-02-29',
        now: new Date(`${day}T12:00:00.000Z`),
      });
      if (!outcome.ok) throw new Error('unreachable');
      return outcome.decision.overallEligible;
    });
    expect(results).toEqual([false, false, true]);
  });
});

// ---------------------------------------------------------------------------
describe('a fixed offset is not a timezone', () => {
  it('is refused even though the runtime would resolve it', () => {
    // The module's own rule: never store an offset, because offsets change
    // twice a year and identifiers do not. Intl accepts `+05:30`; the domain
    // must not, or an event would silently stop observing daylight saving.
    for (const offset of ['+05:30', '-05:00', '+0000', '-0500', '+14:00']) {
      expect(isValidTimeZone(offset), offset).toBe(false);
    }
  });

  it('still accepts the real identifiers that merely look unusual', () => {
    for (const zone of [
      'UTC',
      'Etc/GMT+5',
      'Etc/UTC',
      'America/Argentina/Buenos_Aires',
      'Asia/Ho_Chi_Minh',
      'Pacific/Kiritimati',
    ]) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });

  it('an event cannot be created with one through the service', async () => {
    const made = await events.create(
      {
        name: 'Offset event',
        timezone: '+05:30',
        registrationOpensAt: at(-1),
        registrationClosesAt: at(5),
        startsAt: at(6),
        endsAt: at(7),
      },
      actor(),
    );
    expect(made.ok).toBe(false);
  });

  it('and one already stored is refused at decision time, not defaulted', async () => {
    const { event, version } = await seedEvent([DOB_QUESTION]);
    setMinimumAge(event.id, 21);
    setTimezone(event.id, '+05:30');

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
});

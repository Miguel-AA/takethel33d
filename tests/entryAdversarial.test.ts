// @vitest-environment node
//
// Adversarial validation of phase 7.
//
// Everything here is an attack on a defence the implementation claims to have.
// A test that passes here is not proof the feature works — it is proof that the
// specific way of breaking it does not work.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParticipantRegistrationService } from '../functions/_shared/participantRegistrationService';
import { ParticipantRepository } from '../functions/_shared/participantRepository';
import { EntryAnswerRepository } from '../functions/_shared/entryAnswerRepository';
import { FormPublishingService } from '../functions/_shared/formPublishingService';
import { FormDraftService } from '../functions/_shared/formDraftService';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import {
  latestPossibleBirthDate,
  validateAnswerForQuestion,
} from '../shared/formAnswers';
import { ANSWERS_PER_ENTRY_MAX } from '../shared/limits';
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
let event: Event;
let version: EventFormVersion;

const REQUEST: RequestContext = {
  requestId: 'req-adversarial',
  ipHash: 'b'.repeat(64),
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

async function seedOpenEvent(
  extra: Array<Record<string, unknown>> = [],
): Promise<{ event: Event; version: EventFormVersion }> {
  const made = await events.create(
    {
      name: 'Adversarial Event',
      registrationOpensAt: at(-1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    },
    actor(),
  );
  if (!made.ok) throw new Error('event seed failed');
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

function answersFor(
  target: EventFormVersion,
  overrides: Record<string, unknown> = {},
): SubmittedAnswer[] {
  const values: Record<string, unknown> = {
    first_name: 'Ana',
    last_name: 'Lopez',
    email: 'Ana@Example.com',
    ...overrides,
  };
  const byKey = new Map(
    target.steps.flatMap((step) => step.questions).map((question) => [question.key, question]),
  );
  return Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const question = byKey.get(key);
      if (!question) throw new Error(`no question keyed ${key}`);
      return { questionId: question.id, value };
    });
}

const identityAnswers = (overrides: Record<string, unknown> = {}) =>
  answersFor(version, overrides);

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

  const seeded = await seedOpenEvent();
  event = seeded.event;
  version = seeded.version;
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('a date of birth in the future', () => {
  it('is refused as an answer, not deferred to the eligibility phase', async () => {
    const seeded = await seedOpenEvent([DOB_QUESTION]);
    event = seeded.event;
    version = seeded.version;

    const future = new Date(Date.now() + 365 * DAY).toISOString().slice(0, 10);
    const result = await service.register(
      event.id,
      identityAnswers({ date_of_birth: future }),
      actor(),
    );

    // Being born tomorrow is not a fact about a person that a later phase can
    // interpret — it is structurally impossible, and storing it would put a
    // negative age into the eligibility rule that reads this column.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_INVALID');
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
  });

  it('refuses TODAY as a date of birth only if the contract says so, and accepts yesterday', async () => {
    const seeded = await seedOpenEvent([DOB_QUESTION]);
    event = seeded.event;
    version = seeded.version;

    const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
    const result = await service.register(
      event.id,
      identityAnswers({ date_of_birth: yesterday }),
      actor(),
    );
    expect(result.ok).toBe(true);
  });

  it('a plain DATE question still accepts a future day', async () => {
    // The rule belongs to the SYSTEM FIELD, not to the type. "When can you
    // attend?" is a perfectly good question about the future.
    const seeded = await seedOpenEvent([
      { type: 'DATE', label: 'Preferred date', key: 'preferred_date' },
    ]);
    event = seeded.event;
    version = seeded.version;

    const future = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    const result = await service.register(
      event.id,
      identityAnswers({ preferred_date: future }),
      actor(),
    );
    expect(result.ok).toBe(true);
  });

  it('the DATABASE cannot express the rule, and does not pretend to', () => {
    // A CHECK constraint must be deterministic, so `date('now')` is not
    // available and a bound baked in at migration time would expire. The column
    // therefore accepts a future date written directly — which is exactly why
    // the rule has to live in the domain layer, where it can be enforced
    // honestly, rather than being assumed to be somebody else's job.
    const now = new Date().toISOString();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO participants
             (id, email, normalized_email, first_name, last_name, date_of_birth, created_at, updated_at)
           VALUES (?, 'x@y.com', 'x@y.com', 'A', 'B', '2999-01-01', ?, ?)`,
        )
        .run(crypto.randomUUID(), now, now),
    ).not.toThrow();

    // And such a row stays READABLE. Making it throw would turn a fixable data
    // problem into a person nobody can look at.
    expect(() => new ParticipantRepository(db.d1).findByNormalizedEmail('x@y.com')).not.toThrow();
  });

  it('the bound allows the furthest-ahead timezone, and nothing beyond it', () => {
    const noon = Date.parse('2026-06-15T12:00:00.000Z');
    // At UTC+14 it is already the 16th, so somebody born "today" there is not
    // born in the future.
    expect(latestPossibleBirthDate(noon)).toBe('2026-06-16');
    // And a day beyond that is refused everywhere on earth.
    const question = {
      type: 'DATE',
      systemField: 'DATE_OF_BIRTH',
      required: true,
      validation: null,
    } as const;
    expect(validateAnswerForQuestion(question, [], '2026-06-16', noon).ok).toBe(true);
    const refused = validateAnswerForQuestion(question, [], '2026-06-17', noon);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.problem).toBe('DATE_IN_FUTURE');
  });
});

// ---------------------------------------------------------------------------
describe('email identity', () => {
  it('resolves every casing and surrounding space to one identity', async () => {
    const first = await service.register(
      event.id,
      identityAnswers({ email: 'Test@Example.com' }),
      actor(),
    );
    if (!first.ok) throw new Error('unreachable');

    for (const variant of [' test@example.com', 'TEST@example.com', 'TeSt@ExAmPlE.cOm ']) {
      const other = await seedOpenEvent();
      event = other.event;
      version = other.version;
      const again = await service.register(
        event.id,
        identityAnswers({ email: variant }),
        actor(),
      );
      expect(again.ok, variant).toBe(true);
      if (!again.ok) throw new Error('unreachable');
      expect(again.value.participant.id, variant).toBe(first.value.participant.id);
    }
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
  });

  it('does NOT merge addresses the provider happens to treat as equal', async () => {
    // Dots and plus-addressing are Gmail policy, not email semantics. Folding
    // them here would merge two people the moment a provider that treats them
    // as distinct is used — and merging two people is unrecoverable.
    await service.register(
      event.id,
      identityAnswers({ email: 'john.smith@gmail.com' }),
      actor(),
    );

    for (const variant of ['johnsmith@gmail.com', 'john.smith+events@gmail.com']) {
      const other = await seedOpenEvent();
      event = other.event;
      version = other.version;
      const again = await service.register(
        event.id,
        identityAnswers({ email: variant }),
        actor(),
      );
      expect(again.ok, variant).toBe(true);
    }
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(3);
  });

  it('the same normalisation is used by the schema, the service and the store', async () => {
    const created = await service.register(
      event.id,
      identityAnswers({ email: '  Ana@Example.com  ' }),
      actor(),
    );
    if (!created.ok) throw new Error('unreachable');

    // What the service wrote is exactly what `normalizeEmail` produces, and the
    // repository finds it with that same value and no other.
    expect(created.value.participant.normalizedEmail).toBe(
      normalizeEmail('  Ana@Example.com  '),
    );
    const repository = new ParticipantRepository(db.d1);
    expect((await repository.findByNormalizedEmail('ana@example.com'))?.id).toBe(
      created.value.participant.id,
    );
    expect(await repository.findByNormalizedEmail('Ana@Example.com')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the identity race', () => {
  it('a lost race produces one participant, never two and never a 500', async () => {
    const racing = interposing(() => {
      const now = new Date().toISOString();
      db.raw
        .prepare(
          `INSERT INTO participants
             (id, email, normalized_email, first_name, last_name, created_at, updated_at)
           VALUES (?, 'Ana@Example.com', 'ana@example.com', 'Ana', 'Lopez', ?, ?)`,
        )
        .run(crypto.randomUUID(), now, now);
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });

  it('a SECOND unexpected collision gives up instead of retrying forever', async () => {
    // A participant row that appears, is used, and then vanishes before the
    // retry. Nothing real does this; the point is that the retry is bounded.
    let attempts = 0;
    const racing = {
      prepare: (sql: string) => db.d1.prepare(sql),
      exec: (sql: string) => db.d1.exec(sql),
      batch: (statements: unknown[]) => {
        attempts += 1;
        const now = new Date().toISOString();
        db.raw
          .prepare(
            `INSERT OR IGNORE INTO participants
               (id, email, normalized_email, first_name, last_name, created_at, updated_at)
             VALUES (?, 'Ana@Example.com', 'ana@example.com', 'Ana', 'Lopez', ?, ?)`,
          )
          .run(crypto.randomUUID(), now, now);
        db.raw.prepare('DELETE FROM participants WHERE normalized_email = ?').run('ana@example.com');
        db.raw
          .prepare(
            `INSERT INTO participants
               (id, email, normalized_email, first_name, last_name, created_at, updated_at)
             VALUES (?, 'Ana@Example.com', 'ana@example.com', 'Ana', 'Lopez', ?, ?)`,
          )
          .run(crypto.randomUUID(), now, now);
        return db.d1.batch(statements as never);
      },
    } as unknown as D1Database;

    const result = await new ParticipantRegistrationService(racing).register(
      event.id,
      identityAnswers(),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('ENTRY_CREATE_FAILED');
    // Bounded: one attempt plus one retry, and no more.
    expect(attempts).toBeLessThanOrEqual(2);
  });

  it('two simultaneous first-time submissions with CONFLICTING dates of birth', async () => {
    // The dangerous shape: neither sees an existing identity, so neither can
    // detect a conflict up front. Whichever loses must NOT quietly attach an
    // entry to an identity whose date of birth is not the one it submitted.
    const first = await seedOpenEvent([DOB_QUESTION]);
    const second = await seedOpenEvent([DOB_QUESTION]);

    const results = await Promise.all([
      service.register(
        first.event.id,
        answersFor(first.version, { date_of_birth: '1990-01-01' }),
        actor(),
      ),
      service.register(
        second.event.id,
        answersFor(second.version, { date_of_birth: '1991-01-01' }),
        actor(),
      ),
    ]);

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const loser = losers[0];
    if (loser.ok) throw new Error('unreachable');
    expect(loser.failure.code).toBe('PARTICIPANT_IDENTITY_CONFLICT');

    // One identity, one date of birth, one entry — and the entry that landed
    // belongs to the submission whose date of birth was kept.
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    const stored = db.raw
      .prepare('SELECT date_of_birth AS dob FROM participants')
      .get() as { dob: string };
    const winner = winners[0];
    if (!winner.ok) throw new Error('unreachable');
    expect(winner.value.participant.dateOfBirth).toBe(stored.dob);
  });
});

// ---------------------------------------------------------------------------
describe('races against the event', () => {
  it('a registration whose WINDOW closes mid-batch writes nothing', async () => {
    // The event stays OPEN throughout: only the clock crosses the closing
    // instant. A guard that checked the status alone would let this land.
    const racing = interposing(() => {
      const past = new Date(Date.now() - 1000).toISOString();
      db.raw
        .prepare('UPDATE events SET registration_closes_at = ? WHERE id = ?')
        .run(past, event.id);
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_NOT_ACCEPTING_ENTRIES');

    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'")).toBe(
      0,
    );
    // And the event itself survived the guard that fired.
    const stored = db.raw
      .prepare('SELECT status FROM events WHERE id = ?')
      .get(event.id) as { status: string };
    expect(stored.status).toBe('OPEN');
  });

  it('a registration whose window OPENS in the future mid-batch writes nothing', async () => {
    const racing = interposing(() => {
      db.raw
        .prepare('UPDATE events SET registration_opens_at = ? WHERE id = ?')
        .run(at(1), event.id);
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('an EXISTING participant is not left half-updated when the guard fires', async () => {
    // The profile update is inside the batch, so a race must not refresh
    // somebody's name for a registration that never happened.
    const other = await seedOpenEvent();
    const created = await service.register(other.event.id, answersFor(other.version), actor());
    if (!created.ok) throw new Error('unreachable');

    const racing = interposing(() => {
      db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);
    });
    const result = await racing.register(
      event.id,
      identityAnswers({ first_name: 'Renamed' }),
      actor(),
    );
    expect(result.ok).toBe(false);

    const stored = await new ParticipantRepository(db.d1).findById(created.value.participant.id);
    expect(stored?.firstName).toBe('Ana');
    expect(stored?.updatedAt).toBe(created.value.participant.updatedAt);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });

  it('the guard fires for every state, not only CLOSED', async () => {
    for (const status of ['DRAFT', 'SCHEDULED', 'DRAW_READY', 'CANCELLED', 'ARCHIVED']) {
      const seeded = await seedOpenEvent();
      const racing = interposing(() => {
        db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, seeded.event.id);
      });
      const result = await racing.register(
        seeded.event.id,
        answersFor(seeded.version, { email: `${status}@example.com` }),
        actor(),
      );
      expect(result.ok, status).toBe(false);
    }
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('races against the form version', () => {
  it('publishing v2 mid-registration leaves the entry on v1', async () => {
    const racing = interposing(() => {
      // A second publication lands between resolving the version and writing
      // the entry. Re-reading the pointer at insert time would produce an entry
      // whose answers were checked against one form and recorded against
      // another.
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
        .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
        .run(v2, event.id);
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.entry.formVersionId).toBe(version.id);

    // Every answer points at a question of THAT version, not of the new one.
    const answers = await new EntryAnswerRepository(db.d1).listByEntry(result.value.entry.id);
    const owners = db.raw
      .prepare(
        `SELECT DISTINCT form_owner_id AS owner FROM form_questions
          WHERE id IN (${answers.map(() => '?').join(',')})`,
      )
      .all(...answers.map((answer) => answer.questionId)) as Array<{ owner: string }>;
    expect(owners).toEqual([{ owner: version.id }]);
  });

  it('the pointer being made foreign mid-registration does not re-home the entry', async () => {
    const other = await seedOpenEvent();
    const racing = interposing(() => {
      db.raw
        .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
        .run(other.version.id, event.id);
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    // Whatever happens, an entry must never be bound to another event's form.
    if (result.ok) {
      expect(result.value.entry.formVersionId).toBe(version.id);
    }
    const rows = db.raw
      .prepare('SELECT form_version_id AS v FROM event_entries WHERE event_id = ?')
      .all(event.id) as Array<{ v: string }>;
    for (const row of rows) expect(row.v).toBe(version.id);
  });

  it('a version gutted after it was loaded does not produce a half-validated entry', async () => {
    // The service works from the structure it already loaded. Deleting rows
    // underneath it must not silently drop answers or change what was required.
    const racing = interposing(() => {
      db.raw
        .prepare("DELETE FROM form_questions WHERE form_owner_type = 'VERSION' AND key = 'email'")
        .run();
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    // The answer row references a question that no longer exists, so the
    // foreign key refuses the whole batch rather than storing an orphan.
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('what a caller cannot decide', () => {
  it('the caller never chooses the verdict', async () => {
    const result = await service.register(event.id, identityAnswers(), actor());
    if (!result.ok) throw new Error('unreachable');
    // The status is DERIVED from the decision; `register` takes answers and an
    // actor, and nothing that could name a status.
    expect(result.value.entry.status).toBe('ELIGIBLE');

    const names = Object.getOwnPropertyNames(
      Object.getPrototypeOf(service as unknown as Record<string, unknown>),
    );
    expect(names.filter((name) => /status|eligib/i.test(name))).toEqual([]);
  });

  it('an entry is never written before it has a verdict', async () => {
    await service.register(event.id, identityAnswers(), actor());
    const row = db.raw
      .prepare(
        `SELECT status, calculated_age, age_eligible, overall_eligible, eligibility_reason
           FROM event_entries LIMIT 1`,
      )
      .get() as Record<string, unknown>;
    // Decided in the same statement that created it: there is no moment at
    // which a participation exists unjudged.
    expect(row.status).toBe('ELIGIBLE');
    expect(row.overall_eligible).toBe(1);
    expect(row.eligibility_reason).toBe('ELIGIBLE');
    expect(row.age_eligible).toBeNull();
  });

  it('an age is computed and recorded when the form asks, even with no age rule', async () => {
    const seeded = await seedOpenEvent([DOB_QUESTION]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(
      event.id,
      identityAnswers({ date_of_birth: '1990-01-01' }),
      actor(),
    );
    if (!result.ok) throw new Error('unreachable');
    // The age is a fact worth recording. What stays null is the JUDGEMENT,
    // because this event has no minimum age to judge against.
    expect(result.value.entry.calculatedAge).toBeGreaterThan(30);
    expect(result.value.entry.ageEligible).toBeNull();
    expect(result.value.entry.overallEligible).toBe(true);
    expect(result.value.participant.dateOfBirth).toBe('1990-01-01');
  });

  it('cannot smuggle a raw IP address into the entry', async () => {
    // `ip_hash` is CHECKed at 64 characters, so a context carrying a raw
    // address fails the insert instead of persisting one.
    const leaky = {
      admin,
      requestContext: { ...REQUEST, ipHash: '203.0.113.7' },
    };
    const result = await service.register(event.id, identityAnswers(), leaky);
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('answer payload limits', () => {
  it('accepts exactly the maximum and refuses one more', async () => {
    const extra = Array.from({ length: ANSWERS_PER_ENTRY_MAX - 3 }, (_, index) => ({
      type: 'SHORT_TEXT',
      label: `Custom ${index}`,
      key: `custom_${index}`,
    }));
    const seeded = await seedOpenEvent(extra);
    event = seeded.event;
    version = seeded.version;

    const all = seeded.version.steps.flatMap((step) => step.questions);
    expect(all).toHaveLength(ANSWERS_PER_ENTRY_MAX);

    const result = await service.register(
      event.id,
      all.map((question) => ({
        questionId: question.id,
        value: question.type === 'EMAIL' ? 'Ana@Example.com' : 'x',
      })),
      actor(),
    );
    expect(result.ok).toBe(true);
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(ANSWERS_PER_ENTRY_MAX);
  });

  it('a duplicate-heavy flood is refused as duplicates, not walked one by one', async () => {
    const target = version.steps[0].questions[0];
    const flood = Array.from({ length: 500 }, () => ({ questionId: target.id, value: 'x' }));
    const result = await service.register(event.id, flood, actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DUPLICATE_FORM_ANSWER');
  });
});

// ---------------------------------------------------------------------------
describe('what gets stored, byte for byte', () => {
  async function storedValue(key: string): Promise<string> {
    const row = db.raw
      .prepare('SELECT answer_value AS v FROM event_entry_answers WHERE question_key = ?')
      .get(key) as { v: string };
    return row.v;
  }

  it('normalises a multi-select to the version’s order, whatever arrived', async () => {
    const seeded = await seedOpenEvent([
      {
        type: 'MULTI_SELECT',
        label: 'Diet',
        key: 'diet',
        options: [
          { value: 'vegan', label: 'Vegan' },
          { value: 'halal', label: 'Halal' },
          { value: 'kosher', label: 'Kosher' },
        ],
      },
    ]);
    event = seeded.event;
    version = seeded.version;

    const first = await service.register(
      event.id,
      identityAnswers({ diet: ['kosher', 'vegan'] }),
      actor(),
    );
    expect(first.ok).toBe(true);
    const stored = await storedValue('diet');
    // Two people who chose the same things produce the same stored bytes.
    expect(stored).toBe('["vegan","kosher"]');
  });

  it('stores each scalar shape as canonical JSON', async () => {
    const seeded = await seedOpenEvent([
      { type: 'NUMBER', label: 'Age group', key: 'age_group' },
      { type: 'YES_NO', label: 'Smoker', key: 'smoker' },
      { type: 'LONG_TEXT', label: 'Notes', key: 'notes' },
    ]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(
      event.id,
      identityAnswers({ age_group: '42', smoker: false, notes: 'line one\r\nline two' }),
      actor(),
    );
    expect(result.ok).toBe(true);

    // A numeric string was accepted, and it is stored as a NUMBER.
    expect(await storedValue('age_group')).toBe('42');
    expect(await storedValue('smoker')).toBe('false');
    // Text survives exactly, control characters escaped rather than dropped.
    expect(JSON.parse(await storedValue('notes'))).toBe('line one\r\nline two');
  });

  it('never stores a value JSON cannot represent', () => {
    const question = { type: 'NUMBER', required: false, validation: null } as const;
    for (const hostile of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(validateAnswerForQuestion(question, [], hostile).ok, String(hostile)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('hostile text survives as text', () => {
  it('stores and returns markup, control characters and bidi marks unchanged', async () => {
    const seeded = await seedOpenEvent([{ type: 'LONG_TEXT', label: 'Notes', key: 'notes' }]);
    event = seeded.event;
    version = seeded.version;

    const hostile = '<script>alert(1)</script>\r\n‮mirror‬  " \\ é';
    const result = await service.register(event.id, identityAnswers({ notes: hostile }), actor());
    if (!result.ok) throw new Error('unreachable');

    const answers = await new EntryAnswerRepository(db.d1).listByEntry(result.value.entry.id);
    const notes = answers.find((answer) => answer.questionKey === 'notes');
    // Round-trips exactly. Sanitising here would corrupt what somebody wrote;
    // the renderer is what must not execute it.
    expect(notes?.value).toBe(hostile);
  });

  it('a question KEY that looks like a prototype vector cannot exist', async () => {
    // Refused when the question is named, so no answer set can ever be keyed by
    // one. The reserved list is the defence; this proves it still holds.
    const ensured = await drafts.ensure(event.id, actor());
    if (!ensured.ok) throw new Error('unreachable');
    const result = await drafts.createQuestion(
      event.id,
      {
        expectedRevision: ensured.value.draft.revision,
        stepId: ensured.value.draft.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'Hostile',
        key: '__proto__',
      } as never,
      actor(),
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('historical answers stay interpretable', () => {
  it('an entry still reads correctly after the draft changes and v2 is published', async () => {
    const seeded = await seedOpenEvent([
      {
        type: 'SINGLE_SELECT',
        label: 'Diet',
        key: 'diet',
        options: [
          { value: 'vegan', label: 'Vegan' },
          { value: 'halal', label: 'Halal' },
          // A third choice, so deactivating one below still leaves a
          // publishable question — publishing refuses a select with fewer than
          // two active options, which is itself the right behaviour.
          { value: 'kosher', label: 'Kosher' },
        ],
      },
    ]);
    event = seeded.event;
    version = seeded.version;

    const created = await service.register(event.id, identityAnswers({ diet: 'vegan' }), actor());
    if (!created.ok) throw new Error('unreachable');

    // Rename the question, deactivate the option they chose, publish v2.
    const draft = await drafts.find(event.id);
    if (!draft.ok || !draft.value.draft) throw new Error('no draft');
    let form = draft.value.draft;
    const dietQuestion = form.steps[0].questions.find((question) => question.key === 'diet')!;
    const renamed = await drafts.updateQuestion(
      event.id,
      dietQuestion.id,
      { expectedRevision: form.revision, label: 'Dietary requirements' },
      actor(),
    );
    if (!renamed.ok) throw new Error(renamed.failure.code);
    form = renamed.value;

    const veganOption = dietQuestion.options.find((option) => option.value === 'vegan')!;
    const deactivated = await drafts.updateOption(
      event.id,
      dietQuestion.id,
      veganOption.id,
      { expectedRevision: form.revision, active: false },
      actor(),
    );
    if (!deactivated.ok) throw new Error(deactivated.failure.code);
    form = deactivated.value;

    const republished = await publishing.publish(event.id, form.revision, actor());
    if (!republished.ok) throw new Error(republished.failure.code);

    // The old entry still answers the form it was actually shown.
    const detail = await service.detail(event.id, created.value.entry.id);
    if (!detail.ok) throw new Error('unreachable');
    expect(detail.value.formVersion.versionNumber).toBe(1);
    const diet = detail.value.answers.find((answer) => answer.questionKey === 'diet');
    expect(diet?.questionLabel).toBe('Diet');
    expect(diet?.value).toBe('vegan');

    // And the option label is still resolvable from the frozen version.
    const frozen = await publishing.getVersion(event.id, created.value.entry.formVersionId);
    if (!frozen.ok) throw new Error('unreachable');
    const option = frozen.value.version.steps
      .flatMap((step) => step.questions)
      .find((question) => question.key === 'diet')!
      .options.find((candidate) => candidate.value === 'vegan');
    expect(option?.label).toBe('Vegan');
    expect(option?.active).toBe(true);
  });

  it('an archived event does not make its entries unreadable', async () => {
    const created = await service.register(event.id, identityAnswers(), actor());
    if (!created.ok) throw new Error('unreachable');

    db.raw.prepare("UPDATE events SET status = 'ARCHIVED' WHERE id = ?").run(event.id);
    const detail = await service.detail(event.id, created.value.entry.id);
    expect(detail.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('the registration window, to the millisecond', () => {
  async function attempt(opens: string | null, closes: string | null) {
    db.raw
      .prepare('UPDATE events SET registration_opens_at = ?, registration_closes_at = ? WHERE id = ?')
      .run(opens, closes, event.id);
    const seeded = await seedOpenEvent();
    // Reuse the same identity in a DIFFERENT event so the duplicate rule never
    // masks a window result.
    void seeded;
    return service.register(event.id, identityAnswers({ email: `w-${crypto.randomUUID()}@x.com` }), actor());
  }

  it('accepts the opening instant and refuses the one before it', async () => {
    const now = Date.now();
    const opensNow = new Date(now).toISOString();
    const opensSoon = new Date(now + 5_000).toISOString();
    const closes = new Date(now + 60_000).toISOString();

    // `opens <= now`: the published time is a promise, so the instant it names
    // must work.
    expect((await attempt(opensNow, closes)).ok).toBe(true);

    const early = await attempt(opensSoon, closes);
    expect(early.ok).toBe(false);
    if (early.ok) throw new Error('unreachable');
    if (early.failure.code !== 'EVENT_NOT_ACCEPTING_ENTRIES') throw new Error('unreachable');
    expect(early.failure.reason).toBe('REGISTRATION_NOT_STARTED');
  });

  it('refuses the closing instant and accepts a millisecond before it', async () => {
    const now = Date.now();
    const opens = new Date(now - 60_000).toISOString();

    // `now < closes`: "closes at 17:00" reads as "you have until 17:00".
    const justInTime = await attempt(opens, new Date(now + 5_000).toISOString());
    expect(justInTime.ok).toBe(true);

    const onTheDot = await attempt(opens, new Date(now).toISOString());
    expect(onTheDot.ok).toBe(false);
    if (onTheDot.ok) throw new Error('unreachable');
    if (onTheDot.failure.code !== 'EVENT_NOT_ACCEPTING_ENTRIES') throw new Error('unreachable');
    expect(onTheDot.failure.reason).toBe('REGISTRATION_CLOSED');
  });

  it('a missing window is governed by the state alone', async () => {
    // Corruption, or an event opened immediately: no dates to check, so OPEN is
    // the only gate left — which is why the status check is not optional.
    expect((await attempt(null, null)).ok).toBe(true);

    db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);
    const closed = await service.register(
      event.id,
      identityAnswers({ email: 'after@example.com' }),
      actor(),
    );
    expect(closed.ok).toBe(false);
  });

  it('every non-OPEN state is refused, including the two after the draw', async () => {
    for (const status of [
      'DRAFT',
      'SCHEDULED',
      'CLOSED',
      'DRAW_READY',
      'DRAW_COMPLETED',
      'CANCELLED',
      'ARCHIVED',
    ]) {
      db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
      const result = await service.register(event.id, identityAnswers(), actor());
      expect(result.ok, status).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code, status).toBe('EVENT_NOT_ACCEPTING_ENTRIES');
    }
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('select answers cannot be talked into accepting the wrong thing', () => {
  async function selectEvent(type: 'SINGLE_SELECT' | 'MULTI_SELECT' | 'DROPDOWN') {
    const seeded = await seedOpenEvent([
      {
        type,
        label: 'Diet',
        key: 'diet',
        options: [
          { value: 'vegan', label: 'Vegan' },
          { value: 'halal', label: 'Halal' },
        ],
      },
    ]);
    event = seeded.event;
    version = seeded.version;
    return seeded;
  }

  it('refuses the LABEL when the value was asked for', async () => {
    await selectEvent('SINGLE_SELECT');
    // A client rendering labels must still submit values; accepting a label
    // would silently store something no export or draw can match on.
    const result = await service.register(event.id, identityAnswers({ diet: 'Vegan' }), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_INVALID');
    if (result.failure.code !== 'FORM_ANSWER_INVALID') throw new Error('unreachable');
    expect(result.failure.answers[0].problem).toBe('UNKNOWN_OPTION');
  });

  it('refuses an option that belongs to a DIFFERENT question', async () => {
    const seeded = await seedOpenEvent([
      {
        type: 'SINGLE_SELECT',
        label: 'Diet',
        key: 'diet',
        options: [
          { value: 'vegan', label: 'Vegan' },
          { value: 'halal', label: 'Halal' },
        ],
      },
      {
        type: 'SINGLE_SELECT',
        label: 'Shirt',
        key: 'shirt',
        options: [
          { value: 'small', label: 'S' },
          { value: 'large', label: 'L' },
        ],
      },
    ]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(
      event.id,
      identityAnswers({ diet: 'large', shirt: 'small' }),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_INVALID');
  });

  it('refuses an array where one value was asked for, and the reverse', async () => {
    await selectEvent('DROPDOWN');
    const asArray = await service.register(
      event.id,
      identityAnswers({ diet: ['vegan'] }),
      actor(),
    );
    expect(asArray.ok).toBe(false);

    await selectEvent('MULTI_SELECT');
    const asScalar = await service.register(event.id, identityAnswers({ diet: 'vegan' }), actor());
    expect(asScalar.ok).toBe(false);
  });

  it('an empty multi-select is ABSENCE, so an optional one stores nothing', async () => {
    await selectEvent('MULTI_SELECT');
    const result = await service.register(event.id, identityAnswers({ diet: [] }), actor());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.answerCount).toBe(3);
  });

  it('an empty multi-select on a REQUIRED question is reported as missing', async () => {
    const seeded = await seedOpenEvent([
      {
        type: 'MULTI_SELECT',
        label: 'Diet',
        key: 'diet',
        required: true,
        options: [
          { value: 'vegan', label: 'Vegan' },
          { value: 'halal', label: 'Halal' },
        ],
      },
    ]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(event.id, identityAnswers({ diet: [] }), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_REQUIRED_ANSWER_MISSING');
    if (result.failure.code !== 'FORM_REQUIRED_ANSWER_MISSING') throw new Error('unreachable');
    expect(result.failure.questions[0].questionKey).toBe('diet');
  });

  it('refuses an option that was deactivated after publication of THIS version', async () => {
    await selectEvent('SINGLE_SELECT');
    // Deactivated directly on the frozen rows: nobody was offered it, so nobody
    // can choose it, even though the version keeps it so old entries still read.
    db.raw
      .prepare(
        `UPDATE form_question_options SET active = 0
          WHERE value = 'vegan' AND question_id IN (
            SELECT id FROM form_questions
             WHERE form_owner_type = 'VERSION' AND form_owner_id = ?
          )`,
      )
      .run(version.id);

    const result = await service.register(event.id, identityAnswers({ diet: 'vegan' }), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    if (result.failure.code !== 'FORM_ANSWER_INVALID') throw new Error('unreachable');
    expect(result.failure.answers[0].problem).toBe('INACTIVE_OPTION');
  });
});

// ---------------------------------------------------------------------------
describe('scalar answers refuse coercion', () => {
  async function typedEvent(spec: Record<string, unknown>) {
    const seeded = await seedOpenEvent([{ key: 'probe', label: 'Probe', ...spec }]);
    event = seeded.event;
    version = seeded.version;
  }

  const refuse = async (value: unknown) => {
    const result = await service.register(event.id, identityAnswers({ probe: value }), actor());
    expect(result.ok, JSON.stringify(value)).toBe(false);
  };

  const accept = async (value: unknown) => {
    const other = await seedOpenEvent();
    void other;
    const result = await service.register(
      event.id,
      identityAnswers({ probe: value, email: `p-${crypto.randomUUID()}@x.com` }),
      actor(),
    );
    expect(result.ok, JSON.stringify(value)).toBe(true);
  };

  it('YES_NO takes a boolean and nothing that merely looks like one', async () => {
    await typedEvent({ type: 'YES_NO' });
    for (const hostile of ['true', 'false', 1, 0, 'yes', 'no', [], {}]) {
      await refuse(hostile);
    }
    await accept(true);
    await accept(false);
  });

  it('NUMBER takes a number or a numeric string, and nothing else', async () => {
    await typedEvent({ type: 'NUMBER' });
    // `Number(true)` is 1, `Number([])` is 0, `Number({})` is NaN: every one of
    // these would become a plausible-looking answer under coercion.
    for (const hostile of [true, false, [], {}, [1], 'abc']) {
      await refuse(hostile);
    }
    await accept(0);
    await accept(-1);
    await accept('42.5');
  });

  it('a blank NUMBER is absence, because that is what a number input posts', async () => {
    await typedEvent({ type: 'NUMBER' });
    const optional = await service.register(event.id, identityAnswers({ probe: '' }), actor());
    expect(optional.ok).toBe(true);
    if (!optional.ok) throw new Error('unreachable');
    // Absence stores no row rather than a zero somebody never typed.
    expect(optional.value.answerCount).toBe(3);

    await typedEvent({ type: 'NUMBER', required: true });
    const required = await service.register(event.id, identityAnswers({ probe: '   ' }), actor());
    expect(required.ok).toBe(false);
    if (required.ok) throw new Error('unreachable');
    expect(required.failure.code).toBe('FORM_REQUIRED_ANSWER_MISSING');
  });

  it('SHORT_TEXT takes a string and refuses every other shape', async () => {
    await typedEvent({ type: 'SHORT_TEXT' });
    for (const hostile of [42, true, {}, ['a'], { toString: 'x' }]) {
      await refuse(hostile);
    }
    // Emoji and non-Latin scripts are ordinary text.
    await accept('Ana 🎉 Λόπεζ 日本');
  });

  it('a CONSENT that is required cannot be declined, absent or faked', async () => {
    await typedEvent({ type: 'CONSENT', required: true });
    for (const hostile of [false, 'true', 1, null]) {
      await refuse(hostile);
    }
    await accept(true);
  });

  it('an optional CONSENT may be declined', async () => {
    await typedEvent({ type: 'CONSENT' });
    await accept(false);
  });
});

// ---------------------------------------------------------------------------
describe('answers to things nobody was shown', () => {
  it('refuses an answer to a question deactivated in the frozen version', async () => {
    const seeded = await seedOpenEvent([
      { type: 'SHORT_TEXT', label: 'City', key: 'city' },
    ]);
    event = seeded.event;
    version = seeded.version;

    db.raw
      .prepare(
        `UPDATE form_questions SET active = 0
          WHERE key = 'city' AND form_owner_type = 'VERSION' AND form_owner_id = ?`,
      )
      .run(version.id);

    const cityId = version.steps
      .flatMap((step) => step.questions)
      .find((question) => question.key === 'city')!.id;

    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: cityId, value: 'Madrid' }],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_NOT_ALLOWED');
    if (result.failure.code !== 'FORM_ANSWER_NOT_ALLOWED') throw new Error('unreachable');
    expect(result.failure.reason).toBe('inactive');
  });

  it('a required question that is inactive is not demanded either', async () => {
    // Publishing refuses to freeze a form in this shape, but a corrupted
    // version could hold one — and demanding an answer nobody could give would
    // make the form impossible to submit at all.
    const seeded = await seedOpenEvent([
      { type: 'SHORT_TEXT', label: 'City', key: 'city', required: true },
    ]);
    event = seeded.event;
    version = seeded.version;

    db.raw
      .prepare(
        `UPDATE form_questions SET active = 0
          WHERE key = 'city' AND form_owner_type = 'VERSION' AND form_owner_id = ?`,
      )
      .run(version.id);

    const result = await service.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(true);
  });

  it('an INFORMATION block among otherwise valid answers fails the whole thing', async () => {
    const seeded = await seedOpenEvent([
      { type: 'INFORMATION', label: 'Please read this', key: 'notice' },
      { type: 'SHORT_TEXT', label: 'City', key: 'city' },
    ]);
    event = seeded.event;
    version = seeded.version;

    const notice = version.steps
      .flatMap((step) => step.questions)
      .find((question) => question.key === 'notice')!;

    const result = await service.register(
      event.id,
      [...identityAnswers({ city: 'Madrid' }), { questionId: notice.id, value: 'acknowledged' }],
      actor(),
    );
    // Refused, not silently dropped: quietly discarding it would tell a client
    // its submission succeeded while losing part of what it said.
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_NOT_ALLOWED');
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the duplicate-entry constraint, when the precheck loses', () => {
  it('is translated into a 409, not surfaced as a 500', async () => {
    // The precheck is a courtesy; the unique index is the guarantee. This is
    // the interleaving where the courtesy is useless: the service looked, saw
    // nothing, and somebody else's entry landed while it was building its
    // batch. Without the translation the caller would get a 500 for something
    // that is an ordinary, expected conflict.
    const other = await seedOpenEvent();
    const first = await service.register(other.event.id, answersFor(other.version), actor());
    if (!first.ok) throw new Error('unreachable');
    const participantId = first.value.participant.id;

    let competitorId = '';
    const racing = interposing(() => {
      const now = new Date().toISOString();
      competitorId = crypto.randomUUID();
      db.raw
        .prepare(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)`,
        )
        .run(competitorId, event.id, participantId, version.id, now, now, now);
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('PARTICIPANT_ALREADY_ENTERED');
    if (result.failure.code !== 'PARTICIPANT_ALREADY_ENTERED') throw new Error('unreachable');
    // And it names the entry that actually won, so a client can say which one.
    expect(result.failure.entryId).toBe(competitorId);

    // Exactly one entry in this event, and the loser wrote no answers.
    expect(
      count(`SELECT COUNT(*) AS n FROM event_entries WHERE event_id = '${event.id}'`),
    ).toBe(1);
    expect(
      count(`SELECT COUNT(*) AS n FROM event_entry_answers WHERE event_entry_id = '${competitorId}'`),
    ).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_ENTRY_CREATED'")).toBe(
      1,
    );
  });

  it('a NEW identity losing the same race is still a 409, not a 500', async () => {
    // Nobody exists yet, so the participant is created in the same batch. The
    // competing row arrives for an identity this request has not written.
    let competitorId = '';
    const racing = interposing(() => {
      const now = new Date().toISOString();
      const participantId = crypto.randomUUID();
      competitorId = crypto.randomUUID();
      db.raw
        .prepare(
          `INSERT INTO participants
             (id, email, normalized_email, first_name, last_name, created_at, updated_at)
           VALUES (?, 'Ana@Example.com', 'ana@example.com', 'Ana', 'Lopez', ?, ?)`,
        )
        .run(participantId, now, now);
      db.raw
        .prepare(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)`,
        )
        .run(competitorId, event.id, participantId, version.id, now, now, now);
    });

    const result = await racing.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('PARTICIPANT_ALREADY_ENTERED');
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });
});

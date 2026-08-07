// @vitest-environment node
//
// ParticipantRegistrationService against the real migrated schema: identity
// reuse, one entry per identity per event, version binding, atomicity, the
// event lifecycle gate, and the races each defence exists for.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ParticipantRegistrationService } from '../functions/_shared/participantRegistrationService';
import { EventEntryRepository } from '../functions/_shared/eventEntryRepository';
import { EventRepository } from '../functions/_shared/eventRepository';
import { ParticipantRepository } from '../functions/_shared/participantRepository';
import { EntryAnswerRepository } from '../functions/_shared/entryAnswerRepository';
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
  FormQuestion,
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
  requestId: 'req-entry',
  ipHash: 'a'.repeat(64),
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

function auditRows(action?: string) {
  const rows = db.raw
    .prepare('SELECT * FROM audit_logs ORDER BY rowid ASC')
    .all() as Array<Record<string, unknown>>;
  return action ? rows.filter((row) => row.action === action) : rows;
}

/** The published version's questions, by their answer key. */
function questionByKey(key: string): FormQuestion {
  const found = version.steps
    .flatMap((step) => step.questions)
    .find((question) => question.key === key);
  if (!found) throw new Error(`no question keyed ${key}`);
  return found;
}

/** The same three answers, against whichever version is named. */
function answersFor(
  target: EventFormVersion,
  overrides: Partial<Record<string, unknown>> = {},
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

function identityAnswers(
  overrides: Partial<Record<string, unknown>> = {},
): SubmittedAnswer[] {
  return answersFor(version, overrides);
}

/**
 * Builds an event with a published form and opens registration.
 *
 * `extra` adds questions beyond the three identity fields, so a test can ask
 * about a custom question without rebuilding the whole form.
 */
async function seedOpenEvent(
  extra: Array<Record<string, unknown>> = [],
  eventOverrides: Record<string, unknown> = {},
): Promise<{ event: Event; version: EventFormVersion }> {
  const madeEvent = await events.create(
    {
      name: 'Open Event',
      registrationOpensAt: at(-1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
      ...eventOverrides,
    } as never,
    actor(),
  );
  if (!madeEvent.ok) throw new Error('event seed failed');
  const created = madeEvent.value;

  const draft = await drafts.ensure(created.id, actor());
  if (!draft.ok) throw new Error(draft.failure.code);
  let form = draft.value.draft;

  const step = await drafts.createStep(
    created.id,
    { expectedRevision: form.revision, title: 'About you' },
    actor(),
  );
  if (!step.ok) throw new Error(step.failure.code);
  form = step.value;

  const specs = [
    { type: 'SHORT_TEXT', systemField: 'FIRST_NAME', label: 'First name', required: true },
    { type: 'SHORT_TEXT', systemField: 'LAST_NAME', label: 'Last name', required: true },
    { type: 'EMAIL', systemField: 'EMAIL', label: 'Email', required: true },
    ...extra,
  ];

  for (const spec of specs) {
    const made = await drafts.createQuestion(
      created.id,
      { expectedRevision: form.revision, stepId: form.steps[0].id, ...spec } as never,
      actor(),
    );
    if (!made.ok) throw new Error(`${JSON.stringify(spec)} -> ${made.failure.code}`);
    form = made.value;
  }

  const published = await publishing.publish(created.id, form.revision, actor());
  if (!published.ok) throw new Error(published.failure.code);

  const opened = await events.transition(created.id, 'open', actor());
  if (!opened.ok) throw new Error(JSON.stringify(opened.failure));

  const reloaded = await events.findById(created.id);
  if (!reloaded) throw new Error('event vanished');
  return { event: reloaded, version: published.value.version };
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
describe('recording a participation', () => {
  it('creates the identity, the entry and its answers together', async () => {
    const result = await service.register(event.id, identityAnswers(), actor());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.answerCount).toBe(3);
    expect(result.value.entry.status).toBe('ELIGIBLE');
    expect(result.value.entry.eventId).toBe(event.id);
    expect(result.value.entry.participantId).toBe(result.value.participant.id);
    // Bound to the version that was published, not to the draft.
    expect(result.value.entry.formVersionId).toBe(version.id);

    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(3);
  });

  it('is born decided: an event with no age rule judges nothing but still decides', async () => {
    const result = await service.register(event.id, identityAnswers(), actor());
    if (!result.ok) throw new Error('unreachable');

    expect(result.value.entry.status).toBe('ELIGIBLE');
    expect(result.value.entry.overallEligible).toBe(true);
    expect(result.value.entry.eligibilityReason).toBe('ELIGIBLE');
    // No age RULE existed, so nothing was judged about the age. `null` here is
    // "not applicable", and it must not become `false`.
    expect(result.value.entry.ageEligible).toBeNull();
    // And this form did not ask when anybody was born.
    expect(result.value.entry.calculatedAge).toBeNull();
  });

  it('the identity is read off the ANSWERS, normalised for lookup only', async () => {
    const result = await service.register(event.id, identityAnswers(), actor());
    if (!result.ok) throw new Error('unreachable');

    // Presentable form preserved; canonical form is what carries uniqueness.
    expect(result.value.participant.email).toBe('Ana@Example.com');
    expect(result.value.participant.normalizedEmail).toBe('ana@example.com');
    expect(result.value.participant.firstName).toBe('Ana');
  });

  it('copies the key, label and type from the VERSION, never from the caller', async () => {
    const result = await service.register(event.id, identityAnswers(), actor());
    if (!result.ok) throw new Error('unreachable');

    const answers = await new EntryAnswerRepository(db.d1).listByEntry(result.value.entry.id);
    const email = answers.find((answer) => answer.questionKey === 'email');
    expect(email?.questionLabel).toBe('Email');
    expect(email?.type).toBe('EMAIL');
    expect(email?.value).toBe('Ana@Example.com');
  });

  it('records the identity and the participation as two audit facts', async () => {
    await service.register(event.id, identityAnswers(), actor());

    expect(auditRows('PARTICIPANT_CREATED')).toHaveLength(1);
    expect(auditRows('EVENT_ENTRY_CREATED')).toHaveLength(1);

    // No personal data travels into an append-only table.
    const serialized = JSON.stringify(auditRows());
    for (const secret of ['Ana', 'Lopez', 'Ana@Example.com', 'ana@example.com']) {
      expect(serialized, secret).not.toContain(secret);
    }
  });

  it('the answers of an entry read back in the order the form asked them', async () => {
    const seeded = await seedOpenEvent([
      { type: 'SHORT_TEXT', label: 'City', key: 'city' },
      { type: 'YES_NO', label: 'Smoker?', key: 'smoker_status' },
    ]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(
      event.id,
      [
        // Sent last-first on purpose.
        { questionId: questionByKey('smoker_status').id, value: true },
        { questionId: questionByKey('city').id, value: 'Madrid' },
        ...identityAnswers(),
      ],
      actor(),
    );
    if (!result.ok) throw new Error('unreachable');

    const answers = await new EntryAnswerRepository(db.d1).listByEntry(result.value.entry.id);
    expect(answers.map((answer) => answer.questionKey)).toEqual([
      'first_name',
      'last_name',
      'email',
      'city',
      'smoker_status',
    ]);
  });

  it('a custom question is a row, not a column', async () => {
    const seeded = await seedOpenEvent([
      {
        type: 'SINGLE_SELECT',
        label: 'Do you drink?',
        key: 'drinker_status',
        options: [
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
        ],
      },
    ]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: questionByKey('drinker_status').id, value: 'no' }],
      actor(),
    );
    expect(result.ok).toBe(true);

    const columns = db.raw
      .prepare('PRAGMA table_info(event_entry_answers)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toContain('drinker_status');

    const stored = db.raw
      .prepare('SELECT answer_value AS v FROM event_entry_answers WHERE question_key = ?')
      .get('drinker_status') as { v: string };
    expect(stored.v).toBe('"no"');
  });
});

// ---------------------------------------------------------------------------
describe('identity across events', () => {
  it('one address is one identity, reused rather than duplicated', async () => {
    const first = await service.register(event.id, identityAnswers(), actor());
    if (!first.ok) throw new Error('unreachable');

    const other = await seedOpenEvent();
    const previous = { event, version };
    event = other.event;
    version = other.version;

    const second = await service.register(event.id, identityAnswers(), actor());
    if (!second.ok) throw new Error('unreachable');

    expect(second.value.participant.id).toBe(first.value.participant.id);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(2);
    // And each entry is bound to ITS OWN event's version.
    expect(first.value.entry.formVersionId).toBe(previous.version.id);
    expect(second.value.entry.formVersionId).toBe(other.version.id);
  });

  it('refuses a second entry in the SAME event', async () => {
    const first = await service.register(event.id, identityAnswers(), actor());
    if (!first.ok) throw new Error('unreachable');

    const again = await service.register(event.id, identityAnswers(), actor());
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.failure.code).toBe('PARTICIPANT_ALREADY_ENTERED');
    if (again.failure.code !== 'PARTICIPANT_ALREADY_ENTERED') throw new Error('unreachable');
    expect(again.failure.entryId).toBe(first.value.entry.id);

    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(auditRows('EVENT_ENTRY_CREATED')).toHaveLength(1);
  });

  it('a different capitalisation is the same person', async () => {
    await service.register(event.id, identityAnswers(), actor());
    const again = await service.register(
      event.id,
      identityAnswers({ email: '  ANA@EXAMPLE.COM ' }),
      actor(),
    );
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.failure.code).toBe('PARTICIPANT_ALREADY_ENTERED');
  });

  it('refreshes a profile without erasing what an earlier form recorded', async () => {
    const withDob = await seedOpenEvent([
      { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' },
      { type: 'PHONE', systemField: 'PHONE', label: 'Phone' },
    ]);
    event = withDob.event;
    version = withDob.version;

    const first = await service.register(
      event.id,
      identityAnswers({ date_of_birth: '1990-01-01', phone: '555-0100' }),
      actor(),
    );
    if (!first.ok) throw new Error('unreachable');
    expect(first.value.participant.dateOfBirth).toBe('1990-01-01');

    // A second event whose form does not ask for either.
    const plain = await seedOpenEvent();
    event = plain.event;
    version = plain.version;

    const second = await service.register(
      event.id,
      identityAnswers({ first_name: 'Ana Maria' }),
      actor(),
    );
    if (!second.ok) throw new Error('unreachable');

    // The name is refreshed; what this form did not ask about survives.
    expect(second.value.participant.firstName).toBe('Ana Maria');
    expect(second.value.participant.dateOfBirth).toBe('1990-01-01');
    expect(second.value.participant.phone).toBe('555-0100');
    expect(auditRows('PARTICIPANT_UPDATED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('a contradicted identity', () => {
  async function eventAskingForDob() {
    const seeded = await seedOpenEvent([
      { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' },
    ]);
    event = seeded.event;
    version = seeded.version;
  }

  it('refuses two different dates of birth for one address, writing nothing', async () => {
    await eventAskingForDob();
    const first = await service.register(
      event.id,
      identityAnswers({ date_of_birth: '1990-01-01' }),
      actor(),
    );
    if (!first.ok) throw new Error('unreachable');

    const other = await seedOpenEvent([
      { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' },
    ]);
    event = other.event;
    version = other.version;

    const conflicting = await service.register(
      event.id,
      identityAnswers({ date_of_birth: '1991-01-01' }),
      actor(),
    );
    expect(conflicting.ok).toBe(false);
    if (conflicting.ok) throw new Error('unreachable');
    expect(conflicting.failure.code).toBe('PARTICIPANT_IDENTITY_CONFLICT');

    // Neither the entry nor the profile moved: guessing which date is right
    // would either corrupt a record or decide eligibility on data nobody gave.
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    const stored = await new ParticipantRepository(db.d1).findById(first.value.participant.id);
    expect(stored?.dateOfBirth).toBe('1990-01-01');
  });

  it('the SAME date of birth is not a conflict', async () => {
    await eventAskingForDob();
    await service.register(event.id, identityAnswers({ date_of_birth: '1990-01-01' }), actor());

    const other = await seedOpenEvent([
      { type: 'DATE', systemField: 'DATE_OF_BIRTH', label: 'Date of birth' },
    ]);
    event = other.event;
    version = other.version;

    const again = await service.register(
      event.id,
      identityAnswers({ date_of_birth: '1990-01-01' }),
      actor(),
    );
    expect(again.ok).toBe(true);
  });

  it('a new NAME is not a conflict — people change their names', async () => {
    await service.register(event.id, identityAnswers(), actor());

    const other = await seedOpenEvent();
    event = other.event;
    version = other.version;

    const renamed = await service.register(
      event.id,
      identityAnswers({ first_name: 'Anna', last_name: 'Lopez-Garcia' }),
      actor(),
    );
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) throw new Error('unreachable');
    expect(renamed.value.participant.lastName).toBe('Lopez-Garcia');
  });
});

// ---------------------------------------------------------------------------
describe('the event lifecycle gate', () => {
  it('refuses every state that is not OPEN', async () => {
    for (const status of ['DRAFT', 'SCHEDULED', 'CLOSED', 'CANCELLED', 'ARCHIVED']) {
      db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
      const result = await service.register(event.id, identityAnswers(), actor());
      expect(result.ok, status).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code, status).toBe('EVENT_NOT_ACCEPTING_ENTRIES');
    }
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('refuses before registration opens and once it has closed', async () => {
    const future = new Date(Date.now() + DAY).toISOString();
    db.raw
      .prepare('UPDATE events SET registration_opens_at = ? WHERE id = ?')
      .run(future, event.id);
    let result = await service.register(event.id, identityAnswers(), actor());
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_NOT_ACCEPTING_ENTRIES');
    if (result.failure.code !== 'EVENT_NOT_ACCEPTING_ENTRIES') throw new Error('unreachable');
    expect(result.failure.reason).toBe('REGISTRATION_NOT_STARTED');

    const past = new Date(Date.now() - DAY).toISOString();
    db.raw
      .prepare(
        'UPDATE events SET registration_opens_at = ?, registration_closes_at = ? WHERE id = ?',
      )
      .run(past, past, event.id);
    result = await service.register(event.id, identityAnswers(), actor());
    if (result.ok) throw new Error('unreachable');
    if (result.failure.code !== 'EVENT_NOT_ACCEPTING_ENTRIES') throw new Error('unreachable');
    expect(result.failure.reason).toBe('REGISTRATION_CLOSED');
  });

  it('the closing instant itself is too late, the opening instant is not', async () => {
    // "Closes at 17:00" reads as "you have until 17:00". Admitting the exact
    // instant of the deadline turns clock skew into an argument.
    const now = new Date().toISOString();
    db.raw
      .prepare(
        'UPDATE events SET registration_opens_at = ?, registration_closes_at = ? WHERE id = ?',
      )
      .run(now, now, event.id);

    const result = await service.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    if (result.failure.code !== 'EVENT_NOT_ACCEPTING_ENTRIES') throw new Error('unreachable');
    expect(result.failure.reason).toBe('REGISTRATION_CLOSED');
  });

  it('an event that closes MID-BATCH records nothing at all', async () => {
    // The service checked OPEN and started building. The abort statement is
    // what covers the gap between that check and the commit.
    let raced = false;
    const racing = {
      prepare: (sql: string) => db.d1.prepare(sql),
      exec: (sql: string) => db.d1.exec(sql),
      batch: (statements: unknown[]) => {
        if (!raced) {
          raced = true;
          db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);
        }
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
    expect(result.failure.code).toBe('EVENT_NOT_ACCEPTING_ENTRIES');

    // No participant, no entry, no answers, no audit — and the event's own
    // status survived the guard that fired.
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(0);
    expect(auditRows('EVENT_ENTRY_CREATED')).toHaveLength(0);
    const stored = db.raw
      .prepare('SELECT status FROM events WHERE id = ?')
      .get(event.id) as { status: string };
    expect(stored.status).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
describe('the published version is the authority', () => {
  it('refuses an event with no published form', async () => {
    const madeEvent = await events.create(
      {
        name: 'Formless',
        registrationOpensAt: at(-1),
        registrationClosesAt: at(5),
        startsAt: at(6),
        endsAt: at(7),
      },
      actor(),
    );
    if (!madeEvent.ok) throw new Error('unreachable');
    db.raw.prepare("UPDATE events SET status = 'OPEN' WHERE id = ?").run(madeEvent.value.id);

    const result = await service.register(madeEvent.value.id, [], actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_VERSION_REQUIRED');
  });

  it('refuses a pointer at ANOTHER event’s version', async () => {
    const other = await seedOpenEvent();
    db.raw
      .prepare('UPDATE events SET published_form_version_id = ? WHERE id = ?')
      .run(other.version.id, event.id);

    const result = await service.register(event.id, identityAnswers(), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_VERSION_REQUIRED');
    if (result.failure.code !== 'FORM_VERSION_REQUIRED') throw new Error('unreachable');
    expect(result.failure.reason).toBe('foreign');
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });

  it('refuses a DRAFT question, even one belonging to this event', async () => {
    const draftQuestion = db.raw
      .prepare(
        `SELECT id FROM form_questions
         WHERE form_owner_type = 'DRAFT' AND key = 'email' LIMIT 1`,
      )
      .get() as { id: string };

    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: draftQuestion.id, value: 'x@y.com' }],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_UNKNOWN_QUESTION');
  });

  it('refuses a question from another event’s version', async () => {
    const other = await seedOpenEvent();
    const foreign = other.version.steps[0].questions[0];

    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: foreign.id, value: 'x' }],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_UNKNOWN_QUESTION');
  });

  it('an entry stays bound to the version it was validated against', async () => {
    const first = await service.register(event.id, identityAnswers(), actor());
    if (!first.ok) throw new Error('unreachable');

    // Publish a second version afterwards.
    const draft = await drafts.find(event.id);
    if (!draft.ok || !draft.value.draft) throw new Error('no draft');
    const touched = await drafts.saveDraft(event.id, draft.value.draft.revision, actor());
    if (!touched.ok) throw new Error(touched.failure.code);
    const second = await publishing.publish(event.id, touched.value.revision, actor());
    if (!second.ok) throw new Error(second.failure.code);
    expect(second.value.version.versionNumber).toBe(2);

    const stored = await new EventEntryRepository(db.d1).findByEventAndId(
      event.id,
      first.value.entry.id,
    );
    // The old entry still answers the form it was actually shown.
    expect(stored?.formVersionId).toBe(version.id);
  });
});

// ---------------------------------------------------------------------------
describe('what a submission may and may not contain', () => {
  it('refuses a required question left unanswered, naming it', async () => {
    const result = await service.register(
      event.id,
      identityAnswers({ email: undefined }),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_REQUIRED_ANSWER_MISSING');
    if (result.failure.code !== 'FORM_REQUIRED_ANSWER_MISSING') throw new Error('unreachable');
    expect(result.failure.questions.map((question) => question.questionKey)).toEqual(['email']);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
  });

  it('refuses the same question answered twice', async () => {
    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: questionByKey('email').id, value: 'b@c.com' }],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('DUPLICATE_FORM_ANSWER');
  });

  it('refuses an answer to copy', async () => {
    const seeded = await seedOpenEvent([
      { type: 'INFORMATION', label: 'Please read this', key: 'notice' },
    ]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: questionByKey('notice').id, value: 'ok' }],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_NOT_ALLOWED');
    if (result.failure.code !== 'FORM_ANSWER_NOT_ALLOWED') throw new Error('unreachable');
    expect(result.failure.reason).toBe('information');
  });

  it('refuses a badly typed answer and reports which question', async () => {
    const result = await service.register(
      event.id,
      identityAnswers({ email: 'not-an-email' }),
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ANSWER_INVALID');
    if (result.failure.code !== 'FORM_ANSWER_INVALID') throw new Error('unreachable');
    expect(result.failure.answers[0].questionKey).toBe('email');
    expect(result.failure.answers[0].problem).toBe('INVALID_EMAIL');
  });

  it('a fabricated question id is refused, never ignored', async () => {
    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: crypto.randomUUID(), value: 'x' }],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // Silently discarding it would tell a client its submission succeeded while
    // losing part of what it said.
    expect(result.failure.code).toBe('FORM_ANSWER_UNKNOWN_QUESTION');
  });

  it('a refused submission leaves absolutely nothing behind', async () => {
    await service.register(event.id, identityAnswers({ email: 'nope' }), actor());
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(0);
    expect(auditRows('PARTICIPANT_CREATED')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two submissions from one address to one event: exactly one lands', async () => {
    const [first, second] = await Promise.all([
      service.register(event.id, identityAnswers(), actor()),
      service.register(event.id, identityAnswers(), actor()),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = [first, second].find((result) => !result.ok);
    if (!loser || loser.ok) throw new Error('unreachable');
    expect(loser.failure.code).toBe('PARTICIPANT_ALREADY_ENTERED');

    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entry_answers')).toBe(3);
    expect(auditRows('EVENT_ENTRY_CREATED')).toHaveLength(1);
  });

  it('two submissions from one address to DIFFERENT events: both land, one identity', async () => {
    const other = await seedOpenEvent();

    // Each submission answers ITS OWN event's version; the identity is the
    // only thing the two have in common.
    const [first, second] = await Promise.all([
      service.register(event.id, answersFor(version), actor()),
      service.register(other.event.id, answersFor(other.version), actor()),
    ]);

    if (!first.ok) throw new Error(JSON.stringify(first.failure));
    if (!second.ok) throw new Error(JSON.stringify(second.failure));
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(2);
  });

  it('a lost identity race is re-read, never surfaced as a 500', async () => {
    // The service saw "no such participant" and is about to insert one. The row
    // appears underneath it — exactly what two simultaneous first-time
    // submissions produce.
    let raced = false;
    const racing = {
      prepare: (sql: string) => db.d1.prepare(sql),
      exec: (sql: string) => db.d1.exec(sql),
      batch: async (statements: unknown[]) => {
        if (!raced) {
          raced = true;
          const now = new Date().toISOString();
          db.raw
            .prepare(
              `INSERT INTO participants
                 (id, email, normalized_email, first_name, last_name, created_at, updated_at)
               VALUES (?, 'Ana@Example.com', 'ana@example.com', 'Ana', 'Lopez', ?, ?)`,
            )
            .run(crypto.randomUUID(), now, now);
        }
        return db.d1.batch(statements as never);
      },
    } as unknown as D1Database;

    const result = await new ParticipantRegistrationService(racing).register(
      event.id,
      identityAnswers(),
      actor(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // One identity, reused; the entry attached to the winner's row.
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(1);
  });

  it('a failing answer insert takes the whole registration with it', async () => {
    // An oversized answer cannot be stored, and the refusal must be total
    // rather than an entry with a hole where one answer should be.
    const seeded = await seedOpenEvent([{ type: 'LONG_TEXT', label: 'Essay', key: 'essay' }]);
    event = seeded.event;
    version = seeded.version;

    const result = await service.register(
      event.id,
      [...identityAnswers(), { questionId: questionByKey('essay').id, value: 'x'.repeat(50_000) }],
      actor(),
    );
    expect(result.ok).toBe(false);
    expect(count('SELECT COUNT(*) AS n FROM participants')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM event_entries')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('reading entries back', () => {
  it('lists an event’s participants, newest first, and never another event’s', async () => {
    await service.register(event.id, identityAnswers(), actor());

    const other = await seedOpenEvent();
    await service.register(
      other.event.id,
      answersFor(other.version, {
        first_name: 'Bob',
        last_name: 'Smith',
        email: 'bob@example.com',
      }),
      actor(),
    );

    const list = await service.list(event.id, { page: 1, pageSize: 25, search: null });
    expect(list.ok).toBe(true);
    if (!list.ok) throw new Error('unreachable');
    expect(list.value.total).toBe(1);
    expect(list.value.items[0].email).toBe('Ana@Example.com');
    expect(list.value.items[0].formVersionNumber).toBe(1);
    expect(list.value.items[0].answerCount).toBe(3);
  });

  it('searches by name and by email, treating wildcards literally', async () => {
    await service.register(event.id, identityAnswers(), actor());

    const byName = await service.list(event.id, { page: 1, pageSize: 25, search: 'lop' });
    if (!byName.ok) throw new Error('unreachable');
    expect(byName.value.total).toBe(1);

    const byEmail = await service.list(event.id, { page: 1, pageSize: 25, search: 'ANA@ex' });
    if (!byEmail.ok) throw new Error('unreachable');
    expect(byEmail.value.total).toBe(1);

    // A bare `%` must not match everybody.
    const wildcard = await service.list(event.id, { page: 1, pageSize: 25, search: '%' });
    if (!wildcard.ok) throw new Error('unreachable');
    expect(wildcard.value.total).toBe(0);
  });

  it('returns one entry in full, with its answers and its version', async () => {
    const created = await service.register(event.id, identityAnswers(), actor());
    if (!created.ok) throw new Error('unreachable');

    const detail = await service.detail(event.id, created.value.entry.id);
    expect(detail.ok).toBe(true);
    if (!detail.ok) throw new Error('unreachable');
    expect(detail.value.participant.email).toBe('Ana@Example.com');
    expect(detail.value.formVersion.versionNumber).toBe(1);
    expect(detail.value.answers.map((answer) => answer.questionKey)).toEqual([
      'first_name',
      'last_name',
      'email',
    ]);
  });

  it('an entry reached through the WRONG event is not found', async () => {
    const created = await service.register(event.id, identityAnswers(), actor());
    if (!created.ok) throw new Error('unreachable');

    const other = await seedOpenEvent();
    const detail = await service.detail(other.event.id, created.value.entry.id);
    expect(detail.ok).toBe(false);
    if (detail.ok) throw new Error('unreachable');
    expect(detail.failure.code).toBe('EVENT_ENTRY_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('what an entry makes impossible', () => {
  it('an event with entries can never be deleted', async () => {
    await service.register(event.id, identityAnswers(), actor());

    const current = await events.findById(event.id);
    if (!current) throw new Error('event vanished');
    const deleted = await events.remove(event.id, actor(), current.revision);
    expect(deleted.ok).toBe(false);
    if (deleted.ok) throw new Error('unreachable');
    expect(deleted.failure.code).toBe('EVENT_CANNOT_BE_DELETED');
  });

  it('an entry counts as a dependency in its own right', async () => {
    // In practice an event with entries also has a published version, so the
    // versions clause would fire anyway — which is exactly how a missing
    // entries clause would stay invisible. The one state where it is
    // load-bearing is an entry whose version belongs to a DIFFERENT event:
    // impossible through the API, possible in a restored or hand-edited
    // database, and precisely when "can this event be deleted?" must still say
    // no.
    await service.register(event.id, identityAnswers(), actor());
    const repository = new EventRepository(db.d1);

    const bare = await events.create({ name: 'Bare' }, actor());
    if (!bare.ok) throw new Error('unreachable');
    expect(await repository.hasDependencies(bare.value.id)).toBe(false);

    const now = new Date().toISOString();
    const participant = db.raw
      .prepare('SELECT id FROM participants LIMIT 1')
      .get() as { id: string };
    db.raw
      .prepare(
        `INSERT INTO event_entries
           (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'SUBMITTED', ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), bare.value.id, participant.id, version.id, now, now, now);

    expect(await repository.hasDependencies(bare.value.id)).toBe(true);
  });

  it('the entry repository offers no way to unrecord a participation', () => {
    const repository = new EventEntryRepository(db.d1) as unknown as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).filter(
      (name) => name !== 'constructor',
    );
    for (const name of names) {
      expect(name, name).not.toMatch(/^(delete|remove)/i);
    }
  });

  it('neither does the answer repository', () => {
    const repository = new EntryAnswerRepository(db.d1) as unknown as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).filter(
      (name) => name !== 'constructor',
    );
    for (const name of names) {
      expect(name, name).not.toMatch(/^(update|delete|remove|patch)/i);
    }
  });

  it('nor the participant repository', () => {
    const repository = new ParticipantRepository(db.d1) as unknown as Record<string, unknown>;
    const names = Object.getOwnPropertyNames(Object.getPrototypeOf(repository)).filter(
      (name) => name !== 'constructor',
    );
    for (const name of names) {
      expect(name, name).not.toMatch(/^(delete|remove)/i);
    }
  });
});

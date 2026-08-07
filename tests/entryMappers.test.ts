// @vitest-environment node
//
// The strict mappers, and the narrow seams the repositories expose.
//
// Every one of these guards is for a row the APPLICATION cannot produce: a
// migration, a console session, a restore or a future bug wrote it. The point
// is that such a row raises a controlled error naming the column, rather than
// flowing onward and being treated as a decision somebody made — a negative
// age, a half-boolean or a date of birth that is not a real day would all reach
// the eligibility phase and quietly change an answer about a person.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  rowToParticipant,
  ParticipantRepository,
  type ParticipantRow,
} from '../functions/_shared/participantRepository';
import {
  rowToEventEntry,
  EventEntryRepository,
  type EventEntryRow,
} from '../functions/_shared/eventEntryRepository';
import {
  rowToEntryAnswer,
  serializeAnswerValue,
  EntryAnswerRepository,
  type EntryAnswerRow,
} from '../functions/_shared/entryAnswerRepository';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

const AT = '2026-01-01T00:00:00.000Z';

function participantRow(overrides: Partial<ParticipantRow> = {}): ParticipantRow {
  return {
    id: 'p-1',
    email: 'Ana@Example.com',
    normalized_email: 'ana@example.com',
    first_name: 'Ana',
    last_name: 'Lopez',
    phone: null,
    date_of_birth: null,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

function entryRow(overrides: Partial<EventEntryRow> = {}): EventEntryRow {
  return {
    id: 'e-1',
    event_id: 'ev-1',
    participant_id: 'p-1',
    form_version_id: 'v-1',
    status: 'SUBMITTED',
    calculated_age: null,
    age_eligible: null,
    overall_eligible: null,
    eligibility_reason: null,
    submitted_at: AT,
    created_at: AT,
    updated_at: AT,
    ...overrides,
  };
}

function answerRow(overrides: Partial<EntryAnswerRow> = {}): EntryAnswerRow {
  return {
    id: 'a-1',
    event_entry_id: 'e-1',
    question_id: 'q-1',
    question_key: 'email',
    question_label_snapshot: 'Email',
    answer_type: 'EMAIL',
    answer_value: '"ana@example.com"',
    created_at: AT,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
describe('rowToParticipant', () => {
  it('maps a well-formed row', () => {
    const participant = rowToParticipant(
      participantRow({ phone: '555-0100', date_of_birth: '1990-03-15' }),
    );
    expect(participant.normalizedEmail).toBe('ana@example.com');
    expect(participant.email).toBe('Ana@Example.com');
    expect(participant.dateOfBirth).toBe('1990-03-15');
  });

  it('refuses a row with no identity', () => {
    expect(() => rowToParticipant(participantRow({ id: '' }))).toThrow(/identifier/i);
    expect(() => rowToParticipant(participantRow({ email: '' }))).toThrow(/email/);
    expect(() => rowToParticipant(participantRow({ normalized_email: '' }))).toThrow(
      /normalized_email/,
    );
  });

  it('refuses a canonical column that is not canonical', () => {
    // A lookup normalises before it queries; a row that did not would be
    // findable by nobody and duplicable by anybody.
    expect(() =>
      rowToParticipant(participantRow({ normalized_email: 'Ana@Example.com' })),
    ).toThrow(/canonical form/i);
  });

  it('refuses a nameless participant', () => {
    expect(() => rowToParticipant(participantRow({ first_name: '   ' }))).toThrow(/first_name/);
    expect(() => rowToParticipant(participantRow({ last_name: '' }))).toThrow(/last_name/);
  });

  it('refuses a date of birth that is not a real calendar day', () => {
    for (const bad of ['1990-02-30', '1990-13-01', '1990-1-1', '1990-01-01T00:00:00.000Z']) {
      expect(() => rowToParticipant(participantRow({ date_of_birth: bad })), bad).toThrow(
        /date_of_birth/,
      );
    }
  });

  it('refuses a naive timestamp', () => {
    expect(() =>
      rowToParticipant(participantRow({ created_at: '2026-01-01 00:00:00' })),
    ).toThrow(/created_at/);
    expect(() => rowToParticipant(participantRow({ updated_at: 'yesterday' }))).toThrow(
      /updated_at/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('rowToEventEntry', () => {
  it('maps a well-formed row, including the eligibility columns', () => {
    const eligible = rowToEventEntry(
      entryRow({
        status: 'ELIGIBLE',
        calculated_age: 34,
        age_eligible: 1,
        overall_eligible: 1,
        eligibility_reason: 'ELIGIBLE',
      }),
    );
    expect(eligible.calculatedAge).toBe(34);
    expect(eligible.ageEligible).toBe(true);
    expect(eligible.overallEligible).toBe(true);
    expect(eligible.eligibilityReason).toBe('ELIGIBLE');

    const ineligible = rowToEventEntry(
      entryRow({
        status: 'INELIGIBLE',
        calculated_age: 20,
        age_eligible: 0,
        overall_eligible: 0,
        eligibility_reason: 'AGE_REQUIREMENT_NOT_MET',
      }),
    );
    expect(ineligible.ageEligible).toBe(false);
    expect(ineligible.overallEligible).toBe(false);
    expect(ineligible.eligibilityReason).toBe('AGE_REQUIREMENT_NOT_MET');
  });

  it('leaves a historical unjudged entry exactly as it was recorded', () => {
    // Rows written before eligibility existed carry no verdict. Deriving one
    // from `overall_eligible` on read would silently re-label every one of them
    // INELIGIBLE — inventing a decision nobody took, about people who were
    // never assessed. They are history, and history is read, not recomputed.
    const entry = rowToEventEntry(entryRow());
    expect(entry.status).toBe('SUBMITTED');
    expect(entry.ageEligible).toBeNull();
    expect(entry.overallEligible).toBeNull();
    expect(entry.calculatedAge).toBeNull();
    expect(entry.eligibilityReason).toBeNull();
  });

  it('refuses a row missing any of the three things it connects', () => {
    for (const column of ['id', 'event_id', 'participant_id', 'form_version_id'] as const) {
      expect(() => rowToEventEntry(entryRow({ [column]: '' })), column).toThrow(/identifiers/i);
    }
  });

  it('refuses a status the state machine does not model', () => {
    for (const status of ['WINNER', 'NON_WINNER', 'submitted', '']) {
      expect(() => rowToEventEntry(entryRow({ status })), status).toThrow(/status/);
    }
  });

  it('refuses an impossible age and a half-boolean', () => {
    expect(() => rowToEventEntry(entryRow({ calculated_age: -1 }))).toThrow(/calculated_age/);
    expect(() => rowToEventEntry(entryRow({ calculated_age: 999 }))).toThrow(/calculated_age/);
    expect(() => rowToEventEntry(entryRow({ calculated_age: 3.5 }))).toThrow(/calculated_age/);
    expect(() => rowToEventEntry(entryRow({ age_eligible: 2 }))).toThrow(/age_eligible/);
    expect(() => rowToEventEntry(entryRow({ overall_eligible: -1 }))).toThrow(
      /overall_eligible/,
    );
  });

  it('refuses a reason that is not one the domain can produce', () => {
    // Free text here would be a verdict nobody can act on: an operator cannot
    // filter it, translate it, or explain it to the person it excluded.
    for (const bad of ['below the minimum age', 'x'.repeat(500), 'ELIGIBLE_MAYBE', '']) {
      expect(
        () => rowToEventEntry(entryRow({ eligibility_reason: bad })),
        bad,
      ).toThrow(/eligibility_reason/);
    }
  });

  it('refuses a row whose verdict contradicts itself', () => {
    // These are the combinations that can be spotted from the ROW ALONE.
    expect(() =>
      rowToEventEntry(entryRow({ status: 'ELIGIBLE', overall_eligible: 0 })),
    ).toThrow(/ELIGIBLE/);
    expect(() =>
      rowToEventEntry(
        entryRow({
          status: 'INELIGIBLE',
          overall_eligible: 1,
          eligibility_reason: 'AGE_REQUIREMENT_NOT_MET',
        }),
      ),
    ).toThrow(/INELIGIBLE/);
    // Excluded without saying why.
    expect(() =>
      rowToEventEntry(
        entryRow({ status: 'INELIGIBLE', overall_eligible: 0, eligibility_reason: null }),
      ),
    ).toThrow(/without a reason/);
    // An age rule was applied to an age that was never recorded.
    expect(() =>
      rowToEventEntry(entryRow({ age_eligible: 1, calculated_age: null })),
    ).toThrow(/age it does not record/);
  });

  it('refuses a naive timestamp', () => {
    expect(() => rowToEventEntry(entryRow({ submitted_at: '2026-01-01' }))).toThrow(
      /submitted_at/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('rowToEntryAnswer', () => {
  it('maps each stored shape back to a value', () => {
    expect(rowToEntryAnswer(answerRow()).value).toBe('ana@example.com');
    expect(rowToEntryAnswer(answerRow({ answer_type: 'NUMBER', answer_value: '42' })).value).toBe(
      42,
    );
    expect(
      rowToEntryAnswer(answerRow({ answer_type: 'YES_NO', answer_value: 'false' })).value,
    ).toBe(false);
    expect(
      rowToEntryAnswer(
        answerRow({ answer_type: 'MULTI_SELECT', answer_value: '["a","b"]' }),
      ).value,
    ).toEqual(['a', 'b']);
  });

  it('refuses a stored value that is not readable, rather than blanking it', () => {
    // Degrading a corrupt answer to "no answer" would silently turn a reply
    // into a blank — exactly the quiet loss an entry exists to prevent.
    for (const bad of [null, '', '{not json', '{"a":1}', '[1,2]']) {
      expect(() =>
        rowToEntryAnswer(answerRow({ answer_value: bad as string })),
        String(bad),
      ).toThrow();
    }
  });

  it('strips a prototype-pollution key rather than reviving it', () => {
    const answer = rowToEntryAnswer(
      answerRow({ answer_type: 'SHORT_TEXT', answer_value: '"__proto__"' }),
    );
    // The VALUE may legitimately be that string; what must never happen is the
    // key reaching an object graph. `parseJson` is what guarantees it.
    expect(answer.value).toBe('__proto__');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it('refuses a type that is not a question type, and the one that takes no answer', () => {
    expect(() => rowToEntryAnswer(answerRow({ answer_type: 'NONSENSE' }))).toThrow(/answer_type/);
    expect(() => rowToEntryAnswer(answerRow({ answer_type: 'INFORMATION' }))).toThrow(
      /answer_type/,
    );
  });

  it('refuses an answer with no key, no label or a naive timestamp', () => {
    expect(() => rowToEntryAnswer(answerRow({ question_key: '' }))).toThrow(/question_key/);
    expect(() => rowToEntryAnswer(answerRow({ question_label_snapshot: '' }))).toThrow(
      /question_label_snapshot/,
    );
    expect(() => rowToEntryAnswer(answerRow({ created_at: '2026-01-01' }))).toThrow(
      /created_at/,
    );
    expect(() => rowToEntryAnswer(answerRow({ id: '' }))).toThrow(/identifiers/i);
  });
});

// ---------------------------------------------------------------------------
describe('serializing an answer', () => {
  it('produces canonical JSON for every accepted shape', () => {
    expect(serializeAnswerValue('John')).toEqual({ ok: true, json: '"John"' });
    expect(serializeAnswerValue(42)).toEqual({ ok: true, json: '42' });
    expect(serializeAnswerValue(true)).toEqual({ ok: true, json: 'true' });
    expect(serializeAnswerValue(['one', 'two'])).toEqual({ ok: true, json: '["one","two"]' });
  });

  it('refuses a value too large to store, rather than truncating it', () => {
    // A truncated answer is a different answer.
    const result = serializeAnswerValue('x'.repeat(20_000));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.reason).toBe('too_large');
  });
});

// ---------------------------------------------------------------------------
describe('the repositories, against a real schema', () => {
  let db: TestDatabase;

  beforeEach(() => {
    db = createTestDatabase();
    db.raw.exec(`
      INSERT INTO admin_users (id, email, normalized_email, display_name, password_hash)
      VALUES ('u1','a@x.com','a@x.com','A','h');
      INSERT INTO events (id, slug, name, timezone, status, created_by, updated_by, created_at, updated_at)
      VALUES ('ev1','ev','Event','UTC','OPEN','u1','u1','${AT}','${AT}');
      INSERT INTO event_form_versions
        (id, event_id, version_number, source_draft_revision, published_by, published_at, schema_snapshot, created_at)
      VALUES ('v1','ev1',1,1,'u1','${AT}','{}','${AT}');
      INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
      VALUES ('s1','VERSION','v1','Step',0,'${AT}','${AT}');
      INSERT INTO form_questions
        (id, form_owner_type, form_owner_id, step_id, key, system_field, type, label, sort_order, created_at, updated_at)
      VALUES ('q1','VERSION','v1','s1','email','EMAIL','EMAIL','Email',0,'${AT}','${AT}');
      INSERT INTO participants (id, email, normalized_email, first_name, last_name, created_at, updated_at)
      VALUES ('p1','Ana@Example.com','ana@example.com','Ana','Lopez','${AT}','${AT}');
      INSERT INTO event_entries
        (id, event_id, participant_id, form_version_id, status, submitted_at, created_at, updated_at)
      VALUES ('e1','ev1','p1','v1','SUBMITTED','${AT}','${AT}','${AT}');
    `);
  });

  afterEach(() => db.close());

  it('finds a participant by the canonical address and by nothing else', async () => {
    const repository = new ParticipantRepository(db.d1);
    expect((await repository.findByNormalizedEmail('ana@example.com'))?.id).toBe('p1');
    // The caller normalises; this is not the place to do it, because a lookup
    // that normalised differently from the write would silently miss.
    expect(await repository.findByNormalizedEmail('Ana@Example.com')).toBeNull();
    expect(await repository.findById('missing')).toBeNull();
    expect(await repository.count()).toBe(1);
    expect((await repository.list({ page: 1, pageSize: 10 })).items).toHaveLength(1);
  });

  it('a profile update cannot change who somebody is', async () => {
    const repository = new ParticipantRepository(db.d1);
    await db.d1.batch([
      repository.updateProfileStatement('p1', {
        email: 'ANA@example.com',
        firstName: 'Ana Maria',
        lastName: 'Lopez',
        // COALESCE: a form that did not ask cannot erase what an earlier one
        // recorded.
        phone: null,
        dateOfBirth: null,
        at: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    const stored = await repository.findById('p1');
    expect(stored?.firstName).toBe('Ana Maria');
    expect(stored?.email).toBe('ANA@example.com');
    // The identity key is untouched, so the person is still the same person.
    expect(stored?.normalizedEmail).toBe('ana@example.com');
  });

  it('scopes an entry through its event', async () => {
    const repository = new EventEntryRepository(db.d1);
    expect((await repository.findByEventAndId('ev1', 'e1'))?.id).toBe('e1');
    expect(await repository.findByEventAndId('other', 'e1')).toBeNull();
    expect((await repository.findByEventAndParticipant('ev1', 'p1'))?.id).toBe('e1');
    expect(await repository.countByEvent('ev1')).toBe(1);
    expect(await repository.hasEntries('ev1')).toBe(true);
    expect(await repository.hasEntries('other')).toBe(false);
  });

  it('the eligibility seam re-judges an entry and cannot re-home it', async () => {
    // The REGISTRATION path does not use this: an entry is born decided. It
    // survives for the administrative correction flow a later phase needs, and
    // what matters is that it can change a verdict and nothing else.
    const repository = new EventEntryRepository(db.d1);
    await db.d1.batch([
      repository.applyEligibilityStatement('e1', {
        status: 'INELIGIBLE',
        calculatedAge: 17,
        ageEligible: false,
        overallEligible: false,
        eligibilityReason: 'AGE_REQUIREMENT_NOT_MET',
        at: '2026-02-01T00:00:00.000Z',
      }),
    ]);

    const stored = await repository.findByEventAndId('ev1', 'e1');
    expect(stored?.status).toBe('INELIGIBLE');
    expect(stored?.calculatedAge).toBe(17);
    expect(stored?.ageEligible).toBe(false);
    // What the entry IS — whose it is, which event, which form — did not move.
    expect(stored?.eventId).toBe('ev1');
    expect(stored?.participantId).toBe('p1');
    expect(stored?.formVersionId).toBe('v1');
    expect(stored?.submittedAt).toBe(AT);
  });

  it('writes answers in groups, not one statement per row', async () => {
    const repository = new EntryAnswerRepository(db.d1);
    const rows = Array.from({ length: 120 }, (_, index) => ({
      id: `a-${index}`,
      entryId: 'e1',
      questionId: 'q1',
      questionKey: 'email',
      questionLabel: 'Email',
      answerType: 'EMAIL' as const,
      answerValue: '"a@b.com"',
      at: AT,
    }));

    // 120 rows at 50 per statement. One statement per row would make every
    // registration a bet on how many statements a batch will carry.
    const statements = repository.insertStatements(rows);
    expect(statements).toHaveLength(3);
    expect(repository.insertStatements([])).toHaveLength(0);
  });

  it('reads answers back in the order the form asked them', async () => {
    db.raw.exec(`
      INSERT INTO form_steps (id, form_owner_type, form_owner_id, title, sort_order, created_at, updated_at)
      VALUES ('s2','VERSION','v1','Later',1,'${AT}','${AT}');
      INSERT INTO form_questions
        (id, form_owner_type, form_owner_id, step_id, key, system_field, type, label, sort_order, created_at, updated_at)
      VALUES ('q2','VERSION','v1','s2','city','NONE','SHORT_TEXT','City',0,'${AT}','${AT}');
    `);

    const repository = new EntryAnswerRepository(db.d1);
    // Inserted in the WRONG order on purpose.
    await db.d1.batch(
      repository.insertStatements([
        {
          id: 'a-city',
          entryId: 'e1',
          questionId: 'q2',
          questionKey: 'city',
          questionLabel: 'City',
          answerType: 'SHORT_TEXT',
          answerValue: '"Madrid"',
          at: AT,
        },
        {
          id: 'a-email',
          entryId: 'e1',
          questionId: 'q1',
          questionKey: 'email',
          questionLabel: 'Email',
          answerType: 'EMAIL',
          answerValue: '"a@b.com"',
          at: AT,
        },
      ]),
    );

    const answers = await repository.listByEntry('e1');
    expect(answers.map((answer) => answer.questionKey)).toEqual(['email', 'city']);
    expect(await repository.countByEntry('e1')).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('the mapper and a decision that contradicts itself', () => {
  it('refuses every incoherent combination the contract names', () => {
    const bad: Array<[string, Partial<EventEntryRow>]> = [
      ['eligible but not', { status: 'ELIGIBLE', overall_eligible: 0 }],
      [
        'ineligible but not',
        {
          status: 'INELIGIBLE',
          overall_eligible: 1,
          eligibility_reason: 'AGE_REQUIREMENT_NOT_MET',
        },
      ],
      [
        'excluded without a reason',
        { status: 'INELIGIBLE', overall_eligible: 0, eligibility_reason: null },
      ],
      ['judged an age it never recorded', { age_eligible: 0, calculated_age: null }],
      ['half-boolean age verdict', { age_eligible: 2 }],
      ['half-boolean verdict', { overall_eligible: 2 }],
      ['negative age', { calculated_age: -1 }],
      ['implausible age', { calculated_age: 131 }],
      ['a reason nothing produces', { eligibility_reason: 'MAYBE' }],
    ];

    for (const [label, overrides] of bad) {
      expect(() => rowToEventEntry(entryRow(overrides)), label).toThrow();
    }
  });

  it('accepts the coherent shapes, including the historical one', () => {
    const good: Array<[string, Partial<EventEntryRow>]> = [
      [
        'eligible with an age rule',
        {
          status: 'ELIGIBLE',
          calculated_age: 21,
          age_eligible: 1,
          overall_eligible: 1,
          eligibility_reason: 'ELIGIBLE',
        },
      ],
      [
        'eligible with no age rule',
        {
          status: 'ELIGIBLE',
          calculated_age: 30,
          age_eligible: null,
          overall_eligible: 1,
          eligibility_reason: 'ELIGIBLE',
        },
      ],
      [
        'ineligible by age',
        {
          status: 'INELIGIBLE',
          calculated_age: 20,
          age_eligible: 0,
          overall_eligible: 0,
          eligibility_reason: 'AGE_REQUIREMENT_NOT_MET',
        },
      ],
      // Phase 7 history: recorded, never judged. Must stay readable forever.
      ['historical', {}],
    ];

    for (const [label, overrides] of good) {
      expect(() => rowToEventEntry(entryRow(overrides)), label).not.toThrow();
    }
  });
});

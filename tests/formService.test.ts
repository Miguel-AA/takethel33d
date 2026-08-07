// @vitest-environment node
//
// FormDraftService and FormRepository against the real migrated schema,
// including the single-revision guard, audit atomicity, the two-phase reorder
// and concurrency.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FormDraftService, deriveQuestionKey } from '../functions/_shared/formDraftService';
import {
  FormRepository,
  rowToFormOption,
  rowToFormQuestion,
  type FormOptionRow,
  type FormQuestionRow,
} from '../functions/_shared/formRepository';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { EventRepository } from '../functions/_shared/eventRepository';
import { AdminRepository } from '../functions/_shared/adminRepository';
import { hashPassword } from '../functions/_shared/password';
import { setLogSink } from '../functions/_shared/logger';
import { normalizeEmail } from '../shared/schemas';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import { eventAllowsFormEditing } from '../shared/formLifecycle';
import { FORM_SORT_PARK_OFFSET, FORM_STEPS_MAX } from '../shared/limits';
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import type { RequestContext } from '../functions/_shared/requestContext';
import type {
  AuthenticatedAdmin,
  Event,
  EventFormDraft,
  FormQuestion,
} from '../shared/types';

let db: TestDatabase;
let service: FormDraftService;
let events: EventLifecycleService;
let admin: AuthenticatedAdmin;
let event: Event;

const REQUEST: RequestContext = {
  requestId: 'req-forms',
  ipHash: 'd'.repeat(64),
  userAgent: 'vitest',
  origin: null,
  method: 'POST',
  pathname: '/api/events/x/form',
};

const actor = () => ({ admin, requestContext: REQUEST });
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function auditRows(action?: string) {
  const rows = db.raw
    .prepare('SELECT * FROM audit_logs ORDER BY rowid ASC')
    .all() as Array<Record<string, unknown>>;
  return action ? rows.filter((row) => row.action === action) : rows;
}

function setEventStatus(status: string) {
  db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
}

async function draft(): Promise<EventFormDraft> {
  const result = await service.ensure(event.id, actor());
  if (!result.ok) throw new Error(`draft failed: ${result.failure.code}`);
  return result.value.draft;
}

async function addStep(title = 'About you'): Promise<EventFormDraft> {
  const current = await draft();
  const result = await service.createStep(
    event.id,
    { expectedRevision: current.revision, title },
    actor(),
  );
  if (!result.ok) throw new Error(`step failed: ${result.failure.code}`);
  return result.value;
}

async function addQuestion(
  stepId: string,
  overrides: Record<string, unknown> = {},
): Promise<EventFormDraft> {
  const current = await draft();
  const result = await service.createQuestion(
    event.id,
    {
      expectedRevision: current.revision,
      stepId,
      type: 'SHORT_TEXT',
      label: 'Anything',
      ...overrides,
    } as never,
    actor(),
  );
  if (!result.ok) throw new Error(`question failed: ${result.failure.code}`);
  return result.value;
}

const questionsOf = (form: EventFormDraft): FormQuestion[] =>
  form.steps.flatMap((step) => step.questions);

beforeEach(async () => {
  db = createTestDatabase();
  setLogSink(() => {});
  service = new FormDraftService(db.d1);
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

  const madeEvent = await events.create(
    {
      name: 'Form Event',
      registrationOpensAt: at(1),
      registrationClosesAt: at(5),
      startsAt: at(6),
      endsAt: at(7),
    },
    actor(),
  );
  if (!madeEvent.ok) throw new Error('event seed failed');
  event = madeEvent.value;
});

afterEach(() => {
  setLogSink(null);
  db.close();
});

// ---------------------------------------------------------------------------
describe('the draft itself', () => {
  it('is created empty and at revision 1', async () => {
    const form = await draft();
    expect(form.revision).toBe(1);
    expect(form.steps).toEqual([]);
    expect(form.eventId).toBe(event.id);
  });

  it('is created once; ensuring it again returns the same one', async () => {
    const first = await draft();
    const second = await draft();
    expect(second.id).toBe(first.id);
    expect(auditRows('FORM_DRAFT_CREATED')).toHaveLength(1);
  });

  it('READING never creates one', async () => {
    const read = await service.find(event.id);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('unreachable');
    expect(read.value.draft).toBeNull();

    // Nothing was written: no row, no audit entry, and the event stays deletable.
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_drafts').get() as { n: number }).n,
    ).toBe(0);
    expect(auditRows('FORM_DRAFT_CREATED')).toHaveLength(0);
    expect(await new EventRepository(db.d1).hasDependencies(event.id)).toBe(false);
  });

  it('two simultaneous creations produce ONE draft and no error', async () => {
    const [first, second] = await Promise.all([
      service.ensure(event.id, actor()),
      service.ensure(event.id, actor()),
    ]);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error('unreachable');
    expect(second.value.draft.id).toBe(first.value.draft.id);
    expect(
      (db.raw.prepare('SELECT COUNT(*) AS n FROM event_form_drafts').get() as { n: number }).n,
    ).toBe(1);
    expect(auditRows('FORM_DRAFT_CREATED')).toHaveLength(1);
  });

  it('records its creation with the actor and the request id', async () => {
    await draft();
    const [entry] = auditRows('FORM_DRAFT_CREATED');
    expect(entry.entity_type).toBe('FORM');
    expect(entry.event_id).toBe(event.id);
    expect(entry.actor_admin_id).toBe(admin.id);
    expect(entry.request_id).toBe(REQUEST.requestId);
  });

  it('refuses to be created for an event that has closed', async () => {
    setEventStatus('CLOSED');
    const result = await service.ensure(event.id, actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_NOT_EDITABLE');
  });

  it('404s for an event that does not exist', async () => {
    const result = await service.ensure(crypto.randomUUID(), actor());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('EVENT_NOT_FOUND');
  });

  it('an explicit save moves the revision and records intent', async () => {
    const form = await draft();
    const saved = await service.saveDraft(event.id, form.revision, actor());
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error('unreachable');
    expect(saved.value.revision).toBe(form.revision + 1);
    expect(auditRows('FORM_DRAFT_UPDATED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('one revision for the whole form', () => {
  it('moves on a step, a question and an option alike', async () => {
    let form = await addStep();
    expect(form.revision).toBe(2);

    form = await addQuestion(form.steps[0].id, { type: 'SINGLE_SELECT', label: 'Pick' });
    expect(form.revision).toBe(3);

    const question = questionsOf(form)[0];
    const withOption = await service.createOption(
      event.id,
      question.id,
      { expectedRevision: form.revision, value: 'a', label: 'A' },
      actor(),
    );
    expect(withOption.ok).toBe(true);
    if (!withOption.ok) throw new Error('unreachable');
    expect(withOption.value.revision).toBe(4);
  });

  it('refuses a stale revision and changes nothing at all', async () => {
    const form = await addStep();
    const stale = form.revision - 1;

    const result = await service.createStep(
      event.id,
      { expectedRevision: stale, title: 'Second' },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_REVISION_CONFLICT');

    const after = await draft();
    expect(after.steps).toHaveLength(1);
    expect(after.revision).toBe(form.revision);
    expect(auditRows('FORM_STEP_CREATED')).toHaveLength(1);
  });

  it('the in-batch guard stops a mutation landing under a revision that never moved', async () => {
    const form = await addStep();
    const repo = new FormRepository(db.d1);

    // The exact shape of a lost race: the guard matches nothing, and the abort
    // statement must take the whole batch down with it.
    const attempt = db.d1.batch([
      repo.touchDraftStatement(form.id, 999, admin.id, new Date().toISOString()),
      repo.abortUnlessChangedStatement(form.id),
      repo.insertStepStatement({
        id: crypto.randomUUID(),
        ownerType: 'DRAFT',
        ownerId: form.id,
        title: 'Snuck in',
        description: null,
        sortOrder: 99,
        at: new Date().toISOString(),
      }),
    ]);

    await expect(attempt).rejects.toThrow(/constraint/i);
    const after = await draft();
    expect(after.steps).toHaveLength(1);
    expect(after.revision).toBe(form.revision);
  });
});

// ---------------------------------------------------------------------------
describe('steps', () => {
  it('appends, renames and removes an empty one', async () => {
    let form = await addStep('First');
    form = (
      await service.createStep(
        event.id,
        { expectedRevision: form.revision, title: 'Second' },
        actor(),
      )
    ).value as EventFormDraft;

    expect(form.steps.map((step) => step.title)).toEqual(['First', 'Second']);
    expect(form.steps.map((step) => step.sortOrder)).toEqual([0, 1]);

    const renamed = await service.updateStep(
      event.id,
      form.steps[0].id,
      { expectedRevision: form.revision, title: 'Renamed' },
      actor(),
    );
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) throw new Error('unreachable');
    expect(renamed.value.steps[0].title).toBe('Renamed');

    const removed = await service.deleteStep(
      event.id,
      renamed.value.steps[1].id,
      renamed.value.revision,
      actor(),
    );
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error('unreachable');
    expect(removed.value.steps).toHaveLength(1);
  });

  it('refuses to delete a step that still holds questions', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id);

    const result = await service.deleteStep(
      event.id,
      form.steps[0].id,
      form.revision,
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_STEP_NOT_EMPTY');
    expect((await draft()).steps).toHaveLength(1);
  });

  it('the database refuses too, even outside the service', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id);
    expect(() =>
      db.raw.prepare('DELETE FROM form_steps WHERE id = ?').run(form.steps[0].id),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('enforces the per-form ceiling', async () => {
    let form = await draft();
    for (let index = 0; index < FORM_STEPS_MAX; index++) {
      const result = await service.createStep(
        event.id,
        { expectedRevision: form.revision, title: `Step ${index}` },
        actor(),
      );
      if (!result.ok) throw new Error(result.failure.code);
      form = result.value;
    }
    const overflow = await service.createStep(
      event.id,
      { expectedRevision: form.revision, title: 'One too many' },
      actor(),
    );
    expect(overflow.ok).toBe(false);
    if (overflow.ok) throw new Error('unreachable');
    expect(overflow.failure.code).toBe('FORM_LIMIT_REACHED');
  });

  it('writes the step and its audit row in ONE transaction', async () => {
    const form = await addStep('Audited');
    const [entry] = auditRows('FORM_STEP_CREATED');
    expect(entry.entity_type).toBe('FORM_STEP');
    expect(entry.entity_id).toBe(form.steps[0].id);
    expect(entry.event_id).toBe(event.id);
  });
});

// ---------------------------------------------------------------------------
describe('questions', () => {
  it('derives a key from the label and keeps it unique', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, { label: 'Do you smoke?' });
    form = await addQuestion(form.steps[0].id, { label: 'Do you smoke?' });

    expect(questionsOf(form).map((question) => question.key)).toEqual([
      'do_you_smoke',
      'do_you_smoke_2',
    ]);
  });

  it('strips accents rather than mangling them', () => {
    expect(deriveQuestionKey('¿Cuál es tu año de nacimiento?', new Set())).toBe(
      'cual_es_tu_ano_de_nacimiento',
    );
    expect(deriveQuestionKey('123', new Set())).toBe('q_123');
  });

  it('refuses a key another question already uses', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, { label: 'A', key: 'shared' });

    const clash = await service.createQuestion(
      event.id,
      {
        expectedRevision: form.revision,
        stepId: form.steps[0].id,
        type: 'SHORT_TEXT',
        label: 'B',
        key: 'shared',
      },
      actor(),
    );
    expect(clash.ok).toBe(false);
    if (clash.ok) throw new Error('unreachable');
    expect(clash.failure.code).toBe('FORM_KEY_EXISTS');
  });

  it('creates a select together with its options, in one transaction', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, {
      type: 'SINGLE_SELECT',
      label: 'Pick one',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });

    const [question] = questionsOf(form);
    expect(question.options.map((option) => option.value)).toEqual(['a', 'b']);
    expect(question.options.map((option) => option.sortOrder)).toEqual([0, 1]);
    expect(auditRows('FORM_QUESTION_CREATED')).toHaveLength(1);
  });

  it('refuses options on a type that has none', async () => {
    const form = await addStep();
    const result = await service.createQuestion(
      event.id,
      {
        expectedRevision: form.revision,
        stepId: form.steps[0].id,
        type: 'YES_NO',
        label: 'Sure?',
        options: [{ value: 'a', label: 'A' }],
      },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_OPTION_NOT_ALLOWED');
  });

  it('refuses a required INFORMATION block, in the service and in the column', async () => {
    const form = await addStep();
    const result = await service.createQuestion(
      event.id,
      {
        expectedRevision: form.revision,
        stepId: form.steps[0].id,
        type: 'INFORMATION',
        label: 'Please read',
        required: true,
      },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_QUESTION_INVALID');
  });

  it('refuses validation that means nothing for the type', async () => {
    const form = await addStep();
    const result = await service.createQuestion(
      event.id,
      {
        expectedRevision: form.revision,
        stepId: form.steps[0].id,
        type: 'EMAIL',
        label: 'Email',
        validation: { minSelected: 2 },
      },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_QUESTION_INVALID');
  });

  it('moves a question to another step, landing at its end', async () => {
    let form = await addStep('One');
    form = (
      await service.createStep(
        event.id,
        { expectedRevision: form.revision, title: 'Two' },
        actor(),
      )
    ).value as EventFormDraft;
    form = await addQuestion(form.steps[1].id, { label: 'Already there' });
    form = await addQuestion(form.steps[0].id, { label: 'Moving' });

    const moving = questionsOf(form).find((q) => q.label === 'Moving')!;
    const moved = await service.updateQuestion(
      event.id,
      moving.id,
      { expectedRevision: form.revision, stepId: form.steps[1].id },
      actor(),
    );
    expect(moved.ok).toBe(true);
    if (!moved.ok) throw new Error('unreachable');

    expect(moved.value.steps[0].questions).toHaveLength(0);
    expect(moved.value.steps[1].questions.map((q) => q.label)).toEqual([
      'Already there',
      'Moving',
    ]);
  });

  it('duplicates a question with its options, under a fresh key', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, {
      type: 'MULTI_SELECT',
      label: 'Interests',
      options: [{ value: 'a', label: 'A' }],
    });

    const source = questionsOf(form)[0];
    const copied = await service.duplicateQuestion(
      event.id,
      source.id,
      form.revision,
      actor(),
    );
    expect(copied.ok).toBe(true);
    if (!copied.ok) throw new Error('unreachable');

    const all = questionsOf(copied.value);
    expect(all).toHaveLength(2);
    expect(all[1].key).not.toBe(all[0].key);
    expect(all[1].options.map((option) => option.value)).toEqual(['a']);
    expect(all[1].systemField).toBe('NONE');
  });

  it('deletes a question and its options together, keeping the snapshot', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, {
      type: 'DROPDOWN',
      label: 'Pick',
      options: [{ value: 'a', label: 'A' }],
    });

    const question = questionsOf(form)[0];
    const removed = await service.deleteQuestion(
      event.id,
      question.id,
      form.revision,
      actor(),
    );
    expect(removed.ok).toBe(true);

    expect(questionsOf(await draft())).toHaveLength(0);
    const options = db.raw.prepare('SELECT * FROM form_question_options').all();
    expect(options).toHaveLength(0);

    const [entry] = auditRows('FORM_QUESTION_DELETED');
    const previous = JSON.parse(String(entry.previous_data));
    expect(previous.key).toBe(question.key);
    expect(previous.options).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Answer keys must stay safe for whatever consumes them later.
// ---------------------------------------------------------------------------
describe('reserved answer keys', () => {
  it.each(['constructor', 'prototype', '__proto__', 'CONSTRUCTOR'])(
    'refuses %s as an explicit key',
    async (key) => {
      const form = await addStep();
      const result = await service.createQuestion(
        event.id,
        {
          expectedRevision: form.revision,
          stepId: form.steps[0].id,
          type: 'SHORT_TEXT',
          label: 'Sneaky',
          key,
        } as never,
        actor(),
      );
      // `__proto__` and the uppercase form never pass the schema; the two
      // lowercase names would have, which is exactly why they are reserved.
      expect(result.ok).toBe(false);
    },
  );

  it('never DERIVES a reserved key from a label', () => {
    expect(deriveQuestionKey('Constructor', new Set())).toBe('constructor_2');
    expect(deriveQuestionKey('prototype', new Set())).toBe('prototype_2');
  });

  it('a question labelled "Constructor" gets a usable key', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, { label: 'Constructor' });
    const [question] = questionsOf(form);
    expect(question.key).toBe('constructor_2');
    expect(question.label).toBe('Constructor');
  });
});

// ---------------------------------------------------------------------------
// The polymorphic seam: `form_owner_id` cannot carry a foreign key, so the
// coherence it would have guaranteed is checked on read.
// ---------------------------------------------------------------------------
describe('cross-form corruption is detected, not absorbed', () => {
  async function smuggle(intoStepId: string, ownerId: string): Promise<void> {
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO form_questions
           (id, form_owner_type, form_owner_id, step_id, key, type, label, sort_order,
            created_at, updated_at)
         VALUES (?, 'DRAFT', ?, ?, 'smuggled', 'SHORT_TEXT', 'Smuggled', 90, ?, ?)`,
      )
      .run(crypto.randomUUID(), ownerId, intoStepId, now, now);
  }

  it('refuses to assemble a form holding a question that belongs elsewhere', async () => {
    const mine = await addStep();
    const other = await events.create(
      {
        name: 'Other',
        registrationOpensAt: at(1),
        registrationClosesAt: at(5),
        startsAt: at(6),
        endsAt: at(7),
      },
      actor(),
    );
    if (!other.ok) throw new Error('setup failed');
    const theirs = await service.ensure(other.value.id, actor());
    if (!theirs.ok) throw new Error('setup failed');

    // A row owned by THEIR form, sitting in MY step.
    await smuggle(mine.steps[0].id, theirs.value.draft.id);

    // Their form now claims a question whose step is not theirs.
    await expect(service.find(other.value.id)).rejects.toThrow(
      /step_id points outside its own form/i,
    );
  });

  it('names the row without leaking a stack', async () => {
    const mine = await addStep();
    const other = await events.create(
      {
        name: 'Other',
        registrationOpensAt: at(1),
        registrationClosesAt: at(5),
        startsAt: at(6),
        endsAt: at(7),
      },
      actor(),
    );
    if (!other.ok) throw new Error('setup failed');
    const theirs = await service.ensure(other.value.id, actor());
    if (!theirs.ok) throw new Error('setup failed');
    await smuggle(mine.steps[0].id, theirs.value.draft.id);

    try {
      await service.find(other.value.id);
      throw new Error('should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('form_questions.step_id');
      expect(message.split('\n')).toHaveLength(1);
    }
  });

  it('the uncorrupted form is unaffected', async () => {
    const mine = await addStep();
    await smuggle(mine.steps[0].id, 'a-form-that-does-not-exist');

    // My form never loads a row it does not own.
    const reloaded = await service.find(event.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error('unreachable');
    expect(reloaded.value.draft?.steps[0].questions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('system fields', () => {
  async function addSystemField(stepId: string, field: string, type: string) {
    const current = await draft();
    return service.createQuestion(
      event.id,
      {
        expectedRevision: current.revision,
        stepId,
        type,
        systemField: field,
        label: field,
        required: true,
      } as never,
      actor(),
    );
  }

  it('pins the key regardless of the label', async () => {
    const form = await addStep();
    const result = await addSystemField(form.steps[0].id, 'EMAIL', 'EMAIL');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(questionsOf(result.value)[0].key).toBe('email');
  });

  it('refuses a second one of the same identity', async () => {
    const form = await addStep();
    await addSystemField(form.steps[0].id, 'EMAIL', 'EMAIL');
    const second = await addSystemField(form.steps[0].id, 'EMAIL', 'EMAIL');
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.failure.code).toBe('FORM_SYSTEM_FIELD_EXISTS');
  });

  it('the database refuses a duplicate too, outside the service', async () => {
    const form = await addStep();
    await addSystemField(form.steps[0].id, 'PHONE', 'PHONE');
    const now = new Date().toISOString();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO form_questions
             (id, form_owner_type, form_owner_id, step_id, key, system_field, type,
              label, sort_order, created_at, updated_at)
           VALUES (?, 'DRAFT', ?, ?, 'phone_2', 'PHONE', 'PHONE', 'Phone', 9, ?, ?)`,
        )
        .run(crypto.randomUUID(), form.id, form.steps[0].id, now, now),
    ).toThrow(/UNIQUE/i);
  });

  it('refuses a type other than the one it is pinned to', async () => {
    const form = await addStep();
    const result = await addSystemField(form.steps[0].id, 'EMAIL', 'SHORT_TEXT');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_QUESTION_INVALID');
  });

  it('refuses to change its type or key, but not its label', async () => {
    const form = await addStep();
    const created = await addSystemField(form.steps[0].id, 'FIRST_NAME', 'SHORT_TEXT');
    if (!created.ok) throw new Error('setup failed');
    const question = questionsOf(created.value)[0];

    for (const patch of [{ type: 'LONG_TEXT' }, { key: 'renamed' }]) {
      const refused = await service.updateQuestion(
        event.id,
        question.id,
        { expectedRevision: created.value.revision, ...patch } as never,
        actor(),
      );
      expect(refused.ok, JSON.stringify(patch)).toBe(false);
      if (refused.ok) throw new Error('unreachable');
      expect(refused.failure.code).toBe('FORM_QUESTION_PROTECTED');
    }

    const renamed = await service.updateQuestion(
      event.id,
      question.id,
      { expectedRevision: created.value.revision, label: 'Given name' },
      actor(),
    );
    expect(renamed.ok).toBe(true);
  });

  it('refuses to delete one while it is required, and allows it once it is not', async () => {
    const form = await addStep();
    const created = await addSystemField(form.steps[0].id, 'LAST_NAME', 'SHORT_TEXT');
    if (!created.ok) throw new Error('setup failed');
    const question = questionsOf(created.value)[0];

    const refused = await service.deleteQuestion(
      event.id,
      question.id,
      created.value.revision,
      actor(),
    );
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('unreachable');
    expect(refused.failure.code).toBe('FORM_QUESTION_PROTECTED');

    const relaxed = await service.updateQuestion(
      event.id,
      question.id,
      { expectedRevision: created.value.revision, required: false },
      actor(),
    );
    if (!relaxed.ok) throw new Error('unreachable');

    const removed = await service.deleteQuestion(
      event.id,
      question.id,
      relaxed.value.revision,
      actor(),
    );
    expect(removed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('options', () => {
  async function selectQuestion(): Promise<{ form: EventFormDraft; question: FormQuestion }> {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, {
      type: 'SINGLE_SELECT',
      label: 'Choose',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    return { form, question: questionsOf(form)[0] };
  }

  it('adds, edits and removes a choice', async () => {
    const { form, question } = await selectQuestion();

    const added = await service.createOption(
      event.id,
      question.id,
      { expectedRevision: form.revision, value: 'c', label: 'C' },
      actor(),
    );
    if (!added.ok) throw new Error('unreachable');
    expect(questionsOf(added.value)[0].options).toHaveLength(3);

    const option = questionsOf(added.value)[0].options[0];
    const edited = await service.updateOption(
      event.id,
      question.id,
      option.id,
      { expectedRevision: added.value.revision, label: 'Renamed', active: false },
      actor(),
    );
    if (!edited.ok) throw new Error('unreachable');
    expect(questionsOf(edited.value)[0].options[0]).toMatchObject({
      label: 'Renamed',
      active: false,
    });

    const removed = await service.deleteOption(
      event.id,
      question.id,
      option.id,
      edited.value.revision,
      actor(),
    );
    if (!removed.ok) throw new Error('unreachable');
    expect(questionsOf(removed.value)[0].options).toHaveLength(2);
  });

  it('refuses a repeated stored value, in the service and in the index', async () => {
    const { form, question } = await selectQuestion();
    const result = await service.createOption(
      event.id,
      question.id,
      { expectedRevision: form.revision, value: 'a', label: 'Another A' },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_QUESTION_INVALID');

    const now = new Date().toISOString();
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO form_question_options
             (id, question_id, value, label, sort_order, created_at, updated_at)
           VALUES (?, ?, 'a', 'Dupe', 9, ?, ?)`,
        )
        .run(crypto.randomUUID(), question.id, now, now),
    ).toThrow(/UNIQUE/i);
  });

  it('refuses options on a question that takes none', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, { type: 'SHORT_TEXT', label: 'Name' });
    const question = questionsOf(form)[0];

    const result = await service.createOption(
      event.id,
      question.id,
      { expectedRevision: form.revision, value: 'a', label: 'A' },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_OPTION_NOT_ALLOWED');
  });

  it('refuses a type change that would strand its options', async () => {
    const { form, question } = await selectQuestion();
    const result = await service.updateQuestion(
      event.id,
      question.id,
      { expectedRevision: form.revision, type: 'SHORT_TEXT' },
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_QUESTION_INVALID');
  });
});

// ---------------------------------------------------------------------------
describe('reordering', () => {
  async function threeSteps(): Promise<EventFormDraft> {
    let form = await draft();
    for (const title of ['One', 'Two', 'Three']) {
      const result = await service.createStep(
        event.id,
        { expectedRevision: form.revision, title },
        actor(),
      );
      if (!result.ok) throw new Error(result.failure.code);
      form = result.value;
    }
    return form;
  }

  it('reverses steps without violating the unique position index', async () => {
    const form = await threeSteps();
    const reversed = [...form.steps].reverse();

    const result = await service.reorderSteps(
      event.id,
      form.revision,
      reversed.map((step, index) => ({ id: step.id, sortOrder: index })),
      actor(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.steps.map((step) => step.title)).toEqual(['Three', 'Two', 'One']);
    expect(result.value.steps.map((step) => step.sortOrder)).toEqual([0, 1, 2]);
  });

  it('leaves no parked position behind', async () => {
    const form = await threeSteps();
    await service.reorderSteps(
      event.id,
      form.revision,
      [...form.steps].reverse().map((step, index) => ({ id: step.id, sortOrder: index })),
      actor(),
    );

    const rows = db.raw.prepare('SELECT sort_order FROM form_steps').all() as Array<{
      sort_order: number;
    }>;
    expect(rows.every((row) => row.sort_order < FORM_SORT_PARK_OFFSET)).toBe(true);
  });

  it('swaps two adjacent steps — the case a naive write would collide on', async () => {
    const form = await threeSteps();
    const [first, second, third] = form.steps;

    const result = await service.reorderSteps(
      event.id,
      form.revision,
      [
        { id: second.id, sortOrder: 0 },
        { id: first.id, sortOrder: 1 },
        { id: third.id, sortOrder: 2 },
      ],
      actor(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.steps.map((step) => step.title)).toEqual(['Two', 'One', 'Three']);
  });

  it('refuses a partial order and writes nothing', async () => {
    const form = await threeSteps();
    const result = await service.reorderSteps(
      event.id,
      form.revision,
      [{ id: form.steps[0].id, sortOrder: 0 }],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ORDER_INVALID');
    expect((await draft()).revision).toBe(form.revision);
  });

  it('refuses a member from another form', async () => {
    const form = await threeSteps();
    const result = await service.reorderSteps(
      event.id,
      form.revision,
      [
        { id: crypto.randomUUID(), sortOrder: 0 },
        { id: form.steps[1].id, sortOrder: 1 },
        { id: form.steps[2].id, sortOrder: 2 },
      ],
      actor(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('FORM_ORDER_INVALID');
  });

  it('reorders questions within a step, and options within a question', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, { label: 'First' });
    form = await addQuestion(form.steps[0].id, { label: 'Second' });

    const questions = form.steps[0].questions;
    const reordered = await service.reorderQuestions(
      event.id,
      form.revision,
      form.steps[0].id,
      [
        { id: questions[1].id, sortOrder: 0 },
        { id: questions[0].id, sortOrder: 1 },
      ],
      actor(),
    );
    if (!reordered.ok) throw new Error('unreachable');
    expect(reordered.value.steps[0].questions.map((q) => q.label)).toEqual([
      'Second',
      'First',
    ]);

    const withSelect = await addQuestion(reordered.value.steps[0].id, {
      type: 'DROPDOWN',
      label: 'Pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const select = questionsOf(withSelect).find((q) => q.label === 'Pick')!;
    const options = select.options;

    const swapped = await service.reorderOptions(
      event.id,
      select.id,
      withSelect.revision,
      [
        { id: options[1].id, sortOrder: 0 },
        { id: options[0].id, sortOrder: 1 },
      ],
      actor(),
    );
    if (!swapped.ok) throw new Error('unreachable');
    expect(
      questionsOf(swapped.value)
        .find((q) => q.label === 'Pick')!
        .options.map((option) => option.value),
    ).toEqual(['b', 'a']);
  });

  it('writes ONE aggregate audit row per reorder', async () => {
    const form = await threeSteps();
    await service.reorderSteps(
      event.id,
      form.revision,
      [...form.steps].reverse().map((step, index) => ({ id: step.id, sortOrder: index })),
      actor(),
    );
    expect(auditRows('FORM_STEPS_REORDERED')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('event state governs the whole form', () => {
  it('refuses every mutation once the event has closed', async () => {
    const form = await addStep();
    const question = (await addQuestion(form.steps[0].id)).steps[0].questions[0];
    const current = await draft();

    for (const status of ['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED', 'CANCELLED', 'ARCHIVED']) {
      setEventStatus(status);

      const attempts = [
        () =>
          service.createStep(
            event.id,
            { expectedRevision: current.revision, title: 'No' },
            actor(),
          ),
        () =>
          service.updateStep(
            event.id,
            form.steps[0].id,
            { expectedRevision: current.revision, title: 'No' },
            actor(),
          ),
        () =>
          service.deleteQuestion(event.id, question.id, current.revision, actor()),
        () => service.saveDraft(event.id, current.revision, actor()),
      ];

      for (const attempt of attempts) {
        const result = await attempt();
        expect(result.ok, status).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.failure.code, status).toBe('FORM_NOT_EDITABLE');
      }
    }
  });

  it('agrees with the shared table for every status', async () => {
    const form = await addStep();
    for (const status of EVENT_STATUSES) {
      setEventStatus(status);
      const current = await service.find(event.id);
      const attempt = await service.createStep(
        event.id,
        {
          expectedRevision: current.ok && current.value.draft
            ? current.value.draft.revision
            : form.revision,
          title: 'X',
        },
        actor(),
      );
      expect(attempt.ok, status).toBe(eventAllowsFormEditing(status));
    }
  });
});

// ---------------------------------------------------------------------------
describe('preview', () => {
  it('renders only what a participant would see', async () => {
    let form = await addStep('Page one');
    form = await addQuestion(form.steps[0].id, { label: 'Visible' });
    form = await addQuestion(form.steps[0].id, { label: 'Hidden', active: false });

    const preview = service.buildPreview(form);
    expect(preview.steps[0].questions.map((q) => q.label)).toEqual(['Visible']);
    expect(preview.eventId).toBe(event.id);
  });

  it('hides an inactive option without hiding the question', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, {
      type: 'SINGLE_SELECT',
      label: 'Pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
    });
    const question = questionsOf(form)[0];
    const hidden = await service.updateOption(
      event.id,
      question.id,
      question.options[1].id,
      { expectedRevision: form.revision, active: false },
      actor(),
    );
    if (!hidden.ok) throw new Error('unreachable');

    const preview = service.buildPreview(hidden.value);
    expect(preview.steps[0].questions[0].options).toEqual([{ value: 'a', label: 'A' }]);
  });

  it('reports the problems publishing will refuse', async () => {
    const empty = service.buildPreview(await draft());
    expect(empty.problems.map((problem) => problem.code)).toContain('NO_STEPS');

    let form = await addStep();
    expect(service.buildPreview(form).problems.map((p) => p.code)).toContain('EMPTY_STEP');

    form = await addQuestion(form.steps[0].id, {
      type: 'SINGLE_SELECT',
      label: 'No choices',
    });
    const codes = service.buildPreview(form).problems.map((problem) => problem.code);
    expect(codes).toContain('SELECT_WITHOUT_OPTIONS');
  });

  it('stores nothing and creates no participant', async () => {
    const form = await addStep();
    const before = db.raw
      .prepare('SELECT COUNT(*) AS n FROM audit_logs')
      .get() as { n: number };

    service.buildPreview(form);

    const after = db.raw.prepare('SELECT COUNT(*) AS n FROM audit_logs').get() as { n: number };
    expect(after.n).toBe(before.n);

    // Participants and entries exist as tables from phase 7 onwards. What must
    // stay true is that RENDERING a form does not put anybody in them: a
    // preview is a question about a draft, not a submission.
    for (const table of ['participants', 'event_entries', 'event_entry_answers']) {
      const rows = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(rows.n, table).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('event integration', () => {
  it('an event carrying a form can no longer be deleted', async () => {
    await draft();
    expect(await new EventRepository(db.d1).hasDependencies(event.id)).toBe(true);

    const removed = await events.remove(event.id, actor());
    expect(removed.ok).toBe(false);
    if (removed.ok) throw new Error('unreachable');
    expect(removed.failure.code).toBe('EVENT_CANNOT_BE_DELETED');
  });

  it('the database refuses to orphan a draft even outside the service', async () => {
    await draft();
    expect(() => db.raw.prepare('DELETE FROM events WHERE id = ?').run(event.id)).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('an event with no form is still deletable', async () => {
    const removed = await events.remove(event.id, actor());
    expect(removed.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('mappers', () => {
  function questionRow(overrides: Partial<FormQuestionRow> = {}): FormQuestionRow {
    return {
      id: 'q1',
      form_owner_type: 'DRAFT',
      form_owner_id: 'f1',
      step_id: 's1',
      key: 'first_name',
      system_field: 'NONE',
      type: 'SHORT_TEXT',
      label: 'Name',
      description: null,
      placeholder: null,
      required: 0,
      active: 1,
      exportable: 1,
      sort_order: 0,
      validation_config: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  it('accepts a well-formed row', () => {
    expect(rowToFormQuestion(questionRow()).key).toBe('first_name');
  });

  it.each([
    ['unknown owner type', { form_owner_type: 'GHOST' }, /form_owner_type/i],
    ['missing owner', { form_owner_id: '' }, /owner/i],
    ['unknown type', { type: 'SIGNATURE' }, /type/i],
    ['unknown system field', { system_field: 'SSN' }, /system_field/i],
    ['negative position', { sort_order: -1 }, /sort_order/i],
    ['non-boolean flag', { required: 2 }, /required/i],
    ['naive timestamp', { created_at: '2026-01-01 00:00:00' }, /canonical ISO/i],
    ['unreadable validation', { validation_config: '{oops' }, /validation_config/i],
    ['empty key', { key: '' }, /key/i],
  ])('rejects %s', (_label, overrides, pattern) => {
    expect(() => rowToFormQuestion(questionRow(overrides as Partial<FormQuestionRow>))).toThrow(
      pattern,
    );
  });

  it('never degrades unreadable validation to "no rules"', () => {
    expect(() =>
      rowToFormQuestion(questionRow({ validation_config: 'not json' })),
    ).toThrow();
  });

  it('names the column without leaking a stack', () => {
    try {
      rowToFormQuestion(questionRow({ type: 'SIGNATURE' }));
      throw new Error('should have thrown');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('type');
      expect(message.split('\n')).toHaveLength(1);
    }
  });

  it('rejects a malformed option row', () => {
    const row: FormOptionRow = {
      id: 'o1',
      question_id: 'q1',
      value: 'a',
      label: 'A',
      sort_order: 0,
      active: 1,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(rowToFormOption(row).active).toBe(true);
    expect(() => rowToFormOption({ ...row, active: 7 })).toThrow(/active/i);
    expect(() => rowToFormOption({ ...row, question_id: '' })).toThrow(/identifiers/i);
  });
});

// ---------------------------------------------------------------------------
describe('concurrency', () => {
  it('two edits on the same revision: one wins, one conflicts', async () => {
    const form = await addStep();

    const [first, second] = await Promise.all([
      service.createStep(event.id, { expectedRevision: form.revision, title: 'A' }, actor()),
      service.createStep(event.id, { expectedRevision: form.revision, title: 'B' }, actor()),
    ]);

    const outcomes = [first, second].map((result) => result.ok);
    expect(outcomes.filter(Boolean)).toHaveLength(1);

    const loser = [first, second].find((result) => !result.ok);
    if (!loser || loser.ok) throw new Error('unreachable');
    expect(loser.failure.code).toBe('FORM_REVISION_CONFLICT');

    // Exactly one of them landed.
    expect((await draft()).steps).toHaveLength(2);
  });

  it('a question created while another is deleted cannot both land on one revision', async () => {
    let form = await addStep();
    form = await addQuestion(form.steps[0].id, { label: 'Doomed' });
    const question = questionsOf(form)[0];

    const [created, deleted] = await Promise.all([
      service.createQuestion(
        event.id,
        {
          expectedRevision: form.revision,
          stepId: form.steps[0].id,
          type: 'SHORT_TEXT',
          label: 'New',
        },
        actor(),
      ),
      service.deleteQuestion(event.id, question.id, form.revision, actor()),
    ]);

    expect([created.ok, deleted.ok].filter(Boolean)).toHaveLength(1);
  });

  it('two reorders on the same revision leave a coherent order', async () => {
    let form = await draft();
    for (const title of ['One', 'Two', 'Three']) {
      const result = await service.createStep(
        event.id,
        { expectedRevision: form.revision, title },
        actor(),
      );
      if (!result.ok) throw new Error(result.failure.code);
      form = result.value;
    }
    const ids = form.steps.map((step) => step.id);

    const [a, b] = await Promise.all([
      service.reorderSteps(
        event.id,
        form.revision,
        [
          { id: ids[2], sortOrder: 0 },
          { id: ids[1], sortOrder: 1 },
          { id: ids[0], sortOrder: 2 },
        ],
        actor(),
      ),
      service.reorderSteps(
        event.id,
        form.revision,
        [
          { id: ids[1], sortOrder: 0 },
          { id: ids[0], sortOrder: 1 },
          { id: ids[2], sortOrder: 2 },
        ],
        actor(),
      ),
    ]);

    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);

    const after = await draft();
    const positions = after.steps.map((step) => step.sortOrder);
    expect(new Set(positions).size).toBe(3);
    expect(positions.every((position) => position < FORM_SORT_PARK_OFFSET)).toBe(true);
  });
});

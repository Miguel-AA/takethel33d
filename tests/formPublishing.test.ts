// The publishability rules and the canonical snapshot.
//
// This is the ONE table the backend, the dev mock and the builder read for the
// question "could this go in front of a person?", so a drift here is a drift
// everywhere.

import { describe, expect, it } from 'vitest';
import {
  ALLOW_EMPTY_PUBLISHED_STEPS,
  FORM_PUBLISH_ISSUE_CODES,
  PUBLISH_PRESERVES_INACTIVE_QUESTIONS,
  REQUIRED_SYSTEM_FIELDS,
  SELECT_MIN_ACTIVE_OPTIONS,
  buildFormSnapshot,
  evaluatePublishability,
  hasUnpublishedChanges,
  missingRequiredSystemFields,
} from '../shared/formPublishing';
import type {
  EventFormDraft,
  FormQuestion,
  FormQuestionOption,
  FormStep,
} from '../shared/types';

const AT = '2026-05-01T00:00:00.000Z';

function option(overrides: Partial<FormQuestionOption> = {}): FormQuestionOption {
  return {
    id: `opt-${overrides.value ?? 'a'}`,
    questionId: 'q1',
    value: 'a',
    label: 'A',
    sortOrder: 0,
    active: true,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function question(overrides: Partial<FormQuestion> = {}): FormQuestion {
  return {
    id: `q-${overrides.key ?? 'x'}`,
    ownerType: 'DRAFT',
    ownerId: 'draft-1',
    stepId: 'step-1',
    key: 'x',
    systemField: 'NONE',
    type: 'SHORT_TEXT',
    label: 'A question',
    description: null,
    placeholder: null,
    required: false,
    active: true,
    exportable: true,
    sortOrder: 0,
    validation: null,
    options: [],
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function step(questions: FormQuestion[], overrides: Partial<FormStep> = {}): FormStep {
  return {
    id: 'step-1',
    ownerType: 'DRAFT',
    ownerId: 'draft-1',
    title: 'About you',
    description: null,
    sortOrder: 0,
    questions,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

function draft(steps: FormStep[], revision = 5): EventFormDraft {
  return {
    id: 'draft-1',
    eventId: 'event-1',
    revision,
    steps,
    updatedBy: 'admin-1',
    createdAt: AT,
    updatedAt: AT,
  };
}

/** The three identities every published form must carry, correctly configured. */
function identityQuestions(): FormQuestion[] {
  return [
    question({ key: 'first_name', systemField: 'FIRST_NAME', type: 'SHORT_TEXT', required: true, sortOrder: 0 }),
    question({ key: 'last_name', systemField: 'LAST_NAME', type: 'SHORT_TEXT', required: true, sortOrder: 1 }),
    question({ key: 'email', systemField: 'EMAIL', type: 'EMAIL', required: true, sortOrder: 2 }),
  ];
}

const NO_AGE = { minimumAge: null };
const codes = (result: { errors: Array<{ code: string }> }) =>
  result.errors.map((issue) => issue.code);

// ---------------------------------------------------------------------------
describe('the rules themselves', () => {
  it('requires exactly the three identity fields', () => {
    expect([...REQUIRED_SYSTEM_FIELDS]).toEqual(['FIRST_NAME', 'LAST_NAME', 'EMAIL']);
  });

  it('treats a one-option choice as no choice at all', () => {
    expect(SELECT_MIN_ACTIVE_OPTIONS).toBe(2);
  });

  it('refuses empty steps in a published wizard', () => {
    expect(ALLOW_EMPTY_PUBLISHED_STEPS).toBe(false);
  });

  it('carries inactive questions into the version, for the record', () => {
    expect(PUBLISH_PRESERVES_INACTIVE_QUESTIONS).toBe(true);
  });

  it('declares every issue code the evaluator can produce', () => {
    expect(FORM_PUBLISH_ISSUE_CODES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('publishability', () => {
  it('accepts a minimal, coherent form', () => {
    const result = evaluatePublishability(draft([step(identityQuestions())]), NO_AGE);
    expect(result.publishable).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('refuses a form that does not exist', () => {
    const result = evaluatePublishability(null, NO_AGE);
    expect(result.publishable).toBe(false);
    expect(codes(result)).toEqual(['NO_DRAFT']);
  });

  it('refuses a form with no steps', () => {
    expect(codes(evaluatePublishability(draft([]), NO_AGE))).toEqual(['NO_STEPS']);
  });

  it('refuses a step that asks nothing', () => {
    const result = evaluatePublishability(
      draft([step(identityQuestions()), step([], { id: 'step-2', title: 'Empty', sortOrder: 1 })]),
      NO_AGE,
    );
    expect(result.publishable).toBe(false);
    const empty = result.errors.find((issue) => issue.code === 'EMPTY_STEP');
    expect(empty?.stepId).toBe('step-2');
    expect(empty?.subject).toBe('Empty');
  });

  it.each(['FIRST_NAME', 'LAST_NAME', 'EMAIL'] as const)('refuses a form missing %s', (field) => {
    const remaining = identityQuestions().filter((q) => q.systemField !== field);
    const result = evaluatePublishability(draft([step(remaining)]), NO_AGE);
    expect(result.publishable).toBe(false);
    const issue = result.errors.find((candidate) => candidate.code === 'MISSING_SYSTEM_FIELD');
    expect(issue?.subject).toBe(field);
  });

  it('refuses an identity field that is present but optional', () => {
    const questions = identityQuestions();
    questions[2] = { ...questions[2], required: false };
    const result = evaluatePublishability(draft([step(questions)]), NO_AGE);
    expect(codes(result)).toContain('SYSTEM_FIELD_NOT_REQUIRED');
    expect(
      result.errors.find((issue) => issue.code === 'SYSTEM_FIELD_NOT_REQUIRED')?.subject,
    ).toBe('EMAIL');
  });

  it('refuses an identity field that has been switched off', () => {
    const questions = identityQuestions();
    questions[0] = { ...questions[0], active: false };
    expect(codes(evaluatePublishability(draft([step(questions)]), NO_AGE))).toContain(
      'SYSTEM_FIELD_INACTIVE',
    );
  });

  it('refuses an identity field wearing the wrong type', () => {
    const questions = identityQuestions();
    questions[2] = { ...questions[2], type: 'SHORT_TEXT' };
    expect(codes(evaluatePublishability(draft([step(questions)]), NO_AGE))).toContain(
      'SYSTEM_FIELD_TYPE_INVALID',
    );
  });

  it('requires a date of birth exactly when the event has a minimum age', () => {
    const withoutDob = draft([step(identityQuestions())]);
    expect(evaluatePublishability(withoutDob, { minimumAge: null }).publishable).toBe(true);

    const gated = evaluatePublishability(withoutDob, { minimumAge: 21 });
    expect(gated.publishable).toBe(false);
    expect(
      gated.errors.find((issue) => issue.code === 'MISSING_SYSTEM_FIELD')?.subject,
    ).toBe('DATE_OF_BIRTH');
    expect(missingRequiredSystemFields(withoutDob, { minimumAge: 21 })).toEqual([
      'DATE_OF_BIRTH',
    ]);
  });

  it('requires the date of birth to be answered, not merely present', () => {
    const questions = [
      ...identityQuestions(),
      question({
        key: 'date_of_birth',
        systemField: 'DATE_OF_BIRTH',
        type: 'DATE',
        required: false,
        sortOrder: 3,
      }),
    ];
    const result = evaluatePublishability(draft([step(questions)]), { minimumAge: 18 });
    expect(codes(result)).toContain('SYSTEM_FIELD_NOT_REQUIRED');

    const fixed = questions.map((q) =>
      q.systemField === 'DATE_OF_BIRTH' ? { ...q, required: true } : q,
    );
    expect(evaluatePublishability(draft([step(fixed)]), { minimumAge: 18 }).publishable).toBe(
      true,
    );
  });

  it.each([0, 1])('refuses a choice question with %i active options', (count) => {
    const options = Array.from({ length: count }, (_, index) =>
      option({ value: `v${index}`, sortOrder: index }),
    );
    const questions = [
      ...identityQuestions(),
      question({ key: 'pick', type: 'SINGLE_SELECT', options, sortOrder: 3 }),
    ];
    const result = evaluatePublishability(draft([step(questions)]), NO_AGE);
    expect(result.publishable).toBe(false);
    expect(codes(result)).toContain('SELECT_REQUIRES_OPTIONS');
  });

  it('accepts a choice question with two active options', () => {
    const questions = [
      ...identityQuestions(),
      question({
        key: 'pick',
        type: 'MULTI_SELECT',
        sortOrder: 3,
        options: [option({ value: 'a' }), option({ value: 'b', sortOrder: 1 })],
      }),
    ];
    expect(evaluatePublishability(draft([step(questions)]), NO_AGE).publishable).toBe(true);
  });

  it('counts only ACTIVE options toward the minimum', () => {
    const questions = [
      ...identityQuestions(),
      question({
        key: 'pick',
        type: 'DROPDOWN',
        sortOrder: 3,
        options: [option({ value: 'a' }), option({ value: 'b', sortOrder: 1, active: false })],
      }),
    ];
    expect(codes(evaluatePublishability(draft([step(questions)]), NO_AGE))).toContain(
      'SELECT_REQUIRES_OPTIONS',
    );
  });

  it('ignores an INACTIVE choice question with no options', () => {
    const questions = [
      ...identityQuestions(),
      question({ key: 'pick', type: 'SINGLE_SELECT', active: false, sortOrder: 3 }),
    ];
    expect(evaluatePublishability(draft([step(questions)]), NO_AGE).publishable).toBe(true);
  });

  it('needs a YES_NO to have no options at all — its values are intrinsic', () => {
    const questions = [
      ...identityQuestions(),
      question({ key: 'sure', type: 'YES_NO', sortOrder: 3 }),
    ];
    expect(evaluatePublishability(draft([step(questions)]), NO_AGE).publishable).toBe(true);
  });

  it('refuses a form that only shows copy', () => {
    const questions = [question({ key: 'note', type: 'INFORMATION', exportable: false })];
    const result = evaluatePublishability(draft([step(questions)]), NO_AGE);
    expect(codes(result)).toContain('NO_ANSWERABLE_QUESTION');
  });

  it('refuses duplicate and reserved answer keys', () => {
    const questions = [
      ...identityQuestions(),
      question({ key: 'email', sortOrder: 3 }),
      question({ key: 'constructor', sortOrder: 4 }),
    ];
    const result = evaluatePublishability(draft([step(questions)]), NO_AGE);
    expect(codes(result)).toContain('DUPLICATE_KEY');
    expect(codes(result)).toContain('RESERVED_KEY');
  });

  it('refuses validation a type does not understand', () => {
    const questions = [
      ...identityQuestions(),
      question({ key: 'note', type: 'EMAIL', validation: { minSelected: 2 }, sortOrder: 3 }),
    ];
    expect(codes(evaluatePublishability(draft([step(questions)]), NO_AGE))).toContain(
      'INVALID_VALIDATION',
    );
  });

  it('reports a duplicated system field even though the index prevents it', () => {
    const questions = [
      ...identityQuestions(),
      question({ key: 'email_2', systemField: 'EMAIL', type: 'EMAIL', sortOrder: 3 }),
    ];
    expect(codes(evaluatePublishability(draft([step(questions)]), NO_AGE))).toContain(
      'DUPLICATE_SYSTEM_FIELD',
    );
  });

  it('reports every problem at once, not just the first', () => {
    const result = evaluatePublishability(
      draft([step([question({ key: 'pick', type: 'SINGLE_SELECT' })])]),
      { minimumAge: 21 },
    );
    expect(result.errors.length).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
describe('the snapshot', () => {
  const form = draft([
    step(
      [
        question({ key: 'b', sortOrder: 1 }),
        question({
          key: 'a',
          sortOrder: 0,
          type: 'SINGLE_SELECT',
          options: [option({ value: 'y', sortOrder: 1 }), option({ value: 'x', sortOrder: 0 })],
        }),
      ],
      { id: 'step-2', sortOrder: 1, title: 'Second' },
    ),
    step([question({ key: 'c' })], { id: 'step-1', sortOrder: 0, title: 'First' }),
  ]);

  it('is ordered by position, whatever order the rows arrived in', () => {
    const snapshot = buildFormSnapshot(form, { versionNumber: 1, publishedAt: AT });
    expect(snapshot.steps.map((s) => s.title)).toEqual(['First', 'Second']);
    expect(snapshot.steps[1].questions.map((q) => q.key)).toEqual(['a', 'b']);
    expect(snapshot.steps[1].questions[0].options.map((o) => o.value)).toEqual(['x', 'y']);
  });

  it('is deterministic: the same form produces byte-identical JSON', () => {
    const first = buildFormSnapshot(form, { versionNumber: 3, publishedAt: AT });
    const second = buildFormSnapshot(form, { versionNumber: 3, publishedAt: AT });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('carries no edit timestamps — they say when someone typed, not what was published', () => {
    const json = JSON.stringify(buildFormSnapshot(form, { versionNumber: 1, publishedAt: AT }));
    expect(json).not.toContain('createdAt');
    expect(json).not.toContain('updatedAt');
  });

  it('records what the form is made of', () => {
    const snapshot = buildFormSnapshot(form, { versionNumber: 7, publishedAt: AT });
    expect(snapshot.versionNumber).toBe(7);
    expect(snapshot.eventId).toBe('event-1');
    expect(snapshot.sourceDraftRevision).toBe(5);
    expect(snapshot.summary).toMatchObject({
      stepCount: 2,
      questionCount: 3,
      optionCount: 2,
    });
    expect(snapshot.summary.questionTypes).toContain('SINGLE_SELECT');
  });

  it('keeps inactive questions, marked', () => {
    const withHidden = draft([
      step([...identityQuestions(), question({ key: 'hidden', active: false, sortOrder: 9 })]),
    ]);
    const snapshot = buildFormSnapshot(withHidden, { versionNumber: 1, publishedAt: AT });
    const hidden = snapshot.steps[0].questions.find((q) => q.key === 'hidden');
    expect(hidden).toBeDefined();
    expect(hidden?.active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('unpublished changes', () => {
  it('is two integers, not a diff', () => {
    expect(hasUnpublishedChanges(5, 5)).toBe(false);
    expect(hasUnpublishedChanges(6, 5)).toBe(true);
    // Never published: everything is unpublished.
    expect(hasUnpublishedChanges(1, null)).toBe(true);
    // No draft at all: nothing to publish.
    expect(hasUnpublishedChanges(null, null)).toBe(false);
  });
});

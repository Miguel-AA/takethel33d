// The shared form vocabulary and its schemas.
//
// This is the ONE table the builder UI, the dev mock and the backend read, so
// a drift here is a drift everywhere.

import { describe, expect, it } from 'vitest';
import {
  FORM_OWNER_TYPES,
  FORM_QUESTION_TYPES,
  FORM_SYSTEM_FIELDS,
  NAMED_SYSTEM_FIELDS,
  SYSTEM_FIELD_KEY,
  SYSTEM_FIELD_TYPE,
  VALIDATION_KEYS_BY_TYPE,
  RESERVED_QUESTION_KEYS,
  canDeleteQuestion,
  editableQuestionFields,
  eventAllowsFormEditing,
  isNamedSystemField,
  isReservedQuestionKey,
  questionTypeCollectsAnswer,
  questionTypeSupportsOptions,
  questionTypeSupportsPlaceholder,
} from '../shared/formLifecycle';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import {
  createFormOptionSchema,
  createFormQuestionSchema,
  createFormStepSchema,
  formOptionValueSchema,
  formQuestionKeySchema,
  formQuestionValidationSchema,
  reorderFormOptionsSchema,
  reorderFormQuestionsSchema,
  reorderFormStepsSchema,
  updateFormQuestionSchema,
  updateFormStepSchema,
} from '../shared/schemas';
import { FORM_QUESTIONS_MAX, FORM_STEPS_MAX } from '../shared/limits';

const UUID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

// ---------------------------------------------------------------------------
describe('question types', () => {
  it('declares exactly the twelve approved types', () => {
    expect([...FORM_QUESTION_TYPES]).toEqual([
      'SHORT_TEXT',
      'LONG_TEXT',
      'EMAIL',
      'PHONE',
      'DATE',
      'NUMBER',
      'YES_NO',
      'SINGLE_SELECT',
      'MULTI_SELECT',
      'DROPDOWN',
      'CONSENT',
      'INFORMATION',
    ]);
  });

  it('gives only the choice types options', () => {
    const withOptions = FORM_QUESTION_TYPES.filter(questionTypeSupportsOptions);
    expect(withOptions).toEqual(['SINGLE_SELECT', 'MULTI_SELECT', 'DROPDOWN']);
  });

  it('offers a placeholder only where there is an input to put it in', () => {
    expect(questionTypeSupportsPlaceholder('SHORT_TEXT')).toBe(true);
    expect(questionTypeSupportsPlaceholder('YES_NO')).toBe(false);
    expect(questionTypeSupportsPlaceholder('CONSENT')).toBe(false);
    expect(questionTypeSupportsPlaceholder('INFORMATION')).toBe(false);
  });

  it('treats INFORMATION as copy, not a question', () => {
    expect(questionTypeCollectsAnswer('INFORMATION')).toBe(false);
    for (const type of FORM_QUESTION_TYPES.filter((t) => t !== 'INFORMATION')) {
      expect(questionTypeCollectsAnswer(type), type).toBe(true);
    }
  });

  it('declares a validation vocabulary for every type', () => {
    for (const type of FORM_QUESTION_TYPES) {
      expect(VALIDATION_KEYS_BY_TYPE[type], type).toBeDefined();
    }
    expect(VALIDATION_KEYS_BY_TYPE.EMAIL).toEqual([]);
    expect(VALIDATION_KEYS_BY_TYPE.NUMBER).toContain('min');
    expect(VALIDATION_KEYS_BY_TYPE.MULTI_SELECT).toContain('maxSelected');
  });
});

// ---------------------------------------------------------------------------
describe('system fields', () => {
  it('declares exactly the approved identities, plus NONE', () => {
    expect([...FORM_SYSTEM_FIELDS]).toEqual([
      'FIRST_NAME',
      'LAST_NAME',
      'EMAIL',
      'DATE_OF_BIRTH',
      'PHONE',
      'NONE',
    ]);
    expect(NAMED_SYSTEM_FIELDS).not.toContain('NONE');
    expect(isNamedSystemField('NONE')).toBe(false);
  });

  it('pins a type and a key to each one', () => {
    for (const field of NAMED_SYSTEM_FIELDS) {
      expect(SYSTEM_FIELD_TYPE[field], field).toBeDefined();
      expect(SYSTEM_FIELD_KEY[field], field).toMatch(/^[a-z][a-z0-9_]*$/);
    }
    expect(SYSTEM_FIELD_TYPE.EMAIL).toBe('EMAIL');
    expect(SYSTEM_FIELD_TYPE.DATE_OF_BIRTH).toBe('DATE');
    expect(SYSTEM_FIELD_KEY.DATE_OF_BIRTH).toBe('date_of_birth');
  });

  it('keeps a system field editable in how it reads, fixed in what it is', () => {
    const system = editableQuestionFields('EMAIL');
    expect(system).toContain('label');
    expect(system).toContain('description');
    expect(system).toContain('required');
    expect(system).not.toContain('type');
    expect(system).not.toContain('key');

    const custom = editableQuestionFields('NONE');
    expect(custom).toContain('type');
    expect(custom).toContain('key');
  });

  it('protects a REQUIRED system field from deletion, and nothing else', () => {
    expect(canDeleteQuestion('EMAIL', true)).toBe(false);
    expect(canDeleteQuestion('EMAIL', false)).toBe(true);
    expect(canDeleteQuestion('NONE', true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('ownership and event state', () => {
  it('knows only DRAFT and VERSION', () => {
    expect([...FORM_OWNER_TYPES]).toEqual(['DRAFT', 'VERSION']);
  });

  it('allows editing while the event can still be prepared for', () => {
    const editable = EVENT_STATUSES.filter(eventAllowsFormEditing);
    expect(editable).toEqual(['DRAFT', 'SCHEDULED', 'OPEN']);
  });

  it('covers every event status', () => {
    for (const status of EVENT_STATUSES) {
      expect(typeof eventAllowsFormEditing(status), status).toBe('boolean');
    }
  });
});

// ---------------------------------------------------------------------------
describe('keys and option values', () => {
  it.each(['first_name', 'q1', 'smoker_status', 'a'])('accepts %s', (key) => {
    expect(formQuestionKeySchema.parse(key)).toBe(key);
  });

  it.each(['1abc', 'Has Space', 'kebab-case', '', '_leading', 'MiXeD'])(
    'refuses %s as a key',
    (key) => {
      const parsed = formQuestionKeySchema.safeParse(key);
      // Mixed case is lowercased before the pattern runs; anything else fails.
      if (key === 'MiXeD') expect(parsed.success).toBe(true);
      else expect(parsed.success).toBe(false);
    },
  );

  it.each(['__proto__', 'constructor', 'prototype'])('refuses %s as a key', (key) => {
    expect(formQuestionKeySchema.safeParse(key).success).toBe(false);
    expect(isReservedQuestionKey(key)).toBe(true);
  });

  it('reserves exactly the three names that misbehave as object keys', () => {
    expect([...RESERVED_QUESTION_KEYS]).toEqual(['__proto__', 'constructor', 'prototype']);
    // Ordinary words that merely resemble them stay usable.
    expect(isReservedQuestionKey('proto')).toBe(false);
    expect(isReservedQuestionKey('constructor_2')).toBe(false);
  });

  it('allows a hyphen in an option value but not a leading one', () => {
    expect(formOptionValueSchema.safeParse('yes-please').success).toBe(true);
    expect(formOptionValueSchema.safeParse('-nope').success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('validation config', () => {
  it('accepts a coherent range', () => {
    expect(formQuestionValidationSchema.parse({ minLength: 2, maxLength: 10 })).toEqual({
      minLength: 2,
      maxLength: 10,
    });
  });

  it.each([
    ['length', { minLength: 10, maxLength: 2 }],
    ['number', { min: 10, max: 2 }],
    ['selection', { minSelected: 5, maxSelected: 1 }],
    ['date', { minDate: '2026-05-01T00:00:00.000Z', maxDate: '2026-01-01T00:00:00.000Z' }],
  ])('refuses an inverted %s range', (_label, value) => {
    expect(formQuestionValidationSchema.safeParse(value).success).toBe(false);
  });

  it('refuses an unknown key, so a stray rule cannot be smuggled in', () => {
    expect(formQuestionValidationSchema.safeParse({ pattern: '.*' }).success).toBe(false);
  });

  it('has no regular-expression rule at all', () => {
    // A client-supplied pattern would be run against every submission later —
    // a denial of service waiting for a future phase to inherit.
    const parsed = formQuestionValidationSchema.safeParse({ pattern: '(a+)+$' });
    expect(parsed.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('step and question schemas', () => {
  it('requires a revision on every mutation', () => {
    expect(createFormStepSchema.safeParse({ title: 'Step' }).success).toBe(false);
    expect(
      createFormStepSchema.safeParse({ expectedRevision: 1, title: 'Step' }).success,
    ).toBe(true);
  });

  it('refuses an empty patch', () => {
    expect(updateFormStepSchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
    expect(updateFormQuestionSchema.safeParse({ expectedRevision: 2 }).success).toBe(false);
  });

  it('refuses unknown keys — the mass-assignment guard', () => {
    for (const body of [
      { expectedRevision: 1, stepId: UUID, type: 'SHORT_TEXT', label: 'A', ownerId: 'x' },
      { expectedRevision: 1, stepId: UUID, type: 'SHORT_TEXT', label: 'A', id: UUID },
      { expectedRevision: 1, stepId: UUID, type: 'SHORT_TEXT', label: 'A', sortOrder: 3 },
      { expectedRevision: 1, stepId: UUID, type: 'SHORT_TEXT', label: 'A', createdAt: 'x' },
    ]) {
      expect(createFormQuestionSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('refuses a type outside the catalogue', () => {
    expect(
      createFormQuestionSchema.safeParse({
        expectedRevision: 1,
        stepId: UUID,
        type: 'SIGNATURE',
        label: 'Sign',
      }).success,
    ).toBe(false);
  });

  it('accepts a select created together with its options', () => {
    const parsed = createFormQuestionSchema.safeParse({
      expectedRevision: 1,
      stepId: UUID,
      type: 'SINGLE_SELECT',
      label: 'Do you smoke?',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('bounds an option label and refuses a blank one', () => {
    expect(
      createFormOptionSchema.safeParse({ expectedRevision: 1, value: 'a', label: '   ' })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('reorder schemas', () => {
  const item = (id: string, sortOrder: number) => ({ id, sortOrder });

  it('accepts a coherent order', () => {
    expect(
      reorderFormStepsSchema.safeParse({
        expectedRevision: 1,
        items: [item(UUID, 0), item(OTHER, 1)],
      }).success,
    ).toBe(true);
  });

  it('refuses a repeated id and a repeated position', () => {
    expect(
      reorderFormStepsSchema.safeParse({
        expectedRevision: 1,
        items: [item(UUID, 0), item(UUID, 1)],
      }).success,
    ).toBe(false);
    expect(
      reorderFormStepsSchema.safeParse({
        expectedRevision: 1,
        items: [item(UUID, 0), item(OTHER, 0)],
      }).success,
    ).toBe(false);
  });

  it('refuses a negative position and an empty list', () => {
    expect(
      reorderFormStepsSchema.safeParse({ expectedRevision: 1, items: [item(UUID, -1)] })
        .success,
    ).toBe(false);
    expect(reorderFormStepsSchema.safeParse({ expectedRevision: 1, items: [] }).success).toBe(
      false,
    );
  });

  it('bounds each list at its own ceiling', () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: `${index}`.padStart(8, '0') + '-1111-4111-8111-111111111111',
        sortOrder: index,
      }));
    expect(
      reorderFormStepsSchema.safeParse({ expectedRevision: 1, items: many(FORM_STEPS_MAX + 1) })
        .success,
    ).toBe(false);
    expect(
      reorderFormQuestionsSchema.safeParse({
        expectedRevision: 1,
        stepId: UUID,
        items: many(FORM_QUESTIONS_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it('makes a question order state which step it belongs to', () => {
    expect(
      reorderFormQuestionsSchema.safeParse({
        expectedRevision: 1,
        items: [item(UUID, 0)],
      }).success,
    ).toBe(false);
  });

  it('takes no step for an option order — the question is the scope', () => {
    expect(
      reorderFormOptionsSchema.safeParse({
        expectedRevision: 1,
        stepId: UUID,
        items: [item(OTHER, 0)],
      }).success,
    ).toBe(false);
  });
});

// What counts as an answer, per question type — and what a whole submission
// must look like.
//
// Pure domain: no database, no HTTP. Every rule here is read off a VERSION
// question, so these tests build questions directly rather than going through
// the builder, which keeps the matrix readable and the failures precise.

import { describe, expect, it } from 'vitest';
import {
  extractParticipantProfile,
  isEmailAddress,
  isEmptyAnswer,
  isPhoneNumber,
  questionsInOrder,
  validateAnswerForQuestion,
  validateSubmission,
  type AnswerValue,
} from '../shared/formAnswers';
import { ANSWER_TEXT_MAX_LENGTH, FORM_QUESTIONS_MAX } from '../shared/limits';
import { FORM_QUESTION_TYPES } from '../shared/formLifecycle';
import type {
  FormQuestion,
  FormQuestionOption,
  FormQuestionType,
  FormQuestionValidation,
  FormStep,
  FormSystemField,
} from '../shared/types';

const AT = '2026-01-01T00:00:00.000Z';

let counter = 0;
const nextId = () => `q-${++counter}`;

function option(value: string, label = value, active = true): FormQuestionOption {
  return {
    id: `o-${value}`,
    questionId: 'q',
    value,
    label,
    sortOrder: 0,
    active,
    createdAt: AT,
    updatedAt: AT,
  };
}

function question(overrides: Partial<FormQuestion> & { type: FormQuestionType }): FormQuestion {
  const id = overrides.id ?? nextId();
  return {
    id,
    ownerType: 'VERSION',
    ownerId: 'v1',
    stepId: 's1',
    key: overrides.key ?? `key_${id.replace(/-/g, '_')}`,
    systemField: (overrides.systemField ?? 'NONE') as FormSystemField,
    type: overrides.type,
    label: overrides.label ?? 'A question',
    description: null,
    placeholder: null,
    required: overrides.required ?? false,
    active: overrides.active ?? true,
    exportable: true,
    sortOrder: overrides.sortOrder ?? 0,
    validation: overrides.validation ?? null,
    options: overrides.options ?? [],
    createdAt: AT,
    updatedAt: AT,
  };
}

function step(questions: FormQuestion[], sortOrder = 0, id = 's1'): FormStep {
  return {
    id,
    ownerType: 'VERSION',
    ownerId: 'v1',
    title: 'Step',
    description: null,
    sortOrder,
    questions: questions.map((q) => ({ ...q, stepId: id })),
    createdAt: AT,
    updatedAt: AT,
  };
}

/** Shorthand: validate one value against one question. */
function check(
  q: FormQuestion,
  value: unknown,
): { ok: true; value: AnswerValue } | { ok: false; problem: string } {
  return validateAnswerForQuestion(q, q.options, value);
}

function accepted(q: FormQuestion, value: unknown): AnswerValue {
  const result = check(q, value);
  if (!result.ok) throw new Error(`expected acceptance, got ${result.problem}`);
  return result.value;
}

function refused(q: FormQuestion, value: unknown): string {
  const result = check(q, value);
  if (result.ok) throw new Error(`expected refusal, got ${JSON.stringify(result.value)}`);
  return result.problem;
}

// ---------------------------------------------------------------------------
describe('text answers', () => {
  it('accepts a trimmed string and refuses anything that is not one', () => {
    const q = question({ type: 'SHORT_TEXT' });
    expect(accepted(q, '  John  ')).toBe('John');
    expect(refused(q, 42)).toBe('WRONG_TYPE');
    expect(refused(q, true)).toBe('WRONG_TYPE');
    expect(refused(q, ['John'])).toBe('WRONG_TYPE');
    expect(refused(q, '   ')).toBe('EMPTY');
  });

  it('applies the length the question configured, and a ceiling it did not', () => {
    const q = question({
      type: 'LONG_TEXT',
      validation: { minLength: 5, maxLength: 10 } as FormQuestionValidation,
    });
    expect(accepted(q, 'exactly10!')).toBe('exactly10!');
    expect(refused(q, 'tiny')).toBe('TOO_SHORT');
    expect(refused(q, 'far too long to fit')).toBe('TOO_LONG');

    // A question with no configured maximum still cannot accept a megabyte:
    // an unbounded answer is a storage problem, not a validation preference.
    const open = question({ type: 'LONG_TEXT' });
    expect(refused(open, 'x'.repeat(ANSWER_TEXT_MAX_LENGTH + 1))).toBe('TOO_LONG');
    expect(accepted(open, 'x'.repeat(ANSWER_TEXT_MAX_LENGTH))).toHaveLength(
      ANSWER_TEXT_MAX_LENGTH,
    );
  });
});

// ---------------------------------------------------------------------------
describe('email and phone answers', () => {
  it('accepts an address and refuses the shapes that are not one', () => {
    const q = question({ type: 'EMAIL' });
    expect(accepted(q, ' Ana@Example.com ')).toBe('Ana@Example.com');
    for (const bad of ['ana', 'ana@', '@example.com', 'ana@example', 'a b@example.com', 'a@@b.com']) {
      expect(refused(q, bad), bad).toBe('INVALID_EMAIL');
    }
  });

  it('keeps the answer as typed while identity is normalised elsewhere', () => {
    // The ANSWER preserves what the person wrote; `normalizeEmail` produces the
    // canonical form used as identity. Two representations, one on purpose.
    const q = question({ type: 'EMAIL' });
    expect(accepted(q, 'Ana@Example.COM')).toBe('Ana@Example.COM');
    expect(isEmailAddress('Ana@Example.COM')).toBe(true);
  });

  it('accepts the punctuation people actually type in a phone number', () => {
    const q = question({ type: 'PHONE' });
    expect(accepted(q, ' +1 (555) 010-9999 ')).toBe('+1 (555) 010-9999');
    expect(refused(q, '12345')).toBe('INVALID_PHONE');
    expect(refused(q, '(--) ()---')).toBe('INVALID_PHONE');
    expect(refused(q, 5550109999)).toBe('WRONG_TYPE');
    expect(isPhoneNumber('555-0100')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('date answers', () => {
  it('accepts a real calendar day and refuses one that does not exist', () => {
    const q = question({ type: 'DATE' });
    expect(accepted(q, '2001-03-15')).toBe('2001-03-15');
    for (const bad of ['2025-02-29', '2026-13-01', '2026-02-30', '15/03/2001', '2001-3-5']) {
      expect(refused(q, bad), bad).toBe('INVALID_DATE');
    }
    // An instant is not a civil date: a birthday has no time and no zone.
    expect(refused(q, '2001-03-15T00:00:00.000Z')).toBe('INVALID_DATE');
  });

  it('compares against the DAY of a configured bound, not its time', () => {
    const q = question({
      type: 'DATE',
      validation: {
        minDate: '2000-01-01T18:30:00.000Z',
        maxDate: '2000-12-31T06:00:00.000Z',
      } as FormQuestionValidation,
    });
    // Both boundary days are inside the range even though the stored bounds
    // carry a time of day nobody entered.
    expect(accepted(q, '2000-01-01')).toBe('2000-01-01');
    expect(accepted(q, '2000-12-31')).toBe('2000-12-31');
    expect(refused(q, '1999-12-31')).toBe('DATE_OUT_OF_RANGE');
    expect(refused(q, '2001-01-01')).toBe('DATE_OUT_OF_RANGE');
  });
});

// ---------------------------------------------------------------------------
describe('number answers', () => {
  it('accepts a number and the numeric string an input produces', () => {
    const q = question({ type: 'NUMBER' });
    expect(accepted(q, 42)).toBe(42);
    expect(accepted(q, '42')).toBe(42);
    expect(accepted(q, 4.5)).toBe(4.5);
  });

  it('refuses what would silently become zero or NaN', () => {
    const q = question({ type: 'NUMBER' });
    expect(refused(q, 'abc')).toBe('NOT_A_NUMBER');
    expect(refused(q, Number.NaN)).toBe('NOT_A_NUMBER');
    expect(refused(q, Number.POSITIVE_INFINITY)).toBe('NOT_A_NUMBER');
    // `Number(true)` is 1 and `Number([])` is 0; neither is an answer.
    expect(refused(q, true)).toBe('WRONG_TYPE');
    expect(refused(q, [])).toBe('WRONG_TYPE');
  });

  it('applies min, max and integerOnly', () => {
    const q = question({
      type: 'NUMBER',
      validation: { min: 10, max: 20, integerOnly: true } as FormQuestionValidation,
    });
    expect(accepted(q, 10)).toBe(10);
    expect(accepted(q, 20)).toBe(20);
    expect(refused(q, 9)).toBe('OUT_OF_RANGE');
    expect(refused(q, 21)).toBe('OUT_OF_RANGE');
    expect(refused(q, 15.5)).toBe('NOT_AN_INTEGER');
  });

  it('bounds a number the question left unbounded', () => {
    const q = question({ type: 'NUMBER' });
    expect(refused(q, 1e18)).toBe('OUT_OF_RANGE');
    expect(refused(q, -1e18)).toBe('OUT_OF_RANGE');
  });
});

// ---------------------------------------------------------------------------
describe('boolean answers', () => {
  it('YES_NO accepts both answers, because both are answers', () => {
    const q = question({ type: 'YES_NO', required: true });
    expect(accepted(q, true)).toBe(true);
    expect(accepted(q, false)).toBe(false);
    expect(refused(q, 'true')).toBe('WRONG_TYPE');
    expect(refused(q, 1)).toBe('WRONG_TYPE');
  });

  it('a REQUIRED consent can only be agreement', () => {
    const required = question({ type: 'CONSENT', required: true });
    expect(accepted(required, true)).toBe(true);
    // Unlike YES_NO, "no" is not a consent — it is the absence of one.
    expect(refused(required, false)).toBe('CONSENT_REQUIRED');

    const optional = question({ type: 'CONSENT', required: false });
    expect(accepted(optional, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('select answers', () => {
  const options = [option('one'), option('two'), option('gone', 'Gone', false)];

  it('accepts an active option and refuses anything else', () => {
    for (const type of ['SINGLE_SELECT', 'DROPDOWN'] as const) {
      const q = question({ type, options });
      expect(accepted(q, 'one'), type).toBe('one');
      expect(refused(q, 'three'), type).toBe('UNKNOWN_OPTION');
      // The version keeps deactivated options so old entries stay readable —
      // but nobody was offered them, so nobody can choose one now.
      expect(refused(q, 'gone'), type).toBe('INACTIVE_OPTION');
      expect(refused(q, ['one']), type).toBe('WRONG_TYPE');
    }
  });

  it('multi-select refuses repeats, unknowns and inactive choices', () => {
    const q = question({ type: 'MULTI_SELECT', options });
    expect(accepted(q, ['one', 'two'])).toEqual(['one', 'two']);
    expect(refused(q, ['one', 'one'])).toBe('DUPLICATE_SELECTION');
    expect(refused(q, ['one', 'three'])).toBe('UNKNOWN_OPTION');
    expect(refused(q, ['one', 'gone'])).toBe('INACTIVE_OPTION');
    expect(refused(q, ['one', 5])).toBe('WRONG_TYPE');
    expect(refused(q, 'one')).toBe('WRONG_TYPE');
  });

  it('stores a multi-select in the version’s option order, not the payload’s', () => {
    // Two people who chose the same things must produce the same stored answer,
    // whatever order their client happened to send.
    const q = question({ type: 'MULTI_SELECT', options });
    expect(accepted(q, ['two', 'one'])).toEqual(['one', 'two']);
    expect(accepted(q, ['one', 'two'])).toEqual(['one', 'two']);
  });

  it('applies minSelected and maxSelected', () => {
    const q = question({
      type: 'MULTI_SELECT',
      options,
      validation: { minSelected: 2, maxSelected: 2 } as FormQuestionValidation,
    });
    expect(accepted(q, ['one', 'two'])).toEqual(['one', 'two']);
    expect(refused(q, ['one'])).toBe('TOO_FEW_SELECTED');

    const wide = question({
      type: 'MULTI_SELECT',
      options: [option('a'), option('b'), option('c')],
      validation: { maxSelected: 2 } as FormQuestionValidation,
    });
    expect(refused(wide, ['a', 'b', 'c'])).toBe('TOO_MANY_SELECTED');
  });
});

// ---------------------------------------------------------------------------
describe('every question type is covered', () => {
  it('has a decision for each type in the domain', () => {
    // A new question type must not silently fall through to "accepted".
    const samples: Record<FormQuestionType, unknown> = {
      SHORT_TEXT: 'text',
      LONG_TEXT: 'text',
      EMAIL: 'a@b.com',
      PHONE: '555-0100',
      DATE: '2001-03-15',
      NUMBER: 1,
      YES_NO: true,
      SINGLE_SELECT: 'one',
      MULTI_SELECT: ['one'],
      DROPDOWN: 'one',
      CONSENT: true,
      INFORMATION: 'anything',
    };

    for (const type of FORM_QUESTION_TYPES) {
      const q = question({ type, options: [option('one')] });
      const result = check(q, samples[type]);
      if (type === 'INFORMATION') {
        // Copy collects nothing; an answer to it cannot exist.
        expect(result.ok, type).toBe(false);
      } else {
        expect(result.ok, type).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('emptiness', () => {
  it('treats a blank string and an empty list as absence', () => {
    expect(isEmptyAnswer(null)).toBe(true);
    expect(isEmptyAnswer(undefined)).toBe(true);
    expect(isEmptyAnswer('   ')).toBe(true);
    expect(isEmptyAnswer([])).toBe(true);
    // `false` and `0` are answers, not blanks. Treating them as absence is the
    // classic falsy-check bug, and here it would silently drop a "no".
    expect(isEmptyAnswer(false)).toBe(false);
    expect(isEmptyAnswer(0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('a whole submission', () => {
  function identityStep(extra: FormQuestion[] = []) {
    return step([
      question({ type: 'SHORT_TEXT', systemField: 'FIRST_NAME', key: 'first_name', required: true, sortOrder: 0 }),
      question({ type: 'SHORT_TEXT', systemField: 'LAST_NAME', key: 'last_name', required: true, sortOrder: 1 }),
      question({ type: 'EMAIL', systemField: 'EMAIL', key: 'email', required: true, sortOrder: 2 }),
      ...extra,
    ]);
  }

  function identityAnswers(questions: FormQuestion[]) {
    return [
      { questionId: questions[0].id, value: 'Ana' },
      { questionId: questions[1].id, value: 'Lopez' },
      { questionId: questions[2].id, value: 'ana@example.com' },
    ];
  }

  it('accepts a complete submission and orders it as the form reads', () => {
    const first = identityStep();
    const second = step(
      [question({ type: 'SHORT_TEXT', key: 'city', sortOrder: 0 })],
      1,
      's2',
    );
    const questions = [...first.questions, ...second.questions];

    // Sent in a deliberately scrambled order.
    const result = validateSubmission([second, first], [
      { questionId: questions[3].id, value: 'Madrid' },
      ...identityAnswers(questions).reverse(),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.accepted.map((answer) => answer.question.key)).toEqual([
      'first_name',
      'last_name',
      'email',
      'city',
    ]);
  });

  it('refuses a question that is not in this form', () => {
    const only = identityStep();
    const result = validateSubmission([only], [
      ...identityAnswers(only.questions),
      { questionId: 'q-from-another-form', value: 'x' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((problem) => problem.code)).toContain('UNKNOWN_QUESTION');
  });

  it('refuses the same question answered twice', () => {
    const only = identityStep();
    const result = validateSubmission([only], [
      ...identityAnswers(only.questions),
      { questionId: only.questions[0].id, value: 'Someone else' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.map((problem) => problem.code)).toContain('DUPLICATE_ANSWER');
  });

  it('refuses an answer to copy or to a question nobody was shown', () => {
    const info = question({ type: 'INFORMATION', key: 'notice', sortOrder: 3 });
    const hidden = question({ type: 'SHORT_TEXT', key: 'hidden', active: false, sortOrder: 4 });
    const only = identityStep([info, hidden]);

    for (const target of [info, hidden]) {
      const result = validateSubmission([only], [
        ...identityAnswers(only.questions),
        { questionId: target.id, value: 'x' },
      ]);
      expect(result.ok, target.key).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.problems.map((problem) => problem.code)).toContain('NOT_ALLOWED');
    }
  });

  it('names every missing required question rather than the first', () => {
    const only = identityStep();
    const result = validateSubmission([only], []);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems).toHaveLength(3);
    expect(result.problems.every((problem) => problem.code === 'REQUIRED_MISSING')).toBe(true);
  });

  it('a blank answer to a required question is MISSING, not malformed', () => {
    // Reporting it as a type error would complain about the value; reporting it
    // as missing names the question somebody has to go back and fill in.
    const only = identityStep();
    const answers = identityAnswers(only.questions);
    answers[0].value = '   ';

    const result = validateSubmission([only], answers);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems).toEqual([
      { code: 'REQUIRED_MISSING', questionId: only.questions[0].id, questionKey: 'first_name' },
    ]);
  });

  it('a blank answer to an OPTIONAL question stores no row at all', () => {
    const optional = question({ type: 'SHORT_TEXT', key: 'nickname', sortOrder: 3 });
    const only = identityStep([optional]);
    const result = validateSubmission([only], [
      ...identityAnswers(only.questions),
      { questionId: optional.id, value: '' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // Storing "" would make "did they answer?" unanswerable.
    expect(result.accepted.map((answer) => answer.question.key)).not.toContain('nickname');
  });

  it('an INACTIVE required question is not demanded', () => {
    // Publishing refuses to freeze a form in this shape, but a version could
    // still hold one — and demanding an answer to a question nobody was shown
    // would make the form impossible to submit.
    const ghost = question({
      type: 'SHORT_TEXT',
      key: 'ghost',
      required: true,
      active: false,
      sortOrder: 3,
    });
    const only = identityStep([ghost]);
    const result = validateSubmission([only], identityAnswers(only.questions));
    expect(result.ok).toBe(true);
  });

  it('reports every problem, not the first', () => {
    const number = question({ type: 'NUMBER', key: 'age', sortOrder: 3 });
    const only = identityStep([number]);
    const answers = identityAnswers(only.questions);
    answers[2].value = 'not-an-email';

    const result = validateSubmission([only], [
      ...answers,
      { questionId: number.id, value: 'abc' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.problems.filter((problem) => problem.code === 'INVALID_ANSWER')).toHaveLength(2);
  });

  it('custom questions are stored exactly like system ones', () => {
    // "Do you smoke?" is a row, not a column. Nothing about a custom question
    // takes a different path.
    const smoker = question({
      type: 'SINGLE_SELECT',
      key: 'smoker_status',
      options: [option('yes'), option('no')],
      sortOrder: 3,
    });
    const drinker = question({ type: 'YES_NO', key: 'drinker_status', sortOrder: 4 });
    const only = identityStep([smoker, drinker]);

    const result = validateSubmission([only], [
      ...identityAnswers(only.questions),
      { questionId: smoker.id, value: 'yes' },
      { questionId: drinker.id, value: false },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const stored = new Map(result.accepted.map((a) => [a.question.key, a.value]));
    expect(stored.get('smoker_status')).toBe('yes');
    expect(stored.get('drinker_status')).toBe(false);
  });

  it('handles a form at the contractual maximum', () => {
    const questions = Array.from({ length: FORM_QUESTIONS_MAX - 3 }, (_, index) =>
      question({ type: 'SHORT_TEXT', key: `custom_${index}`, sortOrder: index + 3 }),
    );
    const only = identityStep(questions);
    const result = validateSubmission([only], [
      ...identityAnswers(only.questions),
      ...questions.map((q) => ({ questionId: q.id, value: 'x' })),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.accepted).toHaveLength(FORM_QUESTIONS_MAX);
  });

  it('questionsInOrder walks steps then questions', () => {
    const a = step([question({ type: 'SHORT_TEXT', key: 'b', sortOrder: 1 }), question({ type: 'SHORT_TEXT', key: 'a', sortOrder: 0 })], 1, 's-late');
    const b = step([question({ type: 'SHORT_TEXT', key: 'c', sortOrder: 0 })], 0, 's-early');
    expect(questionsInOrder([a, b]).map((q) => q.key)).toEqual(['c', 'a', 'b']);
  });
});

// ---------------------------------------------------------------------------
describe('the identity a submission describes', () => {
  function profileFrom(extra: FormQuestion[], values: Record<string, unknown>) {
    const first = question({ type: 'SHORT_TEXT', systemField: 'FIRST_NAME', key: 'first_name', required: true, sortOrder: 0 });
    const last = question({ type: 'SHORT_TEXT', systemField: 'LAST_NAME', key: 'last_name', required: true, sortOrder: 1 });
    const email = question({ type: 'EMAIL', systemField: 'EMAIL', key: 'email', required: true, sortOrder: 2 });
    const only = step([first, last, email, ...extra]);

    const answers = [
      { questionId: first.id, value: values.first ?? 'Ana' },
      { questionId: last.id, value: values.last ?? 'Lopez' },
      { questionId: email.id, value: values.email ?? 'Ana@Example.com' },
      ...extra.map((q) => ({ questionId: q.id, value: values[q.key] })),
    ].filter((answer) => answer.value !== undefined);

    const submission = validateSubmission([only], answers);
    if (!submission.ok) throw new Error(JSON.stringify(submission.problems));
    return extractParticipantProfile(submission.accepted);
  }

  it('reads the profile off the answers, with no second participant object', () => {
    const phone = question({ type: 'PHONE', systemField: 'PHONE', key: 'phone', sortOrder: 3 });
    const dob = question({ type: 'DATE', systemField: 'DATE_OF_BIRTH', key: 'date_of_birth', sortOrder: 4 });

    const result = profileFrom([phone, dob], {
      phone: '555-0100',
      date_of_birth: '1990-01-01',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile).toEqual({
      firstName: 'Ana',
      lastName: 'Lopez',
      // Preserved as typed: normalisation belongs to the identity key, not the
      // answer somebody gave.
      email: 'Ana@Example.com',
      phone: '555-0100',
      dateOfBirth: '1990-01-01',
    });
  });

  it('leaves phone and date of birth null when the form did not ask', () => {
    const result = profileFrom([], {});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.profile.phone).toBeNull();
    expect(result.profile.dateOfBirth).toBeNull();
  });

  it('refuses rather than inventing an identity when a system field is absent', () => {
    // Unreachable through publishing, which guarantees all three — so reaching
    // it means the version is not what publishing would have produced, and a
    // participant with an empty name is a row nobody can identify again.
    const lonely = question({ type: 'SHORT_TEXT', key: 'anything' });
    const result = extractParticipantProfile([{ question: lonely, value: 'x' }]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.missing).toEqual(['FIRST_NAME', 'LAST_NAME', 'EMAIL']);
  });
});

// What counts as an answer to a question, and what a whole submission must
// look like before any of it is written down.
//
// SHARED so the backend, the dev mock and (in a later phase) the public wizard
// read ONE table of rules. The server re-validates everything regardless; the
// point of sharing is that a client cannot be taught a rule the server does not
// have, and cannot be surprised by one it does.
//
// THE VERSION IS THE AUTHORITY. Every rule below is read off the frozen
// `VERSION` question — its type, its active flag, its options, its configured
// validation. Nothing is read off the request except the value itself. A caller
// does not get to say what type its answer is, what key it files under, or what
// the question was called: those are copied from the version, because a
// submission that could describe its own questions could describe them wrongly.

import type {
  FormQuestion,
  FormQuestionOption,
  FormQuestionValidation,
  FormStep,
} from './types.ts';
import {
  questionTypeCollectsAnswer,
  questionTypeSupportsOptions,
  type FormQuestionType,
  type NamedSystemField,
} from './formLifecycle.ts';
import { isCivilDate } from './civilDate.ts';
import {
  ANSWER_NUMBER_MAX,
  ANSWER_NUMBER_MIN,
  ANSWER_SELECTIONS_MAX,
  ANSWER_TEXT_MAX_LENGTH,
} from './limits.ts';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * Everything an answer can be, once accepted.
 *
 * Deliberately narrow: a string, a number, a boolean, or a list of option
 * values. No nested objects and no dates-as-objects — an answer is a leaf, and
 * keeping it one is why `answer_value` can be stored, exported and compared
 * without a parser that understands the form.
 */
export type AnswerValue = string | number | boolean | string[];

/** The type an answer row records. `INFORMATION` cannot appear: copy is not asked. */
export type AnswerType = Exclude<FormQuestionType, 'INFORMATION'>;

/**
 * Why one value is not an acceptable answer to one question.
 *
 * These are DETAIL, not the API contract — the endpoint answers with
 * `FORM_ANSWER_INVALID` and carries the reason in `fields`, so a client can
 * point at the right input without the wire format growing a code per rule.
 */
export const ANSWER_PROBLEMS = [
  'WRONG_TYPE',
  'EMPTY',
  'TOO_SHORT',
  'TOO_LONG',
  'INVALID_EMAIL',
  'INVALID_PHONE',
  'INVALID_DATE',
  'DATE_OUT_OF_RANGE',
  'DATE_IN_FUTURE',
  'NOT_A_NUMBER',
  'NOT_AN_INTEGER',
  'OUT_OF_RANGE',
  'UNKNOWN_OPTION',
  'INACTIVE_OPTION',
  'DUPLICATE_SELECTION',
  'TOO_FEW_SELECTED',
  'TOO_MANY_SELECTED',
  'CONSENT_REQUIRED',
] as const;

export type AnswerProblem = (typeof ANSWER_PROBLEMS)[number];

export type AnswerCheck =
  | { ok: true; value: AnswerValue }
  | { ok: false; problem: AnswerProblem };

/** What a caller sends: a question and a value, and nothing else. */
export interface SubmittedAnswer {
  questionId: string;
  value: unknown;
}

/** One answer, resolved against the version and ready to be written. */
export interface AcceptedAnswer {
  question: FormQuestion;
  value: AnswerValue;
}

export type SubmissionProblem =
  | { code: 'UNKNOWN_QUESTION'; questionId: string }
  | { code: 'DUPLICATE_ANSWER'; questionId: string }
  | { code: 'NOT_ALLOWED'; questionId: string; reason: 'information' | 'inactive' }
  | { code: 'INVALID_ANSWER'; questionId: string; questionKey: string; problem: AnswerProblem }
  | { code: 'REQUIRED_MISSING'; questionId: string; questionKey: string };

export type SubmissionResult =
  | { ok: true; accepted: AcceptedAnswer[] }
  | { ok: false; problems: SubmissionProblem[] };

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * An email address, for the domain layer.
 *
 * Deliberately conservative rather than RFC-complete: exactly one `@`,
 * something either side, a dot-separated domain, and no whitespace or angle
 * brackets. Nothing here is the final word on deliverability — it is the shape
 * that can safely become an identity key.
 */
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>.]+(\.[^\s@<>.]+)+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 160 && EMAIL_PATTERN.test(value);
}

/**
 * A phone number, matching the shape the legacy registration schema already
 * accepts: digits with the punctuation people actually type.
 *
 * No country-code table and no length rules per region — an international
 * validator that is wrong about one country is worse than a permissive one,
 * because it silently refuses a real person.
 */
const PHONE_PATTERN = /^[0-9+\-\s()]{7,20}$/;

export function isPhoneNumber(value: string): boolean {
  return PHONE_PATTERN.test(value) && /[0-9]/.test(value);
}

/** Types whose answer is typed into a field, so a blank one means "skipped". */
const TYPES_ANSWERED_WITH_TEXT: readonly FormQuestionType[] = [
  'SHORT_TEXT',
  'LONG_TEXT',
  'EMAIL',
  'PHONE',
  'DATE',
  // An HTML number input posts `""` when it is left alone.
  'NUMBER',
  'SINGLE_SELECT',
  'DROPDOWN',
];

/**
 * Whether a raw value carries nothing at all, FOR THIS KIND OF QUESTION.
 *
 * An empty string and an empty selection are ABSENCE, not answers: storing `""`
 * for a question somebody skipped would make "did they answer?" unanswerable,
 * and reporting it as a type error would complain about the value instead of
 * naming the question the required check can name.
 *
 * But emptiness is not universal, and treating it as universal is how a
 * malformed payload gets through. `[]` means "nothing selected" for a
 * multi-select and is a WRONG SHAPE for a yes/no question — accepting it there
 * as absence would let a client send garbage to an optional question and be
 * told its submission succeeded. So the question's type decides.
 *
 * With no type given the check is purely structural, which is what a caller
 * asking "is this value blank?" outside a form means.
 */
export function isEmptyAnswer(value: unknown, type?: FormQuestionType): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    if (value.trim().length > 0) return false;
    return type === undefined || TYPES_ANSWERED_WITH_TEXT.includes(type);
  }
  if (Array.isArray(value)) {
    if (value.length > 0) return false;
    return type === undefined || type === 'MULTI_SELECT';
  }
  return false;
}

function textLength(
  value: string,
  validation: FormQuestionValidation | null,
): AnswerProblem | null {
  if (value.length > ANSWER_TEXT_MAX_LENGTH) return 'TOO_LONG';
  if (validation?.minLength !== undefined && value.length < validation.minLength) {
    return 'TOO_SHORT';
  }
  if (validation?.maxLength !== undefined && value.length > validation.maxLength) {
    return 'TOO_LONG';
  }
  return null;
}

/**
 * The calendar day of a configured bound.
 *
 * `minDate` / `maxDate` are stored as full instants (that is the shape the
 * builder's schema accepts), but a `DATE` answer is a calendar day. Comparing
 * the day against the bound's DAY is the only comparison that means anything —
 * anything else would let a time-of-day nobody entered decide whether a
 * birthday is in range.
 */
function boundDay(bound: string | undefined): string | null {
  return bound === undefined ? null : bound.slice(0, 10);
}

/**
 * The furthest ahead of UTC any inhabited place is, in hours.
 *
 * Kiribati sits at UTC+14, so at some instants the calendar there is a day
 * ahead of UTC. Somebody born "today" in Kiritimati is not born in the future.
 */
const MAX_TIMEZONE_AHEAD_MS = 14 * 60 * 60 * 1000;

/**
 * The latest calendar day that can be a date of birth right now.
 *
 * A birth date is refused when it is later than this — not because of an age
 * rule (that arrives with eligibility) but because being born after today is
 * not a fact about a person at all. Storing one would put a NEGATIVE age into
 * the column the eligibility phase reads, and a negative age is a value every
 * comparison downstream will answer wrongly and quietly.
 *
 * The bound is taken at UTC+14 rather than at UTC so that a real birthday in
 * the furthest-ahead timezone is never refused. Erring toward accepting one
 * extra day is right: refusing a real person is the worse failure, and the day
 * after tomorrow is still refused everywhere.
 */
export function latestPossibleBirthDate(nowMs: number): string {
  return new Date(nowMs + MAX_TIMEZONE_AHEAD_MS).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// One answer
// ---------------------------------------------------------------------------

/**
 * Validates one value against one VERSION question, returning the canonical
 * form to store.
 *
 * `options` is passed separately rather than read off `question.options` so a
 * caller that already holds the version's options — the service does — does not
 * have to reassemble the question to ask this. They must be the options of THAT
 * question; the submission-level check is what guarantees it.
 */
export function validateAnswerForQuestion(
  question: Pick<FormQuestion, 'type' | 'required' | 'validation'> &
    Partial<Pick<FormQuestion, 'systemField'>>,
  options: readonly FormQuestionOption[],
  rawValue: unknown,
  nowMs: number = Date.now(),
): AnswerCheck {
  const { type, validation } = question;

  switch (type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT': {
      if (typeof rawValue !== 'string') return { ok: false, problem: 'WRONG_TYPE' };
      const value = rawValue.trim();
      if (value.length === 0) return { ok: false, problem: 'EMPTY' };
      const problem = textLength(value, validation);
      return problem ? { ok: false, problem } : { ok: true, value };
    }

    case 'EMAIL': {
      if (typeof rawValue !== 'string') return { ok: false, problem: 'WRONG_TYPE' };
      const value = rawValue.trim();
      if (value.length === 0) return { ok: false, problem: 'EMPTY' };
      if (!isEmailAddress(value)) return { ok: false, problem: 'INVALID_EMAIL' };
      return { ok: true, value };
    }

    case 'PHONE': {
      if (typeof rawValue !== 'string') return { ok: false, problem: 'WRONG_TYPE' };
      const value = rawValue.trim();
      if (value.length === 0) return { ok: false, problem: 'EMPTY' };
      if (!isPhoneNumber(value)) return { ok: false, problem: 'INVALID_PHONE' };
      const problem = textLength(value, validation);
      return problem ? { ok: false, problem } : { ok: true, value };
    }

    case 'DATE': {
      if (typeof rawValue !== 'string') return { ok: false, problem: 'WRONG_TYPE' };
      const value = rawValue.trim();
      if (value.length === 0) return { ok: false, problem: 'EMPTY' };
      if (!isCivilDate(value)) return { ok: false, problem: 'INVALID_DATE' };

      // The future rule belongs to the SYSTEM FIELD, not to the type. "When can
      // you attend?" is a perfectly good question about next month; "when were
      // you born?" is not.
      if (
        question.systemField === 'DATE_OF_BIRTH' &&
        value > latestPossibleBirthDate(nowMs)
      ) {
        return { ok: false, problem: 'DATE_IN_FUTURE' };
      }

      const min = boundDay(validation?.minDate);
      const max = boundDay(validation?.maxDate);
      if ((min !== null && value < min) || (max !== null && value > max)) {
        return { ok: false, problem: 'DATE_OUT_OF_RANGE' };
      }
      return { ok: true, value };
    }

    case 'NUMBER': {
      // A numeric string is accepted because an HTML number input produces one.
      // Nothing else is: `Number(true)` is 1, `Number([])` is 0 and `Number(null)`
      // is 0, so coercing anything beyond these two would turn a shape mistake
      // into a plausible-looking answer.
      if (typeof rawValue !== 'number' && typeof rawValue !== 'string') {
        return { ok: false, problem: 'WRONG_TYPE' };
      }
      const numeric =
        typeof rawValue === 'number'
          ? rawValue
          : rawValue.trim().length > 0
            ? Number(rawValue)
            : Number.NaN;
      if (!Number.isFinite(numeric)) return { ok: false, problem: 'NOT_A_NUMBER' };
      if (validation?.integerOnly === true && !Number.isInteger(numeric)) {
        return { ok: false, problem: 'NOT_AN_INTEGER' };
      }
      if (numeric < ANSWER_NUMBER_MIN || numeric > ANSWER_NUMBER_MAX) {
        return { ok: false, problem: 'OUT_OF_RANGE' };
      }
      if (validation?.min !== undefined && numeric < validation.min) {
        return { ok: false, problem: 'OUT_OF_RANGE' };
      }
      if (validation?.max !== undefined && numeric > validation.max) {
        return { ok: false, problem: 'OUT_OF_RANGE' };
      }
      return { ok: true, value: numeric };
    }

    case 'YES_NO': {
      if (typeof rawValue !== 'boolean') return { ok: false, problem: 'WRONG_TYPE' };
      return { ok: true, value: rawValue };
    }

    case 'CONSENT': {
      if (typeof rawValue !== 'boolean') return { ok: false, problem: 'WRONG_TYPE' };
      // A required consent answered "no" is not a consent. Unlike YES_NO, where
      // "no" is a legitimate answer, the only thing a required consent question
      // can accept is agreement — that is what makes it a consent.
      if (question.required && rawValue !== true) {
        return { ok: false, problem: 'CONSENT_REQUIRED' };
      }
      return { ok: true, value: rawValue };
    }

    case 'SINGLE_SELECT':
    case 'DROPDOWN': {
      if (typeof rawValue !== 'string') return { ok: false, problem: 'WRONG_TYPE' };
      const value = rawValue.trim();
      if (value.length === 0) return { ok: false, problem: 'EMPTY' };
      const option = options.find((candidate) => candidate.value === value);
      if (!option) return { ok: false, problem: 'UNKNOWN_OPTION' };
      // A deactivated option is not on offer, even though the version keeps it
      // so older entries stay readable.
      if (!option.active) return { ok: false, problem: 'INACTIVE_OPTION' };
      return { ok: true, value };
    }

    case 'MULTI_SELECT': {
      if (!Array.isArray(rawValue)) return { ok: false, problem: 'WRONG_TYPE' };
      if (rawValue.length > ANSWER_SELECTIONS_MAX) {
        return { ok: false, problem: 'TOO_MANY_SELECTED' };
      }
      if (rawValue.some((entry) => typeof entry !== 'string')) {
        return { ok: false, problem: 'WRONG_TYPE' };
      }

      const values = (rawValue as string[]).map((entry) => entry.trim());
      if (values.some((entry) => entry.length === 0)) return { ok: false, problem: 'EMPTY' };
      if (new Set(values).size !== values.length) {
        return { ok: false, problem: 'DUPLICATE_SELECTION' };
      }

      for (const value of values) {
        const option = options.find((candidate) => candidate.value === value);
        if (!option) return { ok: false, problem: 'UNKNOWN_OPTION' };
        if (!option.active) return { ok: false, problem: 'INACTIVE_OPTION' };
      }

      if (validation?.minSelected !== undefined && values.length < validation.minSelected) {
        return { ok: false, problem: 'TOO_FEW_SELECTED' };
      }
      if (validation?.maxSelected !== undefined && values.length > validation.maxSelected) {
        return { ok: false, problem: 'TOO_MANY_SELECTED' };
      }
      // Stored in the option order the version declares, not the order they
      // arrived in: two people who chose the same things should produce the
      // same stored answer.
      const ordered = options
        .filter((option) => values.includes(option.value))
        .map((option) => option.value);
      return { ok: true, value: ordered };
    }

    case 'INFORMATION':
      // Unreachable through `validateSubmission`, which refuses these earlier
      // with a clearer problem. Kept explicit so the switch stays exhaustive.
      return { ok: false, problem: 'WRONG_TYPE' };
  }
}

// ---------------------------------------------------------------------------
// A whole submission
// ---------------------------------------------------------------------------

/** Every question of a version, flattened in the order it is presented. */
export function questionsInOrder(steps: readonly FormStep[]): FormQuestion[] {
  return [...steps]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .flatMap((step) => [...step.questions].sort((a, b) => a.sortOrder - b.sortOrder));
}

/**
 * Validates an entire submission against a published version.
 *
 * Reports EVERY problem rather than the first, so a person fixing a form is not
 * made to discover its faults one round trip at a time. Nothing is written, and
 * nothing is guessed: an answer to a question that is not in this version is a
 * refusal, never a silent discard — quietly dropping it would tell a client its
 * submission succeeded while losing part of what it said.
 */
export function validateSubmission(
  steps: readonly FormStep[],
  answers: readonly SubmittedAnswer[],
  nowMs: number = Date.now(),
): SubmissionResult {
  const questions = questionsInOrder(steps);
  const byId = new Map(questions.map((question) => [question.id, question]));

  const problems: SubmissionProblem[] = [];
  const accepted = new Map<string, AcceptedAnswer>();
  const seen = new Set<string>();

  for (const answer of answers) {
    if (seen.has(answer.questionId)) {
      problems.push({ code: 'DUPLICATE_ANSWER', questionId: answer.questionId });
      continue;
    }
    seen.add(answer.questionId);

    const question = byId.get(answer.questionId);
    if (!question) {
      // Covers a fabricated id, a DRAFT question, a question from another
      // version and a question from another event: none of them are in this
      // version, and this is the only membership that matters.
      problems.push({ code: 'UNKNOWN_QUESTION', questionId: answer.questionId });
      continue;
    }

    if (!questionTypeCollectsAnswer(question.type)) {
      problems.push({ code: 'NOT_ALLOWED', questionId: question.id, reason: 'information' });
      continue;
    }
    if (!question.active) {
      // The version keeps inactive questions so the record stays complete, but
      // nobody was shown them, so nobody can have answered them.
      problems.push({ code: 'NOT_ALLOWED', questionId: question.id, reason: 'inactive' });
      continue;
    }

    // An empty value is an absent answer, not a bad one — but only if it is
    // empty for THIS kind of question. Letting the required check report it
    // names the question instead of complaining about a type.
    if (isEmptyAnswer(answer.value, question.type)) continue;

    const check = validateAnswerForQuestion(question, question.options, answer.value, nowMs);
    if (!check.ok) {
      problems.push({
        code: 'INVALID_ANSWER',
        questionId: question.id,
        questionKey: question.key,
        problem: check.problem,
      });
      continue;
    }
    accepted.set(question.id, { question, value: check.value });
  }

  for (const question of questions) {
    if (!question.active || !question.required) continue;
    if (!questionTypeCollectsAnswer(question.type)) continue;
    if (accepted.has(question.id)) continue;
    problems.push({
      code: 'REQUIRED_MISSING',
      questionId: question.id,
      questionKey: question.key,
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  // Stored in presentation order, so reading an entry back reads like the form.
  return {
    ok: true,
    accepted: questions
      .map((question) => accepted.get(question.id))
      .filter((entry): entry is AcceptedAnswer => entry !== undefined),
  };
}

// ---------------------------------------------------------------------------
// System fields
// ---------------------------------------------------------------------------

/**
 * The identity a submission describes, read off its own answers.
 *
 * There is no second `participant` object in the input. The form already asks
 * for a name and an email — asking for them twice would create two sources that
 * can disagree, and then a rule about which one wins. The system-field marker
 * exists precisely so "the email question" can be found without guessing from a
 * label, and this is what it is for.
 */
export interface ParticipantProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  dateOfBirth: string | null;
}

export type ProfileResult =
  | { ok: true; profile: ParticipantProfile }
  | { ok: false; missing: NamedSystemField[] };

function findSystemAnswer(
  accepted: readonly AcceptedAnswer[],
  field: NamedSystemField,
): AnswerValue | null {
  const entry = accepted.find((candidate) => candidate.question.systemField === field);
  return entry ? entry.value : null;
}

/**
 * Extracts the participant profile from accepted answers.
 *
 * Publishing already guarantees that a version carries `FIRST_NAME`,
 * `LAST_NAME` and `EMAIL`, active and required — so reaching the `missing`
 * branch means the stored version is not what publishing would have produced.
 * That is reported rather than patched over: a participant created with an
 * empty name is a row nobody can ever identify again.
 */
export function extractParticipantProfile(accepted: readonly AcceptedAnswer[]): ProfileResult {
  const firstName = findSystemAnswer(accepted, 'FIRST_NAME');
  const lastName = findSystemAnswer(accepted, 'LAST_NAME');
  const email = findSystemAnswer(accepted, 'EMAIL');

  const missing: NamedSystemField[] = [];
  if (typeof firstName !== 'string' || firstName.length === 0) missing.push('FIRST_NAME');
  if (typeof lastName !== 'string' || lastName.length === 0) missing.push('LAST_NAME');
  if (typeof email !== 'string' || email.length === 0) missing.push('EMAIL');
  if (missing.length > 0) return { ok: false, missing };

  const phone = findSystemAnswer(accepted, 'PHONE');
  const dateOfBirth = findSystemAnswer(accepted, 'DATE_OF_BIRTH');

  return {
    ok: true,
    profile: {
      firstName: firstName as string,
      lastName: lastName as string,
      email: email as string,
      phone: typeof phone === 'string' && phone.length > 0 ? phone : null,
      dateOfBirth: typeof dateOfBirth === 'string' && isCivilDate(dateOfBirth) ? dateOfBirth : null,
    },
  };
}

/** True for a question whose answers this phase stores. */
export function questionAcceptsAnswers(question: Pick<FormQuestion, 'type' | 'active'>): boolean {
  return question.active && questionTypeCollectsAnswer(question.type);
}

/** True when a question's answer must be checked against its option list. */
export function answerNeedsOptions(type: FormQuestionType): boolean {
  return questionTypeSupportsOptions(type);
}

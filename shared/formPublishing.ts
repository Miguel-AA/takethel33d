// What it takes for a draft to become a published version, and what a version
// looks like once it is one.
//
// SHARED so the backend, the dev mock and the builder UI all read ONE table.
// The server re-validates everything regardless — the UI merely tells an
// operator what is missing before they press the button.
//
// The distinction this file exists to draw:
//
//   structurally valid draft — a form that STORES correctly. A half-built one
//                              is fine; that is what a draft is for.
//   publishable draft        — a form that can be put in front of a person.
//
// Everything below is the second question. None of it constrains editing.

import type { EventFormDraft, FormQuestion, FormQuestionValidation, FormStep } from './types.ts';
import {
  NAMED_SYSTEM_FIELDS,
  SYSTEM_FIELD_TYPE,
  VALIDATION_KEYS_BY_TYPE,
  isReservedQuestionKey,
  questionTypeCollectsAnswer,
  questionTypeSupportsOptions,
  type FormQuestionType,
  type NamedSystemField,
} from './formLifecycle.ts';

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * System fields every published form must carry, and must ask for.
 *
 * These three are how a submission becomes attributable to a person at all.
 * A form that does not ask for them cannot identify who filled it in, which
 * makes everything downstream — a draw, a notification, a duplicate check —
 * impossible to do honestly.
 */
export const REQUIRED_SYSTEM_FIELDS: readonly NamedSystemField[] = [
  'FIRST_NAME',
  'LAST_NAME',
  'EMAIL',
];

/**
 * A choice with one option is not a choice.
 *
 * Offering a single answer is either a mistake or a consent checkbox wearing
 * the wrong type, and both are better caught now than by a participant.
 */
export const SELECT_MIN_ACTIVE_OPTIONS = 2;

/**
 * Whether a published wizard may contain a page that asks nothing.
 *
 * It may not. A participant clicking "next" through an empty page is being
 * asked to do nothing for no reason, and it is always an editing accident
 * rather than an intention.
 */
export const ALLOW_EMPTY_PUBLISHED_STEPS = false;

/**
 * Whether inactive questions travel into the published version.
 *
 * They DO. A version is the historical record of a form, and dropping the
 * questions an operator had switched off would make the record disagree with
 * the draft it came from — and make a later "why did this change?" impossible
 * to answer. The public renderer hides them; the version keeps them, marked.
 */
export const PUBLISH_PRESERVES_INACTIVE_QUESTIONS = true;

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const FORM_PUBLISH_ISSUE_CODES = [
  'NO_DRAFT',
  'NO_STEPS',
  'EMPTY_STEP',
  'MISSING_SYSTEM_FIELD',
  'SYSTEM_FIELD_NOT_REQUIRED',
  'SYSTEM_FIELD_INACTIVE',
  'SYSTEM_FIELD_TYPE_INVALID',
  'DUPLICATE_SYSTEM_FIELD',
  'DUPLICATE_KEY',
  'RESERVED_KEY',
  'SELECT_REQUIRES_OPTIONS',
  'INVALID_VALIDATION',
  'NO_ANSWERABLE_QUESTION',
  'QUESTION_OUTSIDE_STEP',
] as const;

export type FormPublishIssueCode = (typeof FORM_PUBLISH_ISSUE_CODES)[number];

/**
 * One reason a draft cannot be published.
 *
 * The CODE is the contract; the ids are what let the builder walk an operator
 * to the thing that needs fixing. Human text is produced by the UI from the
 * code, never sent as the contract.
 */
export interface FormPublishIssue {
  code: FormPublishIssueCode;
  stepId?: string;
  questionId?: string;
  /** The system field or question key the issue is about, when there is one. */
  subject?: string;
}

export interface FormPublishValidation {
  publishable: boolean;
  errors: FormPublishIssue[];
  /** Non-blocking observations. Publishing proceeds regardless. */
  warnings: FormPublishIssue[];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

function validationKeysAreCoherent(
  type: FormQuestionType,
  validation: FormQuestionValidation | null,
): boolean {
  if (!validation) return true;
  const allowed = VALIDATION_KEYS_BY_TYPE[type];
  return Object.keys(validation).every((key) => allowed.includes(key));
}

/**
 * Everything standing between this draft and a published version.
 *
 * `minimumAge` comes from the event: asking for an age limit without asking
 * when someone was born is a rule nothing could ever enforce. This phase only
 * requires the QUESTION — no age is computed anywhere yet.
 */
export function evaluatePublishability(
  draft: EventFormDraft | null,
  event: { minimumAge: number | null },
): FormPublishValidation {
  const errors: FormPublishIssue[] = [];
  const warnings: FormPublishIssue[] = [];

  if (!draft) {
    return { publishable: false, errors: [{ code: 'NO_DRAFT' }], warnings };
  }

  if (draft.steps.length === 0) {
    return { publishable: false, errors: [{ code: 'NO_STEPS' }], warnings };
  }

  const questions: FormQuestion[] = draft.steps.flatMap((step) => step.questions);

  // --- Steps -------------------------------------------------------------
  if (!ALLOW_EMPTY_PUBLISHED_STEPS) {
    for (const step of draft.steps) {
      if (step.questions.length === 0) {
        errors.push({ code: 'EMPTY_STEP', stepId: step.id, subject: step.title });
      }
    }
  }

  // --- Keys --------------------------------------------------------------
  const seenKeys = new Map<string, string>();
  for (const question of questions) {
    if (isReservedQuestionKey(question.key)) {
      errors.push({ code: 'RESERVED_KEY', questionId: question.id, subject: question.key });
    }
    const previous = seenKeys.get(question.key);
    if (previous) {
      errors.push({ code: 'DUPLICATE_KEY', questionId: question.id, subject: question.key });
    } else {
      seenKeys.set(question.key, question.id);
    }
  }

  // --- System fields -----------------------------------------------------
  const bySystemField = new Map<NamedSystemField, FormQuestion[]>();
  for (const question of questions) {
    if (question.systemField === 'NONE') continue;
    const field = question.systemField as NamedSystemField;
    bySystemField.set(field, [...(bySystemField.get(field) ?? []), question]);
  }

  for (const [field, found] of bySystemField) {
    if (found.length > 1) {
      // The unique index makes this unreachable through the application; it is
      // checked anyway because publishing is the last gate before a person
      // sees the form.
      errors.push({ code: 'DUPLICATE_SYSTEM_FIELD', subject: field });
    }
    const question = found[0];
    if (question.type !== SYSTEM_FIELD_TYPE[field]) {
      errors.push({
        code: 'SYSTEM_FIELD_TYPE_INVALID',
        questionId: question.id,
        subject: field,
      });
    }
  }

  const mustBePresent: NamedSystemField[] = [...REQUIRED_SYSTEM_FIELDS];
  // A minimum age with nothing to check it against is a rule that cannot run.
  if (event.minimumAge !== null) mustBePresent.push('DATE_OF_BIRTH');

  for (const field of mustBePresent) {
    const question = bySystemField.get(field)?.[0];
    if (!question) {
      errors.push({ code: 'MISSING_SYSTEM_FIELD', subject: field });
      continue;
    }
    if (!question.active) {
      errors.push({
        code: 'SYSTEM_FIELD_INACTIVE',
        questionId: question.id,
        subject: field,
      });
    }
    if (!question.required) {
      errors.push({
        code: 'SYSTEM_FIELD_NOT_REQUIRED',
        questionId: question.id,
        subject: field,
      });
    }
  }

  // --- Per-question shape ------------------------------------------------
  let answerable = 0;
  for (const question of questions) {
    if (question.active && questionTypeCollectsAnswer(question.type)) answerable += 1;

    if (questionTypeSupportsOptions(question.type)) {
      const usable = question.options.filter((option) => option.active).length;
      if (question.active && usable < SELECT_MIN_ACTIVE_OPTIONS) {
        errors.push({
          code: 'SELECT_REQUIRES_OPTIONS',
          stepId: question.stepId,
          questionId: question.id,
          subject: question.label,
        });
      }
    }

    if (!validationKeysAreCoherent(question.type, question.validation)) {
      errors.push({
        code: 'INVALID_VALIDATION',
        questionId: question.id,
        subject: question.key,
      });
    }
  }

  if (answerable === 0) {
    errors.push({ code: 'NO_ANSWERABLE_QUESTION' });
  }

  // --- Warnings ----------------------------------------------------------
  for (const question of questions) {
    if (!question.active && question.systemField === 'NONE') {
      warnings.push({
        code: 'SYSTEM_FIELD_INACTIVE',
        questionId: question.id,
        subject: question.key,
      });
    }
  }

  return { publishable: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface FormSnapshotOption {
  id: string;
  value: string;
  label: string;
  sortOrder: number;
  active: boolean;
}

export interface FormSnapshotQuestion {
  id: string;
  key: string;
  systemField: string;
  type: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  required: boolean;
  active: boolean;
  exportable: boolean;
  sortOrder: number;
  validation: FormQuestionValidation | null;
  options: FormSnapshotOption[];
}

export interface FormSnapshotStep {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  questions: FormSnapshotQuestion[];
}

export interface FormSchemaSnapshot {
  /** Snapshot format, so a later reader knows what it is looking at. */
  snapshotVersion: 1;
  eventId: string;
  versionNumber: number;
  sourceDraftRevision: number;
  publishedAt: string;
  steps: FormSnapshotStep[];
  summary: {
    stepCount: number;
    questionCount: number;
    optionCount: number;
    systemFields: string[];
    questionTypes: string[];
  };
}

/**
 * A deterministic rendering of a form.
 *
 * CANONICAL: the same logical form always produces the same structure, because
 * everything is sorted by the position it occupies — steps, then questions
 * within a step, then options within a question, with the row id breaking ties.
 * Edit timestamps are deliberately absent: they say when someone typed, not
 * what was published, and including them would make two identical forms produce
 * two different snapshots.
 */
export function buildFormSnapshot(
  draft: EventFormDraft,
  meta: { versionNumber: number; publishedAt: string },
): FormSchemaSnapshot {
  const byOrder = <T extends { sortOrder: number; id: string }>(items: T[]): T[] =>
    [...items].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));

  const steps: FormSnapshotStep[] = byOrder(draft.steps as FormStep[]).map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    sortOrder: step.sortOrder,
    questions: byOrder(step.questions).map((question) => ({
      id: question.id,
      key: question.key,
      systemField: question.systemField,
      type: question.type,
      label: question.label,
      description: question.description,
      placeholder: question.placeholder,
      required: question.required,
      active: question.active,
      exportable: question.exportable,
      sortOrder: question.sortOrder,
      validation: question.validation,
      options: byOrder(question.options).map((option) => ({
        id: option.id,
        value: option.value,
        label: option.label,
        sortOrder: option.sortOrder,
        active: option.active,
      })),
    })),
  }));

  const questions = steps.flatMap((step) => step.questions);

  return {
    snapshotVersion: 1,
    eventId: draft.eventId,
    versionNumber: meta.versionNumber,
    sourceDraftRevision: draft.revision,
    publishedAt: meta.publishedAt,
    steps,
    summary: {
      stepCount: steps.length,
      questionCount: questions.length,
      optionCount: questions.reduce((sum, question) => sum + question.options.length, 0),
      systemFields: [
        ...new Set(
          questions
            .map((question) => question.systemField)
            .filter((field) => field !== 'NONE'),
        ),
      ].sort(),
      questionTypes: [...new Set(questions.map((question) => question.type))].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// Dirty state
// ---------------------------------------------------------------------------

/**
 * Whether the draft holds edits the published version does not.
 *
 * A revision comparison, not a diff: the draft's revision moves on every
 * mutation, so "has anything changed since we published?" is one integer
 * against another rather than two whole forms walked on every render.
 */
export function hasUnpublishedChanges(
  draftRevision: number | null,
  publishedSourceRevision: number | null,
): boolean {
  if (draftRevision === null) return false;
  if (publishedSourceRevision === null) return true;
  return draftRevision > publishedSourceRevision;
}

/** Which system fields a published form is still missing. */
export function missingRequiredSystemFields(
  draft: EventFormDraft | null,
  event: { minimumAge: number | null },
): NamedSystemField[] {
  const present = new Set(
    (draft?.steps ?? [])
      .flatMap((step) => step.questions)
      .map((question) => question.systemField),
  );
  const expected: NamedSystemField[] = [...REQUIRED_SYSTEM_FIELDS];
  if (event.minimumAge !== null) expected.push('DATE_OF_BIRTH');
  return expected.filter((field) => !present.has(field));
}

export { NAMED_SYSTEM_FIELDS };

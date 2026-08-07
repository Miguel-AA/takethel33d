// The form domain's vocabulary and its rules.
//
// SHARED so the builder UI, the dev mock and the backend all read ONE table.
// The server re-validates everything regardless — the UI merely avoids offering
// a control that would be refused.
//
// The central idea of this phase: a registration form is DATA. There is no
// column named `smoker_status` anywhere, and adding one must never be the way a
// client asks a new question. A question is a row; its options are rows; the
// order is a number. Nothing here is generated at build time.

import type { EventStatus } from './eventLifecycle.ts';

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * What a step or question belongs to.
 *
 * `DRAFT` is the working copy an administrator edits — the only owner this
 * phase writes. `VERSION` is the frozen, published copy that participants will
 * fill in; publishing arrives in the next phase, and the column exists now so
 * that phase copies rows rather than migrating a table.
 *
 * The owner id therefore CANNOT carry a foreign key: its referent depends on
 * the type, and one of the two tables does not exist yet. Referential integrity
 * for drafts is enforced by the service, which only ever resolves a step or
 * question through the draft it loaded.
 */
export const FORM_OWNER_TYPES = ['DRAFT', 'VERSION'] as const;
export type FormOwnerType = (typeof FORM_OWNER_TYPES)[number];

// ---------------------------------------------------------------------------
// Question types
// ---------------------------------------------------------------------------

export const FORM_QUESTION_TYPES = [
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
] as const;

export type FormQuestionType = (typeof FORM_QUESTION_TYPES)[number];

/** Types whose answer is chosen from a list the operator maintains. */
export const TYPES_WITH_OPTIONS: readonly FormQuestionType[] = [
  'SINGLE_SELECT',
  'MULTI_SELECT',
  'DROPDOWN',
];

/** Types rendered as an input that can carry hint text. */
export const TYPES_WITH_PLACEHOLDER: readonly FormQuestionType[] = [
  'SHORT_TEXT',
  'LONG_TEXT',
  'EMAIL',
  'PHONE',
  'DATE',
  'NUMBER',
  'DROPDOWN',
];

/**
 * `INFORMATION` is a block of copy, not a question: it collects nothing, so it
 * can be neither required nor exported, and an answer to it cannot exist.
 */
export const TYPES_WITHOUT_ANSWER: readonly FormQuestionType[] = ['INFORMATION'];

export function questionTypeSupportsOptions(type: FormQuestionType): boolean {
  return TYPES_WITH_OPTIONS.includes(type);
}

export function questionTypeSupportsPlaceholder(type: FormQuestionType): boolean {
  return TYPES_WITH_PLACEHOLDER.includes(type);
}

export function questionTypeCollectsAnswer(type: FormQuestionType): boolean {
  return !TYPES_WITHOUT_ANSWER.includes(type);
}

/** Which validation keys mean anything for a type. Everything else is refused. */
export const VALIDATION_KEYS_BY_TYPE: Record<FormQuestionType, readonly string[]> = {
  SHORT_TEXT: ['minLength', 'maxLength'],
  LONG_TEXT: ['minLength', 'maxLength'],
  EMAIL: [],
  PHONE: ['minLength', 'maxLength'],
  DATE: ['minDate', 'maxDate'],
  NUMBER: ['min', 'max', 'integerOnly'],
  YES_NO: [],
  SINGLE_SELECT: [],
  MULTI_SELECT: ['minSelected', 'maxSelected'],
  DROPDOWN: [],
  CONSENT: [],
  INFORMATION: [],
};

/**
 * Answer keys no question may use.
 *
 * An answer set is naturally a plain object keyed by these values, and these
 * three names do not behave like ordinary keys on one: `__proto__` reassigns
 * the prototype, and `constructor` / `prototype` shadow members every object
 * already has. The JSON parser already strips them on the way in, but a key is
 * chosen ONCE and then used forever by whatever consumes answers later — so it
 * is refused at the point it is named, not left for a future phase to survive.
 */
export const RESERVED_QUESTION_KEYS: readonly string[] = [
  '__proto__',
  'constructor',
  'prototype',
];

export function isReservedQuestionKey(key: string): boolean {
  return RESERVED_QUESTION_KEYS.includes(key.toLowerCase());
}

// ---------------------------------------------------------------------------
// System fields
// ---------------------------------------------------------------------------

/**
 * Identities the platform itself understands.
 *
 * A question marked with one of these is still an ordinary row — it is not a
 * column and not special-cased in storage. The marker exists so later phases
 * can find "the email question" without guessing from a label, and so the
 * builder can stop an operator from asking for an email address twice.
 *
 * `NONE` is the default: every custom question a client invents carries it.
 */
export const FORM_SYSTEM_FIELDS = [
  'FIRST_NAME',
  'LAST_NAME',
  'EMAIL',
  'DATE_OF_BIRTH',
  'PHONE',
  'NONE',
] as const;

export type FormSystemField = (typeof FORM_SYSTEM_FIELDS)[number];
export type NamedSystemField = Exclude<FormSystemField, 'NONE'>;

export const NAMED_SYSTEM_FIELDS: readonly NamedSystemField[] = FORM_SYSTEM_FIELDS.filter(
  (field): field is NamedSystemField => field !== 'NONE',
);

/** The type a system field is pinned to. It cannot be changed afterwards. */
export const SYSTEM_FIELD_TYPE: Record<NamedSystemField, FormQuestionType> = {
  FIRST_NAME: 'SHORT_TEXT',
  LAST_NAME: 'SHORT_TEXT',
  EMAIL: 'EMAIL',
  DATE_OF_BIRTH: 'DATE',
  PHONE: 'PHONE',
};

/** The answer key a system field always uses, so exports stay predictable. */
export const SYSTEM_FIELD_KEY: Record<NamedSystemField, string> = {
  FIRST_NAME: 'first_name',
  LAST_NAME: 'last_name',
  EMAIL: 'email',
  DATE_OF_BIRTH: 'date_of_birth',
  PHONE: 'phone',
};

/** Default label, so adding one from the builder needs no typing. */
export const SYSTEM_FIELD_LABEL: Record<NamedSystemField, string> = {
  FIRST_NAME: 'First name',
  LAST_NAME: 'Last name',
  EMAIL: 'Email',
  DATE_OF_BIRTH: 'Date of birth',
  PHONE: 'Phone',
};

export function isNamedSystemField(value: FormSystemField): value is NamedSystemField {
  return value !== 'NONE';
}

/**
 * Fields a patch may touch on a question, given what it is.
 *
 * A system field's identity is fixed — its `type`, its `key` and the marker
 * itself are what make it findable — but everything an operator would actually
 * want to change about how it READS stays editable.
 */
export const QUESTION_EDITORIAL_FIELDS = [
  'label',
  'description',
  'placeholder',
  'required',
  'active',
] as const;

export const QUESTION_CUSTOM_ONLY_FIELDS = ['type', 'key', 'exportable'] as const;

export function editableQuestionFields(systemField: FormSystemField): string[] {
  return isNamedSystemField(systemField)
    ? [...QUESTION_EDITORIAL_FIELDS, 'validation']
    : [...QUESTION_EDITORIAL_FIELDS, ...QUESTION_CUSTOM_ONLY_FIELDS, 'validation'];
}

/**
 * Whether a question may be removed outright.
 *
 * A REQUIRED system field is load-bearing: something downstream expects an
 * answer to it. Deleting it is refused so the removal has to be deliberate —
 * clear `required` first, or deactivate it.
 */
export function canDeleteQuestion(systemField: FormSystemField, required: boolean): boolean {
  return !(isNamedSystemField(systemField) && required);
}

// ---------------------------------------------------------------------------
// What the EVENT's state permits
// ---------------------------------------------------------------------------

/**
 * Whether the draft may be edited at all.
 *
 * The draft is a working copy — it is NOT what anyone fills in, so editing it
 * while registration is open is legitimate preparation for the next published
 * version rather than a change under participants' feet. Once the event has
 * closed there is nothing left to prepare, so it becomes read-only.
 */
export const FORM_EDITABLE_EVENT_STATUSES: readonly EventStatus[] = [
  'DRAFT',
  'SCHEDULED',
  'OPEN',
];

export function eventAllowsFormEditing(status: EventStatus): boolean {
  return FORM_EDITABLE_EVENT_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Preview problems
//
// Reported by the preview endpoint, never thrown: a draft is allowed to be
// incomplete. These are what publishing will refuse in the next phase, surfaced
// now so an operator finds out while they are still editing.
// ---------------------------------------------------------------------------

export const FORM_PREVIEW_PROBLEMS = [
  'NO_STEPS',
  'EMPTY_STEP',
  'NO_ACTIVE_QUESTIONS',
  'SELECT_WITHOUT_OPTIONS',
  'REQUIRED_QUESTION_INACTIVE',
] as const;

export type FormPreviewProblemCode = (typeof FORM_PREVIEW_PROBLEMS)[number];

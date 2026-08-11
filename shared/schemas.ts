import { z } from 'zod';
import {
  ADMIN_PASSWORD_MAX_LENGTH,
  ADMIN_PASSWORD_MIN_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  EMAIL_MAX_LENGTH,
  EVENT_BANNER_URL_MAX_LENGTH,
  EVENT_DESCRIPTION_MAX_LENGTH,
  EVENT_LOCATION_MAX_LENGTH,
  EVENT_MAX_ENTRIES_MAX,
  EVENT_MAX_ENTRIES_MIN,
  EVENT_MESSAGE_BODY_MAX_LENGTH,
  EVENT_MESSAGE_TITLE_MAX_LENGTH,
  EVENT_MIN_AGE_MAX,
  EVENT_MIN_AGE_MIN,
  EVENT_NAME_MAX_LENGTH,
  PRIZE_DESCRIPTION_MAX_LENGTH,
  PRIZE_IMAGE_URL_MAX_LENGTH,
  PRIZE_NAME_MAX_LENGTH,
  PRIZE_QUANTITY_MAX,
  PRIZE_QUANTITY_MIN,
  PRIZE_SORT_ORDER_MAX,
  PRIZES_PER_EVENT_MAX,
  FORM_STEP_TITLE_MAX_LENGTH,
  FORM_STEP_DESCRIPTION_MAX_LENGTH,
  FORM_QUESTION_KEY_MAX_LENGTH,
  FORM_QUESTION_LABEL_MAX_LENGTH,
  FORM_QUESTION_DESCRIPTION_MAX_LENGTH,
  FORM_QUESTION_PLACEHOLDER_MAX_LENGTH,
  FORM_OPTION_VALUE_MAX_LENGTH,
  FORM_OPTION_LABEL_MAX_LENGTH,
  FORM_STEPS_MAX,
  FORM_QUESTIONS_MAX,
  FORM_OPTIONS_PER_QUESTION_MAX,
  FORM_SORT_ORDER_MAX,
  FORM_VALIDATION_NUMBER_MIN,
  FORM_VALIDATION_NUMBER_MAX,
  FORM_VALIDATION_TEXT_MAX,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  SEARCH_MAX_LENGTH,
  ANSWERS_PER_ENTRY_MAX,
  PUBLIC_FORM_TOKEN_MAX_BYTES,
  DISQUALIFICATION_REASON_MIN_LENGTH,
  DISQUALIFICATION_REASON_MAX_LENGTH,
} from './limits.ts';
import {
  PARTICIPANT_ELIGIBILITY_FILTERS,
  PARTICIPANT_STATUS_FILTERS,
} from './participantAdministration.ts';
import { EVENT_STATUSES } from './eventLifecycle.ts';
import { PRIZE_STATUSES } from './prizeLifecycle.ts';
import {
  FORM_QUESTION_TYPES,
  FORM_SYSTEM_FIELDS,
  isReservedQuestionKey,
} from './formLifecycle.ts';
import { SLUG_MAX_LENGTH, SLUG_MIN_LENGTH, SLUG_PATTERN } from './slug.ts';

export const housingStatusSchema = z.enum(['OWNER', 'RENTER']);

export const educationLevelSchema = z.enum([
  'HIGH_SCHOOL',
  'SOME_COLLEGE',
  'ASSOCIATE',
  'BACHELORS',
  'MASTERS',
  'DOCTORATE',
  'OTHER',
]);

// Accepts a real boolean (JSON API clients) or the "true"/"false" strings that
// HTML radio inputs produce, so the same schema validates both transports.
const booleanFromForm = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((v) => v === 'true'),
]);

export const registerSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(EMAIL_MAX_LENGTH),
  phone: z
    .string()
    .trim()
    .min(7)
    .max(20)
    .regex(/^[0-9+\-\s()]+$/, 'invalid_phone'),
  highestLevelOfEducation: educationLevelSchema,
  age: z.coerce.number().int().min(16).max(120),
  zip: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, 'invalid_zip'),
  city: z.string().trim().max(120).optional(),
  housingStatus: housingStatusSchema,
  ownsVehicle: booleanFromForm,
  isBusinessOwner: booleanFromForm,
});

export type RegisterInput = z.infer<typeof registerSchema>;

// ---------------------------------------------------------------------------
// Administrative identity
// ---------------------------------------------------------------------------

/**
 * Canonical form of an admin email. `admin_users.normalized_email` stores this
 * value and carries the UNIQUE index, so lookups are always case-insensitive
 * and whitespace-insensitive regardless of how the address was typed.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Bounds come from the central limits module so a value is never defined twice
// and cannot drift between the schema and the storage layer. The explicit `.ts`
// extension keeps `scripts/bootstrap-admin.ts` runnable under plain Node, whose
// ESM resolver does not guess extensions.
export {
  ADMIN_PASSWORD_MIN_LENGTH,
  ADMIN_PASSWORD_MAX_LENGTH,
} from './limits.ts';

/**
 * Login input. The password is only length-bounded here: an existing account
 * created before a policy change must still be able to sign in, so complexity
 * rules belong on the creation path (`adminBootstrapSchema`), not here.
 */
export const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(EMAIL_MAX_LENGTH),
  password: z.string().min(1).max(ADMIN_PASSWORD_MAX_LENGTH),
});

export type AdminLoginSchemaInput = z.infer<typeof adminLoginSchema>;

/** Input accepted by `scripts/bootstrap-admin.ts` when creating an admin. */
export const adminBootstrapSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(EMAIL_MAX_LENGTH),
  displayName: z.string().trim().min(1).max(DISPLAY_NAME_MAX_LENGTH),
  password: z
    .string()
    .min(ADMIN_PASSWORD_MIN_LENGTH, 'password_too_short')
    .max(ADMIN_PASSWORD_MAX_LENGTH),
});

export type AdminBootstrapInput = z.infer<typeof adminBootstrapSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const isoTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'invalid_timestamp');

/** A nullable ISO instant: `null` clears the field, absent leaves it alone. */
const nullableTimestamp = isoTimestamp.nullable();

const slugField = z
  .string()
  .trim()
  .min(SLUG_MIN_LENGTH, 'invalid_slug')
  .max(SLUG_MAX_LENGTH, 'invalid_slug')
  .regex(SLUG_PATTERN, 'invalid_slug');

/**
 * Banner URL. Restricted to http/https so a stored `javascript:` or `data:`
 * value can never become an executable link in the admin UI.
 */
const bannerUrlField = z
  .string()
  .trim()
  .max(EVENT_BANNER_URL_MAX_LENGTH)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'invalid_url' },
  )
  .nullable();

const nameField = z.string().trim().min(1).max(EVENT_NAME_MAX_LENGTH);
const descriptionField = z
  .string()
  .trim()
  .max(EVENT_DESCRIPTION_MAX_LENGTH)
  .nullable();
const locationField = z.string().trim().max(EVENT_LOCATION_MAX_LENGTH).nullable();
const messageTitleField = z
  .string()
  .trim()
  .max(EVENT_MESSAGE_TITLE_MAX_LENGTH)
  .nullable();
const messageBodyField = z
  .string()
  .trim()
  .max(EVENT_MESSAGE_BODY_MAX_LENGTH)
  .nullable();

const timezoneField = z.string().trim().min(1).max(64);
const minimumAgeField = z.coerce
  .number()
  .int()
  .min(EVENT_MIN_AGE_MIN)
  .max(EVENT_MIN_AGE_MAX)
  .nullable();
const maxEntriesField = z.coerce
  .number()
  .int()
  .min(EVENT_MAX_ENTRIES_MIN)
  .max(EVENT_MAX_ENTRIES_MAX);

/**
 * Creation input. Only `name` is required: a draft exists to be filled in
 * gradually, so demanding a full configuration up front would defeat it.
 * `.strict()` rejects unknown keys, which is what stops `status` or
 * `createdBy` from being mass-assigned.
 */
export const createEventSchema = z
  .object({
    name: nameField,
    slug: slugField.optional(),
    timezone: timezoneField.optional(),
    description: descriptionField.optional(),
    bannerUrl: bannerUrlField.optional(),
    locationName: locationField.optional(),
    registrationOpensAt: nullableTimestamp.optional(),
    registrationClosesAt: nullableTimestamp.optional(),
    startsAt: nullableTimestamp.optional(),
    endsAt: nullableTimestamp.optional(),
    minimumAge: minimumAgeField.optional(),
    maxEntriesPerIdentity: maxEntriesField.optional(),
    confirmationTitle: messageTitleField.optional(),
    confirmationMessage: messageBodyField.optional(),
    ineligibleTitle: messageTitleField.optional(),
    ineligibleMessage: messageBodyField.optional(),
  })
  .strict();

export type CreateEventSchemaInput = z.infer<typeof createEventSchema>;

/**
 * Update input. Every field optional, `status` absent by construction, and
 * `expectedRevision` mandatory so a stale form cannot silently overwrite a
 * change made after it was loaded.
 */
export const updateEventSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    name: nameField.optional(),
    slug: slugField.optional(),
    timezone: timezoneField.optional(),
    description: descriptionField.optional(),
    bannerUrl: bannerUrlField.optional(),
    locationName: locationField.optional(),
    registrationOpensAt: nullableTimestamp.optional(),
    registrationClosesAt: nullableTimestamp.optional(),
    startsAt: nullableTimestamp.optional(),
    endsAt: nullableTimestamp.optional(),
    minimumAge: minimumAgeField.optional(),
    maxEntriesPerIdentity: maxEntriesField.optional(),
    confirmationTitle: messageTitleField.optional(),
    confirmationMessage: messageBodyField.optional(),
    ineligibleTitle: messageTitleField.optional(),
    ineligibleMessage: messageBodyField.optional(),
  })
  .strict()
  .refine(
    (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
    { message: 'empty_patch' },
  );

export type UpdateEventSchemaInput = z.infer<typeof updateEventSchema>;

export const duplicateEventSchema = z
  .object({
    name: nameField.optional(),
    slug: slugField.optional(),
    copyDates: z.boolean().optional(),
  })
  .strict();

/**
 * Transition input. Transitions take no parameters, so an empty object is the
 * whole contract; `expectedRevision` is optional here because the action is
 * itself state-guarded — but when supplied it is enforced.
 */
export const eventTransitionSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const eventIdSchema = z.string().uuid();
export const eventSlugSchema = slugField;

export const eventListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    status: z.enum(EVENT_STATUSES).nullable().default(null),
    search: z.string().trim().max(120).nullable().default(null),
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    sort: z.enum(['createdAt', 'updatedAt', 'name', 'startsAt']).default('createdAt'),
    direction: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Event prizes
// ---------------------------------------------------------------------------

/**
 * Image URL. Restricted to http/https so a stored `javascript:`, `data:` or
 * `file:` value can never become an executable link or a local-file read in
 * the admin UI. Relative values are rejected too — `new URL` requires a scheme.
 */
const prizeImageUrlField = z
  .string()
  .trim()
  .min(1)
  .max(PRIZE_IMAGE_URL_MAX_LENGTH)
  .refine(
    (value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'invalid_image_url' },
  )
  .nullable();

const prizeNameField = z.string().trim().min(1).max(PRIZE_NAME_MAX_LENGTH);
const prizeDescriptionField = z
  .string()
  .trim()
  .max(PRIZE_DESCRIPTION_MAX_LENGTH)
  .nullable();
const prizeQuantityField = z.coerce
  .number()
  .int()
  .min(PRIZE_QUANTITY_MIN)
  .max(PRIZE_QUANTITY_MAX);

/**
 * Creation input. `.strict()` is what refuses `status`, `revision`, `eventId`
 * and every actor/timestamp column — the mass-assignment guard.
 */
export const createEventPrizeSchema = z
  .object({
    name: prizeNameField,
    description: prizeDescriptionField.optional(),
    imageUrl: prizeImageUrlField.optional(),
    quantity: prizeQuantityField,
    sortOrder: z.coerce.number().int().min(0).max(PRIZE_SORT_ORDER_MAX).optional(),
  })
  .strict();

export type CreateEventPrizeSchemaInput = z.infer<typeof createEventPrizeSchema>;

/**
 * Update input. Only the four content fields; order and status move through
 * their own endpoints, so neither can ride in on a patch.
 */
export const updateEventPrizeSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1),
    name: prizeNameField.optional(),
    description: prizeDescriptionField.optional(),
    imageUrl: prizeImageUrlField.optional(),
    quantity: prizeQuantityField.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedRevision'), {
    message: 'empty_patch',
  });

export type UpdateEventPrizeSchemaInput = z.infer<typeof updateEventPrizeSchema>;

/** Status actions take no parameters beyond an optional revision guard. */
export const prizeTransitionSchema = z
  .object({
    expectedRevision: z.coerce.number().int().min(1).optional(),
  })
  .strict();

export const eventPrizeIdSchema = z.string().uuid();

/**
 * Reorder input.
 *
 * Deliberately has NO `expectedEventRevision`: reordering prizes does not
 * change the event, so guarding it on the event's revision would make an
 * unrelated event edit spuriously invalidate a pending reorder. Each prize
 * carries its own revision instead.
 *
 * The refinements enforce that the payload is internally coherent before it
 * reaches the database: no repeated prize, no repeated position.
 */
export const reorderEventPrizesSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            prizeId: z.string().uuid(),
            expectedRevision: z.coerce.number().int().min(1),
            sortOrder: z.coerce.number().int().min(0).max(PRIZE_SORT_ORDER_MAX),
          })
          .strict(),
      )
      .min(1)
      .max(PRIZES_PER_EVENT_MAX),
  })
  .strict()
  .refine(
    (value) => new Set(value.items.map((item) => item.prizeId)).size === value.items.length,
    { message: 'duplicate_prize' },
  )
  .refine(
    (value) => new Set(value.items.map((item) => item.sortOrder)).size === value.items.length,
    { message: 'duplicate_sort_order' },
  );

export const eventPrizeListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
    status: z.enum(PRIZE_STATUSES).nullable().default(null),
    archived: z.enum(['active', 'archived', 'all']).default('active'),
    search: z.string().trim().max(120).nullable().default(null),
    sort: z
      .enum(['sortOrder', 'name', 'quantity', 'createdAt', 'updatedAt'])
      .default('sortOrder'),
    direction: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Registration forms
//
// `.strict()` throughout: it is what refuses `ownerId`, `revision`, `id` and
// every actor or timestamp column, so a question cannot be re-homed onto
// another event's form by adding a key to the body.
// ---------------------------------------------------------------------------

/**
 * An answer key. Lowercase snake_case, starting with a letter, so it survives
 * an export header, a JSON key and a column name unchanged. The same shape is
 * enforced by a GLOB CHECK on the column.
 */
export const formQuestionKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(FORM_QUESTION_KEY_MAX_LENGTH)
  .regex(/^[a-z][a-z0-9_]*$/, 'invalid_key')
  // An answer set is a plain object keyed by these; three names do not behave
  // like ordinary keys on one. See RESERVED_QUESTION_KEYS.
  .refine((value) => !isReservedQuestionKey(value), { message: 'reserved_key' });

export const formOptionValueSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(FORM_OPTION_VALUE_MAX_LENGTH)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'invalid_option_value');

const formStepTitleField = z.string().trim().min(1).max(FORM_STEP_TITLE_MAX_LENGTH);
const formStepDescriptionField = z
  .string()
  .trim()
  .max(FORM_STEP_DESCRIPTION_MAX_LENGTH)
  .nullable();

const formQuestionLabelField = z.string().trim().min(1).max(FORM_QUESTION_LABEL_MAX_LENGTH);
const formQuestionDescriptionField = z
  .string()
  .trim()
  .max(FORM_QUESTION_DESCRIPTION_MAX_LENGTH)
  .nullable();
const formQuestionPlaceholderField = z
  .string()
  .trim()
  .max(FORM_QUESTION_PLACEHOLDER_MAX_LENGTH)
  .nullable();

const boundedCount = z.coerce.number().int().min(0).max(FORM_VALIDATION_TEXT_MAX);
const boundedNumber = z.coerce
  .number()
  .min(FORM_VALIDATION_NUMBER_MIN)
  .max(FORM_VALIDATION_NUMBER_MAX);

/**
 * Per-type answer constraints.
 *
 * Every key is optional; which ones MEAN anything depends on the question's
 * type, and the service refuses the ones that do not belong. There is
 * deliberately no `pattern`: a client-supplied regular expression would be
 * evaluated against every submission, which is a denial-of-service waiting for
 * a later phase to inherit.
 */
export const formQuestionValidationSchema = z
  .object({
    minLength: boundedCount.optional(),
    maxLength: boundedCount.optional(),
    min: boundedNumber.optional(),
    max: boundedNumber.optional(),
    integerOnly: z.boolean().optional(),
    minDate: isoTimestamp.optional(),
    maxDate: isoTimestamp.optional(),
    minSelected: boundedCount.optional(),
    maxSelected: boundedCount.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.minLength === undefined ||
      value.maxLength === undefined ||
      value.minLength <= value.maxLength,
    { message: 'invalid_length_range' },
  )
  .refine(
    (value) => value.min === undefined || value.max === undefined || value.min <= value.max,
    { message: 'invalid_number_range' },
  )
  .refine(
    (value) =>
      value.minDate === undefined ||
      value.maxDate === undefined ||
      value.minDate <= value.maxDate,
    { message: 'invalid_date_range' },
  )
  .refine(
    (value) =>
      value.minSelected === undefined ||
      value.maxSelected === undefined ||
      value.minSelected <= value.maxSelected,
    { message: 'invalid_selection_range' },
  );

/** Guards every mutation on the whole form; see `event_form_drafts.revision`. */
const expectedFormRevision = z.coerce.number().int().min(1);

export const createFormStepSchema = z
  .object({
    expectedRevision: expectedFormRevision,
    title: formStepTitleField,
    description: formStepDescriptionField.optional(),
  })
  .strict();

export const updateFormStepSchema = z
  .object({
    expectedRevision: expectedFormRevision,
    title: formStepTitleField.optional(),
    description: formStepDescriptionField.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedRevision'), {
    message: 'empty_patch',
  });

export const deleteFormEntitySchema = z
  .object({ expectedRevision: expectedFormRevision })
  .strict();

/** An explicit checkpoint carries nothing but the revision it saw. */
export const updateFormDraftSchema = deleteFormEntitySchema;

export const createFormQuestionSchema = z
  .object({
    expectedRevision: expectedFormRevision,
    stepId: z.string().uuid(),
    type: z.enum(FORM_QUESTION_TYPES),
    label: formQuestionLabelField,
    key: formQuestionKeySchema.optional(),
    systemField: z.enum(FORM_SYSTEM_FIELDS).optional(),
    description: formQuestionDescriptionField.optional(),
    placeholder: formQuestionPlaceholderField.optional(),
    required: z.boolean().optional(),
    active: z.boolean().optional(),
    exportable: z.boolean().optional(),
    validation: formQuestionValidationSchema.nullable().optional(),
    // Creating a select together with its choices is one operation, so the
    // builder never leaves a half-configured question behind.
    options: z
      .array(
        z
          .object({ value: formOptionValueSchema, label: z.string().trim().min(1).max(FORM_OPTION_LABEL_MAX_LENGTH) })
          .strict(),
      )
      .max(FORM_OPTIONS_PER_QUESTION_MAX)
      .optional(),
  })
  .strict();

export const updateFormQuestionSchema = z
  .object({
    expectedRevision: expectedFormRevision,
    label: formQuestionLabelField.optional(),
    key: formQuestionKeySchema.optional(),
    type: z.enum(FORM_QUESTION_TYPES).optional(),
    description: formQuestionDescriptionField.optional(),
    placeholder: formQuestionPlaceholderField.optional(),
    required: z.boolean().optional(),
    active: z.boolean().optional(),
    exportable: z.boolean().optional(),
    validation: formQuestionValidationSchema.nullable().optional(),
    stepId: z.string().uuid().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedRevision'), {
    message: 'empty_patch',
  });

export const createFormOptionSchema = z
  .object({
    expectedRevision: expectedFormRevision,
    value: formOptionValueSchema,
    label: z.string().trim().min(1).max(FORM_OPTION_LABEL_MAX_LENGTH),
    active: z.boolean().optional(),
  })
  .strict();

export const updateFormOptionSchema = z
  .object({
    expectedRevision: expectedFormRevision,
    value: formOptionValueSchema.optional(),
    label: z.string().trim().min(1).max(FORM_OPTION_LABEL_MAX_LENGTH).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== 'expectedRevision'), {
    message: 'empty_patch',
  });

/**
 * A reorder. Like the prize reorder, the payload must be internally coherent —
 * no repeated id, no repeated position — before it reaches the database.
 */
function reorderItems(max: number) {
  return z
    .array(
      z
        .object({
          id: z.string().uuid(),
          sortOrder: z.coerce.number().int().min(0).max(FORM_SORT_ORDER_MAX),
        })
        .strict(),
    )
    .min(1)
    .max(max);
}

const coherentOrder = <T extends { items: Array<{ id: string; sortOrder: number }> }>(
  schema: z.ZodType<T>,
) =>
  schema
    .refine((value) => new Set(value.items.map((i) => i.id)).size === value.items.length, {
      message: 'duplicate_id',
    })
    .refine(
      (value) => new Set(value.items.map((i) => i.sortOrder)).size === value.items.length,
      { message: 'duplicate_sort_order' },
    );

export const reorderFormStepsSchema = coherentOrder(
  z
    .object({
      expectedRevision: expectedFormRevision,
      items: reorderItems(FORM_STEPS_MAX),
    })
    .strict(),
);

export const reorderFormQuestionsSchema = coherentOrder(
  z
    .object({
      expectedRevision: expectedFormRevision,
      // The ordering belongs to a step: a question list is only meaningful
      // inside the page it appears on.
      stepId: z.string().uuid(),
      items: reorderItems(FORM_QUESTIONS_MAX),
    })
    .strict(),
);

export const reorderFormOptionsSchema = coherentOrder(
  z
    .object({
      expectedRevision: expectedFormRevision,
      items: reorderItems(FORM_OPTIONS_PER_QUESTION_MAX),
    })
    .strict(),
);

// ---------------------------------------------------------------------------
// Publishing
//
// The publish payload carries a REVISION and nothing else. The server reads the
// draft it already stores, so a whole form never travels back across the wire
// to be published — which removes both a large payload and the chance of
// publishing something other than what is on the server.
// ---------------------------------------------------------------------------

export const publishFormSchema = z
  .object({ expectedDraftRevision: z.coerce.number().int().min(1) })
  .strict();

export const validatePublishSchema = z
  .object({ expectedDraftRevision: z.coerce.number().int().min(1).optional() })
  .strict();

export const formVersionIdSchema = z.string().uuid();

export const formVersionListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
  })
  .strict();

// ---------------------------------------------------------------------------
// Participants and entries
//
// The transport shape only. What an answer MEANS — whether "42" is a valid
// answer to this number question, whether that option is still active — is
// decided against the published version in `shared/formAnswers.ts`, because a
// schema cannot know which form is being filled in.
//
// `.strict()` throughout, and deliberately narrow: there is no `participantId`,
// no `formVersionId`, no `status`, no `submittedAt`, no `ipHash`, no
// `questionKey` and no `answerType`. Every one of those is resolved by the
// server, so adding a key to the body cannot decide who entered, which form
// they entered with, or what their answer was called.
// ---------------------------------------------------------------------------

/**
 * One answer as it travels.
 *
 * `value` is `unknown` on purpose: its acceptable shape depends on the type of
 * the question it answers, which lives in the version. Bounding it here would
 * either be wrong for some type or so loose it says nothing — so the schema
 * bounds the ENVELOPE (a uuid and one value) and the domain bounds the value.
 *
 * `null` is accepted and means "not answered", which is how a client clears a
 * field it previously filled in without inventing a second representation.
 */
export const formAnswerInputSchema = z
  .object({
    questionId: z.string().uuid(),
    value: z.unknown(),
  })
  .strict()
  // Normalises "the key was absent" and "the key was null" into one shape, so
  // the domain layer has a single notion of "not answered" instead of two that
  // have to be kept in step.
  .transform((answer) => ({
    questionId: answer.questionId,
    value: answer.value === undefined ? null : answer.value,
  }));

export const createEventEntrySchema = z
  .object({
    answers: z
      .array(formAnswerInputSchema)
      // Bounding the ARRAY, not only the rows: a submission with a hundred
      // thousand answers must be refused before any of them is looked at.
      .max(ANSWERS_PER_ENTRY_MAX)
      .default([]),
  })
  .strict();

export type CreateEventEntrySchemaInput = z.infer<typeof createEventEntrySchema>;

/**
 * A public submission.
 *
 * `.strict()` is the mass-assignment defence and is not decoration: it is what
 * makes `participantId`, `formVersionId`, `status`, `calculatedAge`,
 * `overallEligible`, `submittedAt`, `ipHash` and every other server-owned field
 * a REJECTION rather than a silently ignored extra key. The three keys below
 * are the entire public write surface.
 *
 * The token is length-bounded here as well as inside the verifier, so an
 * oversized value is refused by the schema before any crypto is attempted.
 */
export const publicSubmissionSchema = z
  .object({
    formToken: z.string().min(1).max(PUBLIC_FORM_TOKEN_MAX_BYTES),
    // A UUID, not free text: the key is an idempotency handle the client mints
    // with `crypto.randomUUID()`, and accepting an arbitrary string would let a
    // caller choose a colliding or unbounded one.
    submissionId: z.string().uuid(),
    answers: z.array(formAnswerInputSchema).max(ANSWERS_PER_ENTRY_MAX).default([]),
  })
  .strict();

export type PublicSubmissionSchemaInput = z.infer<typeof publicSubmissionSchema>;

export const eventEntryIdSchema = z.string().uuid();

/**
 * Removing a participation from consideration.
 *
 * `.strict()` is the mass-assignment defence: `status`, `preDisqualificationStatus`,
 * `disqualifiedAt`, `disqualifiedByAdminId`, `revision` and every other
 * server-owned field are a REJECTION rather than a silently ignored extra key.
 * The actor comes from the session, the timestamp from the server, and the
 * previous status from the row itself — none of them from the caller.
 *
 * The reason is trimmed BEFORE it is bounded, so leading whitespace cannot be
 * used to satisfy a minimum length with nothing in it.
 */
export const disqualifyEntrySchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    reason: z
      .string()
      .trim()
      .min(DISQUALIFICATION_REASON_MIN_LENGTH)
      .max(DISQUALIFICATION_REASON_MAX_LENGTH),
  })
  .strict();

/**
 * Putting one back.
 *
 * No reason: the destination is not a decision the caller makes, it is the
 * status the entry recorded before it was disqualified. Accepting a target
 * status here would let a caller promote an entry that never qualified.
 */
export const reinstateEntrySchema = z
  .object({ expectedRevision: z.number().int().min(1) })
  .strict();

export const adminParticipantListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
    search: z.string().trim().max(SEARCH_MAX_LENGTH).optional(),
    eligibility: z.enum(PARTICIPANT_ELIGIBILITY_FILTERS).default('ALL'),
    status: z.enum(PARTICIPANT_STATUS_FILTERS).default('ALL'),
    formVersionId: z.string().uuid().optional(),
  })
  .strict();

export type DisqualifyEntrySchemaInput = z.infer<typeof disqualifyEntrySchema>;
export type ReinstateEntrySchemaInput = z.infer<typeof reinstateEntrySchema>;

export const eventEntryListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
    search: z.string().trim().max(SEARCH_MAX_LENGTH).optional(),
  })
  .strict();

export const raffleDrawSchema = z.union([
  z.object({ mode: z.literal('random') }),
  z.object({
    mode: z.literal('manual'),
    participantNumber: z.coerce.number().int().positive(),
  }),
]);

// ---------------------------------------------------------------------------
// The draw (phase 11)
// ---------------------------------------------------------------------------

/**
 * Running the draw.
 *
 * EMPTY, AND STRICT, AND BOTH HALVES MATTER.
 *
 * Empty because there is nothing legitimate for a caller to say. The candidates
 * come from the certified predicate, the prizes from the event's own
 * configuration, the winners from a server-side CSPRNG, the actor from the
 * session and the moment from the server clock. A draw takes no parameters
 * because none of its inputs belong to whoever pressed the button.
 *
 * Strict because that is what turns "we ignore what you sent" into "we refuse
 * it". `seed`, `candidates`, `winners`, `entryId`, `prizeId`, `count` and
 * anything else a caller might try are a REJECTION rather than a silently
 * dropped extra key — and a rejection is visible in a test, in a log and to
 * whoever tried.
 *
 * Deliberately NOT `raffleDrawSchema`, which belongs to the legacy attendee
 * raffle and accepts a manual participant number. That mode has no place here:
 * choosing the winner is exactly what this endpoint must not let anyone do.
 */
export const runDrawSchema = z.object({}).strict();

export type RunDrawSchemaInput = z.infer<typeof runDrawSchema>;

/**
 * Publishing results.
 *
 * EMPTY, AND STRICT, for the same reasons the draw's schema is. There is
 * nothing legitimate for a caller to say: the winners come from the draw, their
 * public names from `formatPublicWinnerName`, the prizes from the assignment
 * snapshots, the actor from the session and the instant from the server clock.
 *
 * Strict is what turns "we ignore what you sent" into "we refuse it".
 * `drawId`, `winnerNames`, `displayNames`, `assignmentIds`, `winnerCount`,
 * `publishedAt` and `publishedBy` are a REJECTION rather than a silently
 * dropped key — and a rejection is visible in a test, in a log, and to whoever
 * tried to name their own winners.
 */
export const publishResultsSchema = z.object({}).strict();

export type PublishResultsSchemaInput = z.infer<typeof publishResultsSchema>;

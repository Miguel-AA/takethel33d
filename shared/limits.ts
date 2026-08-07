// Central size and length limits.
//
// Every bound the system enforces lives here, so a value is never a magic
// number sitting inline in a validator, a repository and a migration that then
// drift apart. Schemas, SQL CHECK constraints and payload guards all read from
// this file.
//
// This module deliberately has NO imports: `scripts/bootstrap-admin.ts` runs
// under plain Node (whose ESM resolver needs explicit extensions), and keeping
// the shared leaves dependency-free keeps that graph simple.

// --- Identity -------------------------------------------------------------
export const EMAIL_MAX_LENGTH = 160;
export const DISPLAY_NAME_MAX_LENGTH = 120;
export const ADMIN_PASSWORD_MIN_LENGTH = 12;
export const ADMIN_PASSWORD_MAX_LENGTH = 200;

/** A UUID v4 in canonical hyphenated form. */
export const ID_LENGTH = 36;

// --- Audit ----------------------------------------------------------------
export const AUDIT_ACTION_MAX_LENGTH = 64;
/**
 * Ceiling for `entity_id` / `event_id`. These normally hold a 36-character
 * UUID; the allowance covers other natural keys without letting an unbounded
 * string be written into an append-only table.
 */
export const AUDIT_ENTITY_ID_MAX_LENGTH = 200;
export const AUDIT_ENTITY_TYPE_MAX_LENGTH = 48;
export const AUDIT_REASON_MAX_LENGTH = 200;
export const USER_AGENT_MAX_LENGTH = 512;
export const REQUEST_ID_MAX_LENGTH = 64;

/**
 * Ceiling for a single serialized JSON column (`previous_data`, `new_data`,
 * `metadata`). Large enough for a realistic entity snapshot, small enough that
 * a hostile payload cannot bloat the audit table.
 */
export const JSON_COLUMN_MAX_BYTES = 64 * 1024;

// --- Events ---------------------------------------------------------------
export const EVENT_NAME_MAX_LENGTH = 160;
export const EVENT_DESCRIPTION_MAX_LENGTH = 4000;
export const EVENT_LOCATION_MAX_LENGTH = 200;
export const EVENT_BANNER_URL_MAX_LENGTH = 2048;
export const EVENT_MESSAGE_TITLE_MAX_LENGTH = 160;
export const EVENT_MESSAGE_BODY_MAX_LENGTH = 2000;
export const EVENT_MIN_AGE_MIN = 0;
export const EVENT_MIN_AGE_MAX = 130;
export const EVENT_MAX_ENTRIES_MIN = 1;
export const EVENT_MAX_ENTRIES_MAX = 1000;

// --- Prizes ---------------------------------------------------------------
export const PRIZE_NAME_MAX_LENGTH = 120;
export const PRIZE_DESCRIPTION_MAX_LENGTH = 2000;
export const PRIZE_IMAGE_URL_MAX_LENGTH = 2048;
export const PRIZE_QUANTITY_MIN = 1;
export const PRIZE_QUANTITY_MAX = 1000;
/** Ceiling on prizes per event; also bounds the reorder payload. */
export const PRIZES_PER_EVENT_MAX = 100;
export const PRIZE_SORT_ORDER_MAX = 10_000;

/**
 * Where a reorder parks positions mid-batch.
 *
 * The partial UNIQUE index on (event_id, sort_order) is enforced per statement,
 * so a swap needs somewhere collision-free to stage. This offset is far above
 * any position a real event can reach (bounded by PRIZES_PER_EVENT_MAX) and
 * still satisfies `sort_order >= 0`.
 */
export const PRIZE_SORT_PARK_OFFSET = 1_000_000;

// --- Forms ----------------------------------------------------------------
export const FORM_STEP_TITLE_MAX_LENGTH = 160;
export const FORM_STEP_DESCRIPTION_MAX_LENGTH = 2000;
export const FORM_QUESTION_KEY_MAX_LENGTH = 64;
export const FORM_QUESTION_LABEL_MAX_LENGTH = 300;
export const FORM_QUESTION_DESCRIPTION_MAX_LENGTH = 2000;
export const FORM_QUESTION_PLACEHOLDER_MAX_LENGTH = 160;
export const FORM_OPTION_VALUE_MAX_LENGTH = 64;
export const FORM_OPTION_LABEL_MAX_LENGTH = 200;

/** Ceilings per form. Also bound each reorder payload. */
export const FORM_STEPS_MAX = 20;
export const FORM_QUESTIONS_MAX = 200;
export const FORM_OPTIONS_PER_QUESTION_MAX = 100;

/**
 * Positions and the range a reorder stages in, exactly as prizes do: the
 * partial unique index is checked per statement, so a swap needs somewhere
 * collision-free to park. The offset sits far above any reachable position.
 * See FormRepository.reorderStatements.
 */
export const FORM_SORT_ORDER_MAX = 10_000;
export const FORM_SORT_PARK_OFFSET = 1_000_000;
/** Ceiling the column's CHECK carries: the parking range and nothing beyond. */
export const FORM_SORT_ORDER_CEILING = FORM_SORT_PARK_OFFSET + FORM_QUESTIONS_MAX;

/**
 * Bounds a question's numeric validation, so a configured `max` cannot be an
 * unbounded value the public renderer would later have to trust.
 */
export const FORM_VALIDATION_NUMBER_MIN = -1_000_000_000;
export const FORM_VALIDATION_NUMBER_MAX = 1_000_000_000;
/** Ceiling for a configured text length; independent of the answer's storage. */
export const FORM_VALIDATION_TEXT_MAX = 10_000;

// --- Participants and entries ---------------------------------------------
export const PARTICIPANT_NAME_MAX_LENGTH = 80;
export const PARTICIPANT_PHONE_MIN_LENGTH = 7;
export const PARTICIPANT_PHONE_MAX_LENGTH = 20;
export const PARTICIPANT_EMAIL_MAX_LENGTH = EMAIL_MAX_LENGTH;

/**
 * Ceiling on a single stored answer, serialized.
 *
 * Generous for a long-text reply, small enough that a hostile submission cannot
 * turn one row into a megabyte. The column CHECK carries the same number.
 */
export const ANSWER_VALUE_MAX_BYTES = 8000;

/**
 * Ceiling on a single free-text answer, before serialization.
 *
 * Below `ANSWER_VALUE_MAX_BYTES` so that escaping (quotes, newlines, non-ASCII)
 * cannot push a legitimate answer over the storage limit.
 */
export const ANSWER_TEXT_MAX_LENGTH = 4000;

/**
 * How many answers one submission may carry.
 *
 * A form holds at most `FORM_QUESTIONS_MAX` questions, and a question produces
 * at most one answer — so anything beyond that is not a form being filled in.
 * Bounding the ARRAY (not just the rows) is what stops a payload of a hundred
 * thousand answers from being validated one by one before being refused.
 */
export const ANSWERS_PER_ENTRY_MAX = FORM_QUESTIONS_MAX;

/** Ceiling on one multi-select answer; a question cannot offer more than this. */
export const ANSWER_SELECTIONS_MAX = FORM_OPTIONS_PER_QUESTION_MAX;

/** Bounds a numeric answer, matching the range a question may configure. */
export const ANSWER_NUMBER_MIN = FORM_VALIDATION_NUMBER_MIN;
export const ANSWER_NUMBER_MAX = FORM_VALIDATION_NUMBER_MAX;

/** Ceiling for a stored eligibility explanation (written by a later phase). */
export const ENTRY_ELIGIBILITY_REASON_MAX_LENGTH = 200;

// --- Query / pagination ---------------------------------------------------
export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 200;
export const PAGE_SIZE_MIN = 1;
export const SEARCH_MAX_LENGTH = 120;

// --- Request payloads -----------------------------------------------------
/** Credentials are tiny; a login body has no business being large. */
export const PAYLOAD_LIMIT_AUTH_BYTES = 16 * 1024;
/** General administrative JSON endpoints. */
export const PAYLOAD_LIMIT_ADMIN_BYTES = 128 * 1024;
/** Reserved for the public form flow introduced in a later phase. */
export const PAYLOAD_LIMIT_PUBLIC_FORM_BYTES = 256 * 1024;

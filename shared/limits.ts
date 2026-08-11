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

/**
 * Bounds on the reason an administrator gives for a disqualification.
 *
 * A minimum, not just a maximum: "removing somebody from consideration" is a
 * decision that has to be explainable to the person it affects, and a single
 * character is not an explanation. The ceiling matches the column's trigger, so
 * the schema and the storage layer cannot disagree about what fits.
 */
export const DISQUALIFICATION_REASON_MIN_LENGTH = 3;
export const DISQUALIFICATION_REASON_MAX_LENGTH = 500;

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
/** The public submission endpoint: a filled-in form and nothing else. */
export const PAYLOAD_LIMIT_PUBLIC_FORM_BYTES = 256 * 1024;

// --- Public form session token --------------------------------------------
//
// The token binds a submission to the EXACT form version the participant was
// shown. Every bound lives here so the issuer, the verifier and their tests
// read one number rather than three that drift.

/**
 * How long a rendered form stays submittable: two hours.
 *
 * Long enough that somebody can genuinely fill in a multi-step form, take a
 * call and come back. Short enough that a token scraped from a page is not a
 * permanent licence to submit against a version the organiser has moved on
 * from.
 */
export const PUBLIC_FORM_TOKEN_TTL_SECONDS = 7200;

/**
 * How far ahead of the verifier's clock an `issuedAt` may sit.
 *
 * Not a courtesy: Cloudflare serves from many machines and their clocks agree
 * only to within a small drift, so a token minted a moment ago can legitimately
 * carry a timestamp fractionally in the verifier's future. Without this a user
 * would see a form and be refused the instant they submitted it. Bounded to one
 * minute so it cannot be used to extend the TTL.
 */
export const PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS = 60;

/**
 * Ceiling on the encoded token, applied BEFORE any decoding.
 *
 * The payload is two UUIDs, an integer and a short nonce — roughly 160 bytes
 * encoded. 1024 is a generous multiple of that and still refuses a megabyte of
 * base64 arriving as a denial-of-service against the decoder, which is why the
 * check has to come first rather than after a split.
 */
export const PUBLIC_FORM_TOKEN_MAX_BYTES = 1024;

/** Bytes of CSPRNG behind the token's nonce. */
export const PUBLIC_FORM_TOKEN_NONCE_BYTES = 12;

// --- Public rate limiting --------------------------------------------------
//
// Deliberately NOT the login thresholds. A failed login is a credential guess;
// a public GET is somebody reading a page. Sharing the numbers would either
// make the public flow unusable or make the login flow permissive.

/** Reading an event page: generous, since a visitor may reload and navigate. */
export const PUBLIC_GET_RATE_WINDOW_MS = 60 * 1000;
export const PUBLIC_GET_RATE_MAX = 120;

/** Submitting from one address. A person submits once; a script does not. */
export const PUBLIC_ENTRY_IP_RATE_WINDOW_MS = 10 * 60 * 1000;
export const PUBLIC_ENTRY_IP_RATE_MAX = 5;

/**
 * One address attempting ONE identity.
 *
 * The tight control, and the one that does the real work: an attacker probing
 * whether a given address is registered is exactly this bucket. Kept above 1 so
 * a genuine correction — a typo in a date of birth, a retried network failure —
 * is not punished.
 */
export const PUBLIC_ENTRY_IP_EMAIL_RATE_WINDOW_MS = 10 * 60 * 1000;
export const PUBLIC_ENTRY_IP_EMAIL_RATE_MAX = 3;

/**
 * Backstop across every address for one identity.
 *
 * DELIBERATELY GENEROUS. This bucket is the one an attacker could weaponise:
 * knowing a victim's email, they could burn it from many IPs and lock the
 * victim out of registering at all. Twenty an hour is far above anything a real
 * person does and far below a useful enumeration rate, and the fine-grained
 * refusal is meant to come from the IP+email bucket long before this one fires.
 */
export const PUBLIC_ENTRY_EMAIL_RATE_WINDOW_MS = 60 * 60 * 1000;
export const PUBLIC_ENTRY_EMAIL_RATE_MAX = 20;

// --- The draw -------------------------------------------------------------

/**
 * The most assignments one draw may commit.
 *
 * A draw writes one row per winner, and all of them commit in a single
 * transaction alongside the draw row, the audit entry and the event's
 * transition. That is the whole atomicity guarantee, and it is only a guarantee
 * while the batch is a size a single transaction can actually carry.
 *
 * The configuration limits alone allow far more than that — `PRIZES_PER_EVENT_MAX`
 * prizes at `PRIZE_QUANTITY_MAX` units each is a hundred thousand units — so
 * this ceiling exists to REFUSE such a draw cleanly rather than attempt it and
 * fail somewhere inside the commit. No realistic event approaches it: a
 * thousand winners in one draw is already two orders of magnitude beyond what
 * this system is for.
 *
 * Refusing is the safe direction. A draw that cannot be committed atomically
 * must not be committed at all.
 */
export const DRAW_ASSIGNMENTS_MAX = 1000;

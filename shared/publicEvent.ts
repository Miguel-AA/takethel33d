// The public projection of an event.
//
// SHARED so the backend, the dev mock and the public UI read ONE table. The
// server remains the authority — nothing here decides eligibility, and nothing
// here is persisted — but the status a visitor is shown and the status the API
// computes must be the same function of the same inputs, or the page will
// promise a form the POST refuses.
//
// TWO RULES GOVERN THIS FILE.
//
//   1. NOTHING DERIVED HERE IS STORED. `events.status` is the administrative
//      state machine and stays exactly as phase 3 defined it. The public status
//      is a VIEW over that column plus the registration window plus whether a
//      usable form exists. Persisting it would create a second source of truth
//      that drifts the moment a date passes.
//
//   2. THE PROJECTION IS A ALLOW-LIST, NEVER A DELETE-LIST. Every DTO below
//      names the fields it copies. A field added to `Event` tomorrow is
//      therefore invisible to the public by default — which is the only way a
//      projection stays safe as the domain grows.

import type { EventStatus } from './eventLifecycle.ts';
import type {
  Event,
  EventPrize,
  FormQuestion,
  FormQuestionValidation,
  FormStep,
} from './types.ts';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * What a visitor is told about an event.
 *
 * Deliberately COARSER than `EventStatus`. `DRAW_READY` and `DRAW_COMPLETED`
 * are operational detail that means nothing to a participant and would leak the
 * organiser's timetable; both read as CLOSED. `DRAFT` and `ARCHIVED` are not
 * represented at all, because an event in either state has no public page —
 * see `publicVisibility`.
 *
 * `UNAVAILABLE` is the honest answer for "this event should be open but its
 * published form cannot be served". It is not an error the visitor caused, and
 * it must not be disguised as CLOSED: closed means "you are too late", and
 * telling somebody that when the truth is "we are broken" is a lie that also
 * hides the fault from whoever could fix it.
 */
export const PUBLIC_EVENT_STATUSES = [
  'UPCOMING',
  'OPEN',
  'CLOSED',
  'CANCELLED',
  'UNAVAILABLE',
] as const;

export type PublicEventStatus = (typeof PUBLIC_EVENT_STATUSES)[number];

/**
 * Whether an event has a public page at all.
 *
 * `hidden` produces a 404 — the same answer as a slug that was never used. A
 * DRAFT is an event an operator is still writing, and confirming that its slug
 * exists would leak both the plan and the name before anybody meant to announce
 * it. An ARCHIVED event has been filed away deliberately.
 *
 * This is why the caller must not branch on `event.status` itself: the decision
 * "is there a page here?" and the decision "what does the page say?" are
 * different questions, and collapsing them is how a draft ends up served.
 */
export type PublicVisibility = 'visible' | 'hidden';

const HIDDEN_STATUSES: readonly EventStatus[] = ['DRAFT', 'ARCHIVED'];

export function publicVisibility(status: EventStatus): PublicVisibility {
  return HIDDEN_STATUSES.includes(status) ? 'hidden' : 'visible';
}

/** The registration contract an event offers, as the public projection reads it. */
export interface PublicStatusInput {
  status: EventStatus;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  /**
   * Whether a published VERSION exists AND is servable.
   *
   * Passed in rather than read off the event, because "the pointer is set" and
   * "the version behind it is this event's and has questions" are different
   * facts, and only the repository can tell them apart.
   */
  hasServableForm: boolean;
}

/**
 * The status a visitor is shown, at ONE instant.
 *
 * `nowIso` is passed in and never read from the clock here, so a page, the
 * token it carries and the submission it produces can all be reasoned about
 * from the same moment. Comparisons are string comparisons: both stored
 * timestamps are canonical fixed-width ISO, so lexicographic order IS
 * chronological order and no `Date` arithmetic is involved.
 *
 * The window boundaries match `entryWindowProblem` exactly — `opens <= now <
 * closes` — because a page that says OPEN while the POST guard says
 * REGISTRATION_CLOSED is a page that invites somebody to fail.
 */
export function derivePublicEventStatus(
  event: PublicStatusInput,
  nowIso: string,
): PublicEventStatus {
  if (event.status === 'CANCELLED') return 'CANCELLED';

  // Everything at or past CLOSED reads the same way to a participant.
  if (event.status !== 'OPEN' && event.status !== 'SCHEDULED') return 'CLOSED';

  if (event.status === 'SCHEDULED') return 'UPCOMING';

  // OPEN: the window still decides, and it can put the event on either side.
  if (event.registrationOpensAt !== null && nowIso < event.registrationOpensAt) {
    return 'UPCOMING';
  }
  if (event.registrationClosesAt !== null && nowIso >= event.registrationClosesAt) {
    return 'CLOSED';
  }

  // Genuinely open — but only if there is something to fill in. Announcing a
  // form that cannot be loaded would send people to a door with nothing behind
  // it, which is exactly what `pointerCondition` exists to detect.
  return event.hasServableForm ? 'OPEN' : 'UNAVAILABLE';
}

/** True only when the public flow may accept a submission. */
export function publicStatusAcceptsEntries(status: PublicEventStatus): boolean {
  return status === 'OPEN';
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

/**
 * One question, as a participant meets it.
 *
 * `id` is present because the submission is keyed by question id — the caller
 * must be able to name what it answered. `key` and `systemField` are present
 * because the RENDERER needs them: `systemField` drives autocomplete and input
 * mode, and neither is a secret (both are chosen by the operator and are
 * visible in the form the visitor is already looking at).
 *
 * ABSENT on purpose: `ownerType` and `ownerId` (they would disclose that this
 * is a VERSION and which one), `active` (an inactive question is not sent at
 * all), `exportable` (an internal reporting flag), and the timestamps.
 */
export interface PublicQuestionDTO {
  id: string;
  key: string;
  systemField: import('./formLifecycle.ts').FormSystemField;
  type: import('./formLifecycle.ts').FormQuestionType;
  label: string;
  description: string | null;
  placeholder: string | null;
  required: boolean;
  sortOrder: number;
  validation: FormQuestionValidation | null;
  options: Array<{ value: string; label: string }>;
}

export interface PublicFormStepDTO {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  questions: PublicQuestionDTO[];
}

export interface PublicFormDTO {
  /** Human-facing only; the version ID travels signed, never in the clear. */
  versionNumber: number;
  steps: PublicFormStepDTO[];
}

export interface PublicPrizeDTO {
  name: string;
  description: string | null;
  imageUrl: string | null;
  quantity: number;
  sortOrder: number;
}

/** The configurable copy shown after a submission resolves. */
export interface PublicEventMessagesDTO {
  confirmationTitle: string | null;
  confirmationMessage: string | null;
  ineligibleTitle: string | null;
  ineligibleMessage: string | null;
}

/**
 * Everything a public event page is allowed to know.
 *
 * There is NO `id`. The public flow addresses an event by slug and carries the
 * event id only inside the signed token, so a scraped page yields nothing that
 * can be pasted into an administrative URL.
 */
export interface PublicEventDTO {
  slug: string;
  name: string;
  description: string | null;
  bannerUrl: string | null;
  locationName: string | null;
  timezone: string;
  registrationOpensAt: string | null;
  registrationClosesAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Informational only. The server decides eligibility; see EligibilityService. */
  minimumAge: number | null;
  registrationStatus: PublicEventStatus;
  messages: PublicEventMessagesDTO;
  /** Present only when `registrationStatus === 'OPEN'`. */
  form: PublicFormDTO | null;
  prizes: PublicPrizeDTO[];
  /** Binds a submission to the exact VERSION rendered above. Null unless OPEN. */
  formToken: string | null;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * Whether a question is offered to a participant.
 *
 * Publishing PRESERVES inactive questions (see `PUBLISH_PRESERVES_INACTIVE_QUESTIONS`),
 * so a version legitimately carries questions nobody should be asked. They are
 * dropped here and refused by `validateSubmission` on the way back in, so the
 * two halves agree.
 *
 * INFORMATION is kept: it collects nothing, but it is copy the operator wrote
 * for the participant to read, and dropping it would silently delete part of
 * the form.
 */
export function isPubliclyAskable(question: Pick<FormQuestion, 'active'>): boolean {
  return question.active;
}

export function toPublicQuestionDto(question: FormQuestion): PublicQuestionDTO {
  return {
    id: question.id,
    key: question.key,
    systemField: question.systemField,
    type: question.type,
    label: question.label,
    description: question.description,
    placeholder: question.placeholder,
    required: question.required,
    sortOrder: question.sortOrder,
    validation: question.validation,
    // Inactive OPTIONS are dropped for the same reason inactive questions are:
    // an option nobody may choose is not a choice, and `validateAnswerForQuestion`
    // refuses it anyway.
    options: question.options
      .filter((option) => option.active)
      .map((option) => ({ value: option.value, label: option.label })),
  };
}

/**
 * Why a version cannot be served publicly.
 *
 * Reported rather than swallowed. A step that has lost every active question,
 * or a form with nothing askable left in it, is a corruption of an IMMUTABLE
 * row — versions have no update path — so it means something wrote outside the
 * application. Rendering the remains would ask people to fill in a form that is
 * not the one that was published.
 */
export type PublicFormProblem = 'NO_QUESTIONS' | 'EMPTY_STEP';

export type PublicFormProjection =
  | { ok: true; form: PublicFormDTO }
  | { ok: false; problem: PublicFormProblem };

/**
 * Projects a frozen VERSION into the form a participant fills in.
 *
 * Steps and questions are ordered by `sortOrder` explicitly rather than trusted
 * to arrive ordered: the wizard's step numbering is derived from this array,
 * and a form whose pages are in load order is a different form.
 */
export function toPublicFormDto(
  versionNumber: number,
  steps: readonly FormStep[],
): PublicFormProjection {
  const projected: PublicFormStepDTO[] = [...steps]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      sortOrder: step.sortOrder,
      questions: [...step.questions]
        .filter(isPubliclyAskable)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .map(toPublicQuestionDto),
    }));

  if (projected.some((step) => step.questions.length === 0)) {
    return { ok: false, problem: 'EMPTY_STEP' };
  }
  if (projected.length === 0) {
    return { ok: false, problem: 'NO_QUESTIONS' };
  }

  return { ok: true, form: { versionNumber, steps: projected } };
}

/**
 * ACTIVE prizes only, in display order.
 *
 * INACTIVE is an operator parking a prize they are still deciding about;
 * ARCHIVED is one they withdrew. Neither is on offer, and showing either would
 * advertise something nobody can win.
 */
export function toPublicPrizeDtos(prizes: readonly EventPrize[]): PublicPrizeDTO[] {
  return prizes
    .filter((prize) => prize.status === 'ACTIVE')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    .map((prize) => ({
      name: prize.name,
      description: prize.description,
      imageUrl: prize.imageUrl,
      quantity: prize.quantity,
      sortOrder: prize.sortOrder,
    }));
}

/**
 * The event half of the projection.
 *
 * Every field is copied by NAME. Nothing is spread from `Event`, so a column
 * added later cannot leak by default — the compiler will simply not know about
 * it here.
 */
export function toPublicEventDto(input: {
  event: Event;
  registrationStatus: PublicEventStatus;
  form: PublicFormDTO | null;
  prizes: PublicPrizeDTO[];
  formToken: string | null;
}): PublicEventDTO {
  const { event } = input;
  return {
    slug: event.slug,
    name: event.name,
    description: event.description,
    bannerUrl: event.bannerUrl,
    locationName: event.locationName,
    timezone: event.timezone,
    registrationOpensAt: event.registrationOpensAt,
    registrationClosesAt: event.registrationClosesAt,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    minimumAge: event.minimumAge,
    registrationStatus: input.registrationStatus,
    messages: {
      confirmationTitle: event.confirmationTitle,
      confirmationMessage: event.confirmationMessage,
      ineligibleTitle: event.ineligibleTitle,
      ineligibleMessage: event.ineligibleMessage,
    },
    form: input.form,
    prizes: input.prizes,
    formToken: input.formToken,
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export interface PublicSubmissionInput {
  formToken: string;
  submissionId: string;
  answers: import('./formAnswers.ts').SubmittedAnswer[];
}

/**
 * What a participant is told about their own submission.
 *
 * Compare with `CreateEventEntryResponse`, which the administrative endpoint
 * returns: that carries the whole `Participant` — name, email, phone, date of
 * birth — and the whole `EventEntry` including `calculatedAge`. None of it
 * belongs in a response a browser can be pointed at.
 *
 * `calculatedAge` is absent even though the visitor supplied the date it came
 * from: echoing a derived age back turns the endpoint into a calculator that
 * confirms what the server concluded about a person, and it is not needed to
 * render either message.
 */
export interface PublicSubmissionResult {
  result: 'ELIGIBLE' | 'INELIGIBLE';
  /** Only ever a reason that is safe to state; null when eligible. */
  reason: import('./eligibility.ts').EligibilityReasonCode | null;
  message: { title: string; body: string };
}

/**
 * The public error vocabulary.
 *
 * A CLOSED set, deliberately smaller than the internal one. Several distinct
 * internal failures collapse into one member here — every way a token can be
 * wrong becomes `INVALID_FORM_SESSION`, and every way stored data can be
 * corrupt becomes `PUBLIC_EVENT_UNAVAILABLE` — because the differences are
 * exactly what an attacker would use as an oracle.
 */
export const PUBLIC_ERROR_CODES = [
  'PUBLIC_EVENT_NOT_FOUND',
  'PUBLIC_EVENT_UNAVAILABLE',
  'PUBLIC_EVENT_NOT_OPEN',
  'INVALID_FORM_SESSION',
  'ALREADY_ENTERED',
  'ENTRY_INFORMATION_CONFLICT',
  'RATE_LIMITED',
] as const;

export type PublicSafeError = (typeof PUBLIC_ERROR_CODES)[number];

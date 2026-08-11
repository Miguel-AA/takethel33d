// Publishing a result, and closing an event for good.
//
// SHARED so the backend, the dev mock and the admin UI read ONE table. "May
// this be published?", "may this be archived?" and "what will the public see
// this person called?" must give the same answer everywhere, or the preview in
// the confirmation dialog will promise a name the publication does not write.
//
// WHAT THIS FILE DOES NOT DO: choose winners. Phase 11 did that, once, and its
// result is immutable. Everything here READS a completed draw and turns it into
// two things it did not have — a public identity and a permanent record — and
// neither of those may reach back and change who won.
//
// THE ONE-WAY DOORS. Two of the transitions this file governs cannot be undone:
// a publication cannot be withdrawn and an archive cannot be reopened. That is
// not an omission to be filled in later. A withdrawn publication would mean
// somebody was publicly named a winner and then unnamed, and a reopened archive
// would mean "final" was never true. Both are absent by design, and the absence
// is enforced by there being no function here that could express them.

import type { EventStatus } from './eventLifecycle.ts';

// ---------------------------------------------------------------------------
// Publication state
// ---------------------------------------------------------------------------

/**
 * Whether an event's results have been made public.
 *
 * TWO STATES, derived from the existence of a publication row rather than
 * stored in a column of their own. A status column would be a second source of
 * truth that could disagree with the rows it describes — and the question
 * "have these results been published?" is answered perfectly by "is there a
 * publication?".
 */
export const RESULTS_PUBLICATION_STATES = ['UNPUBLISHED', 'PUBLISHED'] as const;

export type ResultsPublicationState = (typeof RESULTS_PUBLICATION_STATES)[number];

export function resultsArePublished(publication: unknown | null): boolean {
  return publication !== null && publication !== undefined;
}

export function publicationState(publication: unknown | null): ResultsPublicationState {
  return resultsArePublished(publication) ? 'PUBLISHED' : 'UNPUBLISHED';
}

/**
 * The one event state results may be published from.
 *
 * DRAW_COMPLETED and nothing else. Before it there is no result to publish;
 * after it — that is, ARCHIVED — the event has been closed for good, and
 * publishing into a closed event would mean an archive was not final after all.
 */
export const EVENT_STATUS_ALLOWING_PUBLICATION: EventStatus = 'DRAW_COMPLETED';

/** Why a publication was refused. A closed vocabulary the UI can act on. */
export const PUBLICATION_BLOCKERS = [
  'EVENT_NOT_DRAWN',
  'EVENT_ARCHIVED',
  'ALREADY_PUBLISHED',
  'NO_DRAW',
] as const;

export type PublicationBlocker = (typeof PUBLICATION_BLOCKERS)[number];

export type PublicationPermission =
  | { allowed: true }
  | { allowed: false; blocker: PublicationBlocker };

/**
 * Whether results may be published right now.
 *
 * ARCHIVED is reported SEPARATELY from "not drawn", because they are different
 * situations for the person reading: one is a state the event never reached,
 * the other is a door that has closed. Collapsing them would tell an operator
 * to wait for something that is never going to happen.
 */
export function canPublishResults(input: {
  eventStatus: EventStatus;
  hasDraw: boolean;
  hasPublication: boolean;
}): PublicationPermission {
  if (input.hasPublication) return { allowed: false, blocker: 'ALREADY_PUBLISHED' };
  if (input.eventStatus === 'ARCHIVED') return { allowed: false, blocker: 'EVENT_ARCHIVED' };
  if (input.eventStatus !== EVENT_STATUS_ALLOWING_PUBLICATION) {
    return { allowed: false, blocker: 'EVENT_NOT_DRAWN' };
  }
  // A DRAW_COMPLETED event without a draw is a state the application cannot
  // produce — the two commit together — so this is corruption rather than a
  // missing step, and it is refused rather than repaired.
  if (!input.hasDraw) return { allowed: false, blocker: 'NO_DRAW' };
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Archiving
// ---------------------------------------------------------------------------

/**
 * Whether an event may be filed away.
 *
 * A THIN WRAPPER over the existing lifecycle table, deliberately. `archive` has
 * been a real transition since phase 3, with its own sources, its own timestamp
 * column and its own audit action; phase 12 adds a screen for it, not a second
 * definition of it. The set is passed in rather than restated so the two cannot
 * drift.
 *
 * Publication is NOT a precondition. Both paths are legitimate: an operator may
 * publish and then archive, or archive without ever publishing — the second is
 * how an event whose results were never meant to be public gets closed. What is
 * not legitimate is publishing afterwards, which `canPublishResults` refuses.
 */
export function canArchiveEvent(input: {
  eventStatus: EventStatus;
  archiveSources: readonly EventStatus[];
}): boolean {
  return input.archiveSources.includes(input.eventStatus);
}

/** True once an event is closed for good. */
export function eventIsArchived(status: EventStatus): boolean {
  return status === 'ARCHIVED';
}

/**
 * Whether archiving now would close the event without ever publishing it.
 *
 * The UI warns on this, and the warning is the whole point: archiving is
 * terminal and publishing afterwards is impossible, so this is the last moment
 * anybody can choose.
 */
export function archivingWouldDiscardResults(input: {
  hasDraw: boolean;
  hasPublication: boolean;
}): boolean {
  return input.hasDraw && !input.hasPublication;
}

// ---------------------------------------------------------------------------
// Public winner identity
// ---------------------------------------------------------------------------

/**
 * How much of a winner's name the public sees.
 *
 * FIRST NAME AND LAST INITIAL. "Miguel Fuenmayor" becomes "Miguel F." — enough
 * for the person themselves, and for anybody who knows them, to recognise the
 * result; not enough to identify a stranger from a public page that will be
 * indexed and archived.
 *
 * The policy is NAMED and versioned rather than inlined, so a future change is
 * a deliberate act with a value that can be recorded, and so the tests can say
 * which policy they are asserting.
 */
export const PUBLIC_WINNER_IDENTITY_POLICY = 'FIRST_NAME_AND_LAST_INITIAL';

/**
 * The public form of a winner's name.
 *
 * DETERMINISTIC AND TOTAL over the names the schema permits: `first_name` and
 * `last_name` are both NOT NULL with a non-blank CHECK, so every stored
 * participant has something in each. Whitespace is collapsed because a name
 * typed as "Maria  Del  Barrio" is the same name, and the public snapshot
 * should not preserve a typing accident forever.
 *
 * WHAT IT DOES NOT DO IS INVENT. If either half is missing or blank — which
 * means the row was written outside the application — it returns null, and the
 * caller fails the publication closed. A publication is permanent; a placeholder
 * inside one would be permanent too.
 *
 * THE INITIAL IS THE FIRST CHARACTER OF THE LAST NAME AS WRITTEN, taken with
 * the spread operator so a surname beginning with an astral character (an emoji
 * is not a name, but a rare CJK glyph is) is not cut in half. A hyphenated or
 * multi-word surname keeps only its first letter — "Del Barrio" becomes "D.",
 * not "D. B." — because the point is one letter, not an abbreviation of the
 * whole.
 */
export function formatPublicWinnerName(participant: {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
}): string | null {
  const first = collapseWhitespace(participant.firstName);
  const last = collapseWhitespace(participant.lastName);

  if (first.length === 0 || last.length === 0) return null;

  // `[...last]` iterates by code point, so a surrogate pair survives whole.
  const initial = [...last][0];
  if (initial === undefined) return null;

  return `${first} ${initial}.`;
}

/**
 * Trims and collapses internal runs of whitespace.
 *
 * Every kind of space, not just U+0020: a name pasted from a document can carry
 * a non-breaking space or a tab, and two spellings of "Maria D." would read
 * identically and compare differently forever.
 */
function collapseWhitespace(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ');
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Why a results operation did not happen.
 *
 * Shared by the service, the API and the UI so an operator is told which of
 * these it was, rather than shown a generic failure for something they could
 * resolve.
 */
export const RESULT_FAILURE_CODES = [
  'EVENT_NOT_FOUND',
  'RESULTS_NOT_AVAILABLE',
  'RESULTS_ALREADY_PUBLISHED',
  'RESULTS_NOT_PUBLISHABLE',
  'RESULTS_CONFLICT',
] as const;

export type ResultFailureCode = (typeof RESULT_FAILURE_CODES)[number];

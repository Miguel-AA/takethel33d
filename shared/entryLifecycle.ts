// The entry domain's vocabulary and the rules about WHEN somebody may enter.
//
// SHARED so the backend, the dev mock and the admin UI read ONE table. The
// server re-validates everything regardless — and re-validates it again inside
// the transaction, because between rendering a button and committing a row an
// event can close.

import type { EventStatus } from './eventLifecycle.ts';

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * What has been decided about an entry.
 *
 *   SUBMITTED    — it exists and nothing has been judged about it yet. Every
 *                  entry starts here and, in this phase, stays here.
 *   ELIGIBLE     — it passed the event's rules.
 *   INELIGIBLE   — it did not (too young, for instance).
 *   DISQUALIFIED — an operator removed it from consideration.
 *
 * `WINNER` and `NON_WINNER` are deliberately ABSENT. They are outcomes of a
 * draw that does not exist yet, and a status nothing can currently produce is a
 * status that will be subtly wrong by the time something can.
 */
export const EVENT_ENTRY_STATUSES = [
  'SUBMITTED',
  'ELIGIBLE',
  'INELIGIBLE',
  'DISQUALIFIED',
] as const;

export type EventEntryStatus = (typeof EVENT_ENTRY_STATUSES)[number];

/** What an entry is when it is first written. Nothing else may be requested. */
export const INITIAL_ENTRY_STATUS: EventEntryStatus = 'SUBMITTED';

// ---------------------------------------------------------------------------
// When entries are accepted
// ---------------------------------------------------------------------------

/**
 * The only state in which an event takes entries.
 *
 * Not SCHEDULED: an event that has been announced but not opened is exactly the
 * state where "registration has not started" is the honest answer. Not CLOSED
 * or anything after it: those are the states where the answer is "too late".
 *
 * The administrative endpoint in this phase obeys the same rule as the public
 * flow will, so nothing has to be tightened later — tightening a rule after
 * data exists means deciding what to do with the rows that broke it.
 */
export const ENTRY_ACCEPTING_EVENT_STATUSES: readonly EventStatus[] = ['OPEN'];

export function eventAcceptsEntries(status: EventStatus): boolean {
  return ENTRY_ACCEPTING_EVENT_STATUSES.includes(status);
}

/**
 * Why an event is not accepting an entry right now.
 *
 * `null` means it is. The three reasons are distinct on purpose: "not open yet"
 * and "already closed" are different things to tell a person, and neither is
 * the same as "this event is not running".
 */
export type EntryWindowProblem = 'EVENT_NOT_OPEN' | 'REGISTRATION_NOT_STARTED' | 'REGISTRATION_CLOSED';

/**
 * Whether the registration window is open at a given instant.
 *
 * The boundary semantics are `opens <= now < closes`:
 *
 *   * the opening edge is INCLUSIVE — an event that opens at 09:00 accepts an
 *     entry at exactly 09:00, which is what the published time promises;
 *   * the closing edge is EXCLUSIVE — an event that closes at 17:00 does NOT
 *     accept an entry at exactly 17:00. "Closes at 17:00" reads as "you have
 *     until 17:00", and admitting the very instant of the deadline turns a
 *     millisecond of clock skew into an argument about whether someone made it.
 *
 * A missing opening date means "no start restriction": opening an event
 * immediately is legitimate and does not require a date to have passed. A
 * missing closing date means "no end restriction" — the event's own state is
 * then the only gate, which is why the status check is not optional.
 *
 * Both timestamps are canonical fixed-width ISO strings, so comparing them as
 * strings is comparing them chronologically. No `Date` arithmetic is involved.
 */
export function entryWindowProblem(
  event: {
    status: EventStatus;
    registrationOpensAt: string | null;
    registrationClosesAt: string | null;
  },
  nowIso: string,
): EntryWindowProblem | null {
  if (!eventAcceptsEntries(event.status)) return 'EVENT_NOT_OPEN';
  if (event.registrationOpensAt !== null && nowIso < event.registrationOpensAt) {
    return 'REGISTRATION_NOT_STARTED';
  }
  if (event.registrationClosesAt !== null && nowIso >= event.registrationClosesAt) {
    return 'REGISTRATION_CLOSED';
  }
  return null;
}

// What an administrator may do to a participation, and when.
//
// SHARED so the backend, the dev mock and the admin UI read ONE table. The
// server is the authority and re-checks everything, but a button that offers an
// action the backend will refuse is a lie to the operator, and a button that
// hides an action the backend would allow is a feature nobody can find.
//
// THE CENTRAL DISTINCTION THIS FILE EXISTS TO PROTECT:
//
//     historical eligibility  ≠  administrative disposition
//
// An entry carries a VERDICT — the age it was judged at, whether it passed, and
// why — decided at the instant it was submitted and never recomputed. That is
// history, and nothing here touches it.
//
// Disqualification is a SEPARATE, later, human decision: an operator removing
// somebody from consideration for a reason the system knows nothing about.
// Collapsing the two — by rewriting `eligibility_reason` to say "disqualified"
// — would destroy the record of what was actually decided about a person and
// make the two questions ("did they qualify?" and "did we exclude them?")
// unanswerable apart.
//
// Reinstatement therefore RESTORES the recorded previous status rather than
// re-deciding. Re-running the age rule a month later would answer a different
// question, against a different `minimum_age` and a different today, and would
// silently change what somebody was told.

import type { EventStatus } from './eventLifecycle.ts';
import type { EventEntryStatus } from './entryLifecycle.ts';

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const PARTICIPANT_ADMINISTRATIVE_ACTIONS = ['DISQUALIFY', 'REINSTATE'] as const;

export type ParticipantAdministrativeAction =
  (typeof PARTICIPANT_ADMINISTRATIVE_ACTIONS)[number];

/**
 * Event states in which the participating population may still be changed.
 *
 * OPEN and CLOSED are uncontroversial: entries are arriving, or have arrived,
 * and nothing has been decided from them yet.
 *
 * DRAW_READY IS INCLUDED, and that is a judgement worth stating. The phase 3
 * lifecycle defines DRAW_READY as "closed, and there is at least one active
 * prize" — it is a readiness flag, not a freeze: nothing in
 * `REQUIRED_TIMESTAMPS_FOR_STATUS` or `describeActions` claims the population
 * is settled, and no draw has consumed it. Discovering a cheat in the hour
 * before a draw is precisely when an operator needs this, and forcing them to
 * reopen the event to act would be worse. `mark-draw-ready` remains reversible
 * in the sense that matters: nothing has been drawn.
 *
 * DRAW_COMPLETED is excluded absolutely. A draw has read this population and
 * produced a result from it; changing the inputs afterwards would leave a
 * recorded outcome that its own data no longer explains.
 *
 * CANCELLED and ARCHIVED are read-only, and DRAFT/SCHEDULED cannot hold entries
 * at all — both are refused explicitly rather than left to be impossible by
 * accident.
 */
export const EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION: readonly EventStatus[] = [
  'OPEN',
  'CLOSED',
  'DRAW_READY',
];

export function eventAllowsParticipantAdministration(status: EventStatus): boolean {
  return EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION.includes(status);
}

/**
 * Statuses a disqualification may be undone BACK to.
 *
 * `DISQUALIFIED` is deliberately absent: a disqualified entry cannot record
 * "it was disqualified before", which would make reinstatement a no-op that
 * looked like a change and would let two disqualifications lose the original
 * verdict between them.
 */
export const REINSTATABLE_STATUSES: readonly EventEntryStatus[] = [
  'ELIGIBLE',
  'INELIGIBLE',
  'SUBMITTED',
];

export function isReinstatableStatus(status: string | null): status is EventEntryStatus {
  return status !== null && REINSTATABLE_STATUSES.includes(status as EventEntryStatus);
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

/**
 * Why an action is not offered.
 *
 * Reported as a CODE rather than a sentence so the UI can translate it and the
 * API can return it without inventing a second vocabulary.
 */
export type ParticipantActionBlocker =
  | 'EVENT_STATE_FORBIDS'
  | 'ALREADY_DISQUALIFIED'
  | 'NOT_DISQUALIFIED'
  | 'NO_RESTORABLE_STATUS';

export type ActionPermission =
  | { allowed: true }
  | { allowed: false; blocker: ParticipantActionBlocker };

export interface ParticipantAdministrativeState {
  eventStatus: EventStatus;
  entryStatus: EventEntryStatus;
  /** The status recorded when the entry was disqualified, if it is. */
  preDisqualificationStatus: EventEntryStatus | null;
}

export function canDisqualify(state: ParticipantAdministrativeState): ActionPermission {
  if (!eventAllowsParticipantAdministration(state.eventStatus)) {
    return { allowed: false, blocker: 'EVENT_STATE_FORBIDS' };
  }
  // NOT silently idempotent. Disqualifying an already-disqualified entry would
  // either overwrite the recorded previous status — losing the original verdict
  // — or quietly do nothing while reporting success. Both are worse than a
  // typed refusal.
  if (state.entryStatus === 'DISQUALIFIED') {
    return { allowed: false, blocker: 'ALREADY_DISQUALIFIED' };
  }
  return { allowed: true };
}

export function canReinstate(state: ParticipantAdministrativeState): ActionPermission {
  if (!eventAllowsParticipantAdministration(state.eventStatus)) {
    return { allowed: false, blocker: 'EVENT_STATE_FORBIDS' };
  }
  if (state.entryStatus !== 'DISQUALIFIED') {
    return { allowed: false, blocker: 'NOT_DISQUALIFIED' };
  }
  // A disqualified row with no recorded previous status cannot be reinstated
  // honestly: there is nothing to restore, and choosing one would invent a
  // verdict. Reachable only for a row written outside the application.
  if (!isReinstatableStatus(state.preDisqualificationStatus)) {
    return { allowed: false, blocker: 'NO_RESTORABLE_STATUS' };
  }
  return { allowed: true };
}

export interface DescribedActions {
  available: ParticipantAdministrativeAction[];
  blocked: Array<{
    action: ParticipantAdministrativeAction;
    blocker: ParticipantActionBlocker;
  }>;
  /** Where a reinstatement would land. Null when reinstatement is not offered. */
  reinstatesTo: EventEntryStatus | null;
}

/**
 * Everything the UI needs to render the action area, computed once.
 *
 * `reinstatesTo` is part of the answer rather than something the caller derives,
 * so a confirmation dialog can say "this entry will return to INELIGIBLE"
 * instead of implying that reinstatement means "eligible".
 */
export function describeParticipantAdministrativeActions(
  state: ParticipantAdministrativeState,
): DescribedActions {
  const available: ParticipantAdministrativeAction[] = [];
  const blocked: DescribedActions['blocked'] = [];

  const disqualify = canDisqualify(state);
  if (disqualify.allowed) available.push('DISQUALIFY');
  else blocked.push({ action: 'DISQUALIFY', blocker: disqualify.blocker });

  const reinstate = canReinstate(state);
  if (reinstate.allowed) available.push('REINSTATE');
  else blocked.push({ action: 'REINSTATE', blocker: reinstate.blocker });

  return {
    available,
    blocked,
    reinstatesTo: reinstate.allowed ? state.preDisqualificationStatus : null,
  };
}

// ---------------------------------------------------------------------------
// The draw boundary
// ---------------------------------------------------------------------------

/**
 * Whether a participation would go into a draw.
 *
 * BOTH conditions, and they are not redundant. `overallEligible` is the
 * historical verdict — did this person qualify when they entered? — and
 * `status` is the current disposition. An entry that qualified and was later
 * disqualified fails on the second; an entry that never qualified fails on the
 * first. A draw needs both to be true, and phase 11 will read exactly this.
 *
 * Stated here, in shared code, so the count an operator sees on screen and the
 * population a draw eventually takes are the same predicate rather than two
 * that agree by coincidence.
 */
export function isDrawEligible(entry: {
  status: EventEntryStatus;
  overallEligible: boolean | null;
}): boolean {
  return entry.status === 'ELIGIBLE' && entry.overallEligible === true;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * The eligibility filter.
 *
 * Filters on the HISTORICAL verdict, deliberately separate from the status
 * filter, which asks about current disposition. An operator looking for "people
 * who qualified" and an operator looking for "people currently in the running"
 * are asking different questions, and one control that blurred them would give
 * a confidently wrong answer to whichever one they meant.
 */
export const PARTICIPANT_ELIGIBILITY_FILTERS = ['ALL', 'ELIGIBLE', 'INELIGIBLE'] as const;
export type ParticipantEligibilityFilter =
  (typeof PARTICIPANT_ELIGIBILITY_FILTERS)[number];

export const PARTICIPANT_STATUS_FILTERS = [
  'ALL',
  'SUBMITTED',
  'ELIGIBLE',
  'INELIGIBLE',
  'DISQUALIFIED',
] as const;
export type ParticipantStatusFilter = (typeof PARTICIPANT_STATUS_FILTERS)[number];

/**
 * A filter on one answer.
 *
 * DECLARED, NOT IMPLEMENTED — and that is the point. Answers are rows keyed by
 * a question that differs per event, so filtering by one is a real feature with
 * a real query behind it, not something to bolt on. What matters now is that
 * the shape is stated: a question ID and a value, never a column named after a
 * question. There is no `smoker_status` anywhere in this system and there will
 * not be one; a client adding a question tomorrow must be filterable by the
 * same code as every other.
 */
export interface ParticipantAnswerFilter {
  questionId: string;
  value: string;
}

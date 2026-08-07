// How old somebody is, and whether that lets them take part.
//
// SHARED so the backend, the dev mock and (later) the public wizard read ONE
// table of rules. The SERVER is still the authority: a client may compute the
// same answer to show it, but only the server's answer is written down.
//
// TWO THINGS THIS MODULE REFUSES TO DO:
//
//   * It does not read a clock. Every function takes the instant or the civil
//     date it should reason about, so a decision can be reproduced exactly and
//     a test does not have to mock time to be honest.
//   * It does not do date ARITHMETIC. Age is a comparison of three integers,
//     never a division of milliseconds by 365 — that answer is wrong for every
//     leap year and wrong again for every DST transition.

import { assertCivilDate, civilDateInTimeZone, isCivilDate } from './civilDate.ts';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The oldest a person can plausibly be.
 *
 * A date of birth that produces more than this is not somebody very old — it is
 * a typo, a placeholder, or a `0001-01-01` that leaked out of some other
 * system. It is refused as INVALID INPUT rather than treated as an eligibility
 * outcome, because "you are 1,995 years old, so you may take part" is not a
 * decision anybody wants recorded.
 */
export const MAX_REASONABLE_AGE = 130;

/** The youngest possible age. Anything below is a date of birth in the future. */
export const MIN_REASONABLE_AGE = 0;

// ---------------------------------------------------------------------------
// The leap-day policy
// ---------------------------------------------------------------------------

/**
 * When somebody born on 29 February has their birthday in a common year.
 *
 * The policy is **1 March**, and it is a policy rather than a fact: the day
 * does not exist, so a system has to choose. Choosing 1 March means a person
 * born 2004-02-29 turns 21 on 2025-03-01 and is NOT yet 21 on 2025-02-28 —
 * which is the reading that never lets somebody be treated as older than they
 * have actually been alive.
 *
 * The alternative, 28 February, would make them a day older than the calendar
 * supports, and for an age RESTRICTION that is the direction that admits
 * somebody it should not. So the conservative choice is the correct one here.
 *
 * Expressed as a flag rather than buried in an `if`, so it is one decision in
 * one place, documented, tested, and visible to anybody who has to defend it.
 */
export const LEAP_DAY_BIRTHDAY_FALLS_ON: 'MARCH_1' | 'FEBRUARY_28' = 'MARCH_1';

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The month and day on which a birth date's anniversary falls in a given year.
 *
 * Identical to the birth date for everybody except somebody born on 29
 * February, in a year that does not have one.
 */
export function birthdayInYear(
  dateOfBirth: string,
  year: number,
): { month: number; day: number } {
  assertCivilDate(dateOfBirth, 'dateOfBirth');
  const month = Number(dateOfBirth.slice(5, 7));
  const day = Number(dateOfBirth.slice(8, 10));

  if (month === 2 && day === 29 && !isLeapYear(year)) {
    return LEAP_DAY_BIRTHDAY_FALLS_ON === 'MARCH_1'
      ? { month: 3, day: 1 }
      : { month: 2, day: 28 };
  }
  return { month, day };
}

// ---------------------------------------------------------------------------
// Age
// ---------------------------------------------------------------------------

/**
 * How old somebody born on `dateOfBirth` is on `referenceCivilDate`.
 *
 * Pure, deterministic, and independent of every clock and zone: give it the
 * same two days and it gives the same number on any machine, in any month.
 * That is what makes a stored age reproducible years later, when the only
 * evidence left is the row.
 *
 * The reference is a CIVIL DATE, not an instant, because "how old are you?" is
 * a question about a calendar day — and which calendar day it is depends on
 * where you are asking. Resolving that is `civilDateInEventZone`'s job, done
 * once, before this is called.
 *
 * Returns null when either date is not a real day. A caller must decide what
 * that means; it is never silently treated as zero.
 */
export function calculateAgeOnDate(
  dateOfBirth: string,
  referenceCivilDate: string,
): number | null {
  if (!isCivilDate(dateOfBirth) || !isCivilDate(referenceCivilDate)) return null;

  const birthYear = Number(dateOfBirth.slice(0, 4));
  const referenceYear = Number(referenceCivilDate.slice(0, 4));
  const referenceMonth = Number(referenceCivilDate.slice(5, 7));
  const referenceDay = Number(referenceCivilDate.slice(8, 10));

  const anniversary = birthdayInYear(dateOfBirth, referenceYear);

  // Whole years since birth, minus one if this year's birthday has not arrived.
  const birthdayHasPassed =
    referenceMonth > anniversary.month ||
    (referenceMonth === anniversary.month && referenceDay >= anniversary.day);

  return referenceYear - birthYear - (birthdayHasPassed ? 0 : 1);
}

/**
 * The civil date at the event's location, for a given instant.
 *
 * The event's zone, never UTC and never the browser's: an event in New York
 * that closes at midnight closes at midnight THERE, and somebody submitting at
 * 20:00 on the 4th is submitting on the 4th even though UTC has moved on.
 */
export function civilDateInEventZone(instant: Date, timeZone: string): string {
  return civilDateInTimeZone(instant, timeZone);
}

// ---------------------------------------------------------------------------
// Why a decision came out the way it did
// ---------------------------------------------------------------------------

/**
 * Every reason a participation can carry.
 *
 * Two groups that must not be confused:
 *
 *   * REJECTION reasons describe a submission that was never recorded — a
 *     closed event, a duplicate, a broken form. No entry exists to carry them,
 *     and they appear here only so one catalogue names every outcome.
 *   * DECISION reasons describe a participation that WAS recorded and then
 *     judged. `AGE_REQUIREMENT_NOT_MET` is the one that matters: somebody took
 *     part, and an operator needs to see that they did and why they were
 *     excluded from the draw.
 */
export const ELIGIBILITY_REASON_CODES = [
  'ELIGIBLE',
  'AGE_REQUIREMENT_NOT_MET',
  'DATE_OF_BIRTH_REQUIRED',
  'DATE_OF_BIRTH_INVALID',
  'EVENT_NOT_OPEN',
  'REGISTRATION_NOT_OPEN',
  'REGISTRATION_CLOSED',
  'FORM_INVALID',
  'REQUIRED_ANSWER_MISSING',
  'DUPLICATE_ENTRY',
  'DISQUALIFIED_BY_RULE',
] as const;

export type EligibilityReasonCode = (typeof ELIGIBILITY_REASON_CODES)[number];

/**
 * Reasons that can actually be STORED on an entry.
 *
 * Everything else refuses the submission outright, so no row exists to carry
 * it. Keeping the two sets apart is what stops an entry appearing with
 * `DUPLICATE_ENTRY` — a duplicate is a refusal, not a participation.
 */
export const PERSISTABLE_REASON_CODES: readonly EligibilityReasonCode[] = [
  'ELIGIBLE',
  'AGE_REQUIREMENT_NOT_MET',
  'DISQUALIFIED_BY_RULE',
];

export function isPersistableReason(code: EligibilityReasonCode): boolean {
  return PERSISTABLE_REASON_CODES.includes(code);
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * What was decided about one participation, at the moment it was submitted.
 *
 * A SNAPSHOT. Every field is the answer as it stood then, and none of it is
 * recomputed later: raising the minimum age tomorrow does not retroactively
 * exclude somebody who qualified today, and having a birthday does not
 * retroactively qualify somebody who did not.
 */
export interface EligibilityDecision {
  /** Age at submission, in the event's timezone. Null when nothing asked. */
  calculatedAge: number | null;
  /** True/false when an age rule applied; NULL when there was no age rule. */
  ageEligible: boolean | null;
  overallEligible: boolean;
  reasonCode: EligibilityReasonCode;
}

/** Why an age could not be established, when it could not. */
export type AgeProblem = 'MISSING' | 'INVALID' | 'IN_FUTURE' | 'IMPLAUSIBLE';

export type AgeResult =
  | { ok: true; age: number }
  | { ok: false; problem: AgeProblem };

/**
 * Establishes an age, or says precisely why it cannot.
 *
 * Separating "no date of birth was asked for" from "the date given is not a
 * real day" from "it is in the future" matters, because the first is a form
 * that did not ask and the other two are input that must be refused. Collapsing
 * them into one boolean is how a corrupted row becomes an eligibility outcome.
 */
export function resolveAge(
  dateOfBirth: string | null,
  referenceCivilDate: string,
): AgeResult {
  if (dateOfBirth === null) return { ok: false, problem: 'MISSING' };

  const age = calculateAgeOnDate(dateOfBirth, referenceCivilDate);
  if (age === null) return { ok: false, problem: 'INVALID' };

  // Being born after today is not a fact about a person; it is bad input, and
  // it would put a negative number into the column every later rule reads.
  if (age < MIN_REASONABLE_AGE) return { ok: false, problem: 'IN_FUTURE' };
  if (age > MAX_REASONABLE_AGE) return { ok: false, problem: 'IMPLAUSIBLE' };

  return { ok: true, age };
}

/**
 * What evaluating eligibility produced.
 *
 * The distinction this type exists to make STRUCTURAL rather than conventional:
 *
 *   * `decided`  — a real participation. It is recorded, whatever the verdict.
 *                  Somebody who is too young DID take part, and an operator has
 *                  to be able to see that they did and why they were excluded.
 *   * `rejected` — the submission itself does not describe a participation. A
 *                  date of birth in the future or a form missing the question
 *                  the age rule depends on is broken input, and recording it as
 *                  "ineligible" would file a corruption as a decision about a
 *                  person.
 *
 * A caller cannot get this wrong by forgetting a check, because there is no
 * shape it can read a decision out of without first saying which one it got.
 */
export type EligibilityOutcome =
  | { kind: 'decided'; decision: EligibilityDecision }
  | {
      kind: 'rejected';
      reasonCode: 'DATE_OF_BIRTH_REQUIRED' | 'DATE_OF_BIRTH_INVALID' | 'FORM_INVALID';
      /** What was wrong with the date, when that is what was wrong. */
      problem?: AgeProblem;
    };

export interface AgeRuleInput {
  /** The event's rule. `null` means there is none; `0` means there is one. */
  minimumAge: number | null;
  /** The value the submission carried, if any. */
  dateOfBirth: string | null;
  /** Whether the published version even asks the question. */
  formAsksForDateOfBirth: boolean;
  /** The day it is where the event is happening. */
  referenceCivilDate: string;
}

/**
 * The whole age decision for one participation.
 *
 * `minimumAge` is compared against `null`, never for truthiness: an event with
 * a minimum age of ZERO has an age rule — one that everybody passes — and
 * `if (event.minimumAge)` would silently discard it, leaving `ageEligible` null
 * on an event that genuinely asked.
 */
export function evaluateAgeEligibility(input: AgeRuleInput): EligibilityOutcome {
  const { minimumAge, dateOfBirth, formAsksForDateOfBirth, referenceCivilDate } = input;
  const resolved = resolveAge(dateOfBirth, referenceCivilDate);

  // A date that was given must be a real, possible one whether or not any rule
  // reads it. Storing an impossible birthday because "no age rule applied"
  // would leave a corruption waiting for the first event that does have a rule.
  if (!resolved.ok && resolved.problem !== 'MISSING') {
    return { kind: 'rejected', reasonCode: 'DATE_OF_BIRTH_INVALID', problem: resolved.problem };
  }

  // No age rule. The age is still computed when a date of birth was given — it
  // is a fact worth recording — but nothing was judged, so `ageEligible` stays
  // NULL rather than becoming a `true` nobody decided.
  if (minimumAge === null) {
    return {
      kind: 'decided',
      decision: {
        calculatedAge: resolved.ok ? resolved.age : null,
        ageEligible: null,
        overallEligible: true,
        reasonCode: 'ELIGIBLE',
      },
    };
  }

  if (!resolved.ok) {
    // Publishing guarantees a form carries DATE_OF_BIRTH, required, whenever
    // the event has a minimum age. Arriving here without one therefore means
    // the stored version is not what publishing would have produced — a broken
    // FORM, not a person who forgot to answer.
    return {
      kind: 'rejected',
      reasonCode: formAsksForDateOfBirth ? 'DATE_OF_BIRTH_REQUIRED' : 'FORM_INVALID',
      problem: resolved.problem,
    };
  }

  const passes = resolved.age >= minimumAge;
  return {
    kind: 'decided',
    decision: {
      calculatedAge: resolved.age,
      ageEligible: passes,
      overallEligible: passes,
      reasonCode: passes ? 'ELIGIBLE' : 'AGE_REQUIREMENT_NOT_MET',
    },
  };
}

/**
 * The entry status a decision produces.
 *
 * `SUBMITTED` is deliberately not reachable from here. Before this phase an
 * entry was recorded and left unjudged; now every recorded participation is
 * born decided, in the same statement that creates it. The status remains in
 * the catalogue so the rows phase 7 already wrote stay readable.
 */
export function statusForDecision(
  decision: EligibilityDecision,
): 'ELIGIBLE' | 'INELIGIBLE' {
  return decision.overallEligible ? 'ELIGIBLE' : 'INELIGIBLE';
}

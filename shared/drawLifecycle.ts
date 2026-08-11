// The vocabulary and the arithmetic of a draw.
//
// SHARED so the backend, the dev mock and the admin UI read ONE table. The
// server selects the winners and nothing else may, but "how many people are in
// the running?" and "how many things are there to give away?" must be the same
// question everywhere, or the confirmation dialog will promise a number the
// draw does not produce.
//
// WHAT THIS FILE DOES NOT DO: decide eligibility. A draw consumes the verdict
// phase 8 recorded and the disposition phase 10 applied, and never reinterprets
// an answer, a date of birth or an age. `isDrawEligible` is re-exported from
// `participantAdministration.ts` rather than restated, so the count an operator
// saw on the participants screen and the population the draw takes are the same
// predicate — not two that agree by coincidence.

import type { EventStatus } from './eventLifecycle.ts';
import { isDrawEligible } from './participantAdministration.ts';

export { isDrawEligible };

/**
 * How the winners were chosen.
 *
 * Persisted on every draw, so a future change to the procedure cannot silently
 * reinterpret an old one: the row says how it was made, and nothing has to be
 * inferred from a deployment date. Change this string only alongside a change
 * to the algorithm itself.
 */
export const DRAW_ALGORITHM_VERSION = 'CRYPTO_FISHER_YATES_V1';

/**
 * The version tag on the canonical candidate serialization.
 *
 * `v2` because `v1` joined the identifiers with newlines, and a newline inside
 * an identifier made two DIFFERENT populations serialise identically —
 * `['a\nb', 'c']` and `['a', 'b\nc']` both became `a\nb\nc`. Entry ids are
 * generated as UUIDs so no such id exists today, but a hash is evidence, and
 * evidence whose meaning depends on nobody ever writing an unusual id is not
 * evidence. See `canonicalCandidateSet`.
 */
export const CANDIDATE_SET_HASH_VERSION = 'v2';

/**
 * The one event state a draw may run from.
 *
 * Not CLOSED: `mark-draw-ready` is the operator's explicit declaration that the
 * population and the prizes are settled, and running a draw without it would
 * make that declaration decorative. Not DRAW_COMPLETED: that is the state a
 * draw produces.
 */
export const EVENT_STATUS_ALLOWING_DRAW: EventStatus = 'DRAW_READY';

export function eventAllowsDraw(status: EventStatus): boolean {
  return status === EVENT_STATUS_ALLOWING_DRAW;
}

// ---------------------------------------------------------------------------
// Prize units
// ---------------------------------------------------------------------------

/**
 * One winnable thing.
 *
 * A prize with `quantity = 3` is three of these. The distinction matters
 * because a winner takes a UNIT, not a prize: three people can each win "a
 * vape" without any of them winning the same vape.
 */
export interface PrizeUnit {
  prizeId: string;
  /** 1-based, and stable: unit 2 of a prize is always unit 2. */
  unitIndex: number;
  nameSnapshot: string;
  descriptionSnapshot: string | null;
  sortOrder: number;
}

/** The shape `expandPrizeUnits` needs. Deliberately narrower than `EventPrize`. */
export interface ExpandablePrize {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  sortOrder: number;
  status: string;
}

/**
 * Turns prizes into the units a draw actually gives away.
 *
 * ACTIVE only: INACTIVE is an operator parking something they are still
 * deciding about and ARCHIVED is one they withdrew. Neither is on offer, and
 * putting either into a draw would award something nobody meant to give.
 *
 * The ORDER IS DETERMINISTIC — `sortOrder`, then the prize id as a tie-breaker,
 * then the unit index — and that is deliberate. The randomness in a draw
 * belongs entirely to which PARTICIPANT is picked; the units are a fixed list.
 * Shuffling both would make the result depend on two sources of chance and on
 * whatever order SQLite happened to return rows in, which is not a source of
 * chance at all.
 */
export function expandPrizeUnits(
  prizes: readonly ExpandablePrize[],
  limit = Number.POSITIVE_INFINITY,
): PrizeUnit[] {
  const units: PrizeUnit[] = [];
  if (limit < 1) return units;

  for (const prize of orderedOffering(prizes)) {
    for (let unitIndex = 1; unitIndex <= prize.quantity; unitIndex++) {
      units.push({
        prizeId: prize.id,
        unitIndex,
        // Copied HERE, at draw time, so the assignment records what the prize
        // was called when it was won rather than what it is called now.
        nameSnapshot: prize.name,
        descriptionSnapshot: prize.description,
        sortOrder: prize.sortOrder,
      });
      // The LIMIT stops early without changing anything about which units come
      // first. The order is fixed, so the first N units under a limit are the
      // same N units the unlimited expansion would have produced — the caller
      // gets a prefix, never a different selection.
      if (units.length >= limit) return units;
    }
  }

  return units;
}

/** The ACTIVE prizes, in the one order the draw ever consumes them. */
function orderedOffering(prizes: readonly ExpandablePrize[]): ExpandablePrize[] {
  return [...prizes]
    .filter((prize) => prize.status === 'ACTIVE' && prize.quantity > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

/**
 * How many units are on offer, WITHOUT building one object per unit.
 *
 * The configuration ceilings allow `PRIZES_PER_EVENT_MAX × PRIZE_QUANTITY_MAX`
 * — a hundred thousand units — and a draw with three candidates needs three of
 * them. Expanding the whole offering first cost about ten megabytes of heap for
 * a result that discards 99,997 of the objects it allocated, inside a runtime
 * with a hard memory limit.
 *
 * So the count comes from arithmetic and the expansion is bounded by what could
 * actually be awarded. `prize_unit_count` on the draw still records the FULL
 * offering — that is what was available — while only the winnable prefix is
 * materialised.
 */
export function countPrizeUnits(prizes: readonly ExpandablePrize[]): number {
  let total = 0;
  for (const prize of prizes) {
    if (prize.status === 'ACTIVE' && prize.quantity > 0) total += prize.quantity;
  }
  return total;
}

/**
 * How many winners a draw will produce.
 *
 * The smaller of the two populations, always. Five prizes and three people
 * means three winners and two unassigned units — never a third person winning
 * twice, and never a phantom fourth winner.
 */
export function plannedWinnerCount(candidateCount: number, prizeUnitCount: number): number {
  return Math.min(candidateCount, prizeUnitCount);
}

// ---------------------------------------------------------------------------
// Candidate set hash
// ---------------------------------------------------------------------------

/**
 * The canonical serialization the candidate hash is taken over.
 *
 * ONE definition, because a hash is only evidence if everybody computes it the
 * same way. Sorted, so the order SQLite returned rows in cannot change the
 * result; version-prefixed, so the format can change later without silently
 * producing a colliding digest under the old name.
 *
 * A JSON ARRAY, and that is the correction that produced `v2`. The first
 * version joined the identifiers with newlines, which is unambiguous only while
 * no identifier contains one — and `event_entries.id` is a TEXT column with no
 * format constraint. Two different populations could therefore hash the same:
 *
 *     ['a\n b', 'c']   and   ['a', 'b\n c']   →   "v1\n a\n b\n c"
 *
 * JSON escapes the separator, so no member can impersonate a boundary.
 * `JSON.stringify` of an array of strings is deterministic — no key ordering is
 * involved — which is what makes it safe to hash. NOT of a Set, which
 * serializes to `{}`.
 *
 * It carries entry IDS ONLY: no name, no email, no answer. The hash proves
 * which population was consumed without being a copy of it.
 */
export function canonicalCandidateSet(entryIds: readonly string[]): string {
  return JSON.stringify([CANDIDATE_SET_HASH_VERSION, ...[...entryIds].sort()]);
}

/**
 * SHA-256 of the canonical set, lowercase hex.
 *
 * Lives HERE rather than in the backend so the dev mock computes the same
 * digest from the same bytes. A hash the mock derived differently would agree
 * in shape and disagree in value, which is the one kind of divergence a parity
 * test written against shapes would not catch.
 *
 * `crypto.subtle` is present in Workers, in Node and in browsers, so there is
 * one implementation rather than one per runtime.
 */
export async function hashCandidateSet(entryIds: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalCandidateSet(entryIds)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Why a draw did not happen.
 *
 * A closed vocabulary shared by the service, the API and the UI, so an operator
 * is told which of these it was rather than being shown a generic failure for a
 * condition they could fix in ten seconds.
 */
export const DRAW_FAILURE_CODES = [
  'DRAW_NOT_READY',
  'DRAW_ALREADY_COMPLETED',
  'NO_ELIGIBLE_PARTICIPANTS',
  'NO_ACTIVE_PRIZES',
  'DRAW_POPULATION_CHANGED',
  'DRAW_CONFLICT',
] as const;

export type DrawFailureCode = (typeof DRAW_FAILURE_CODES)[number];

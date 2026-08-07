// IANA timezone support.
//
// The system stores instants in UTC and renders them in a timezone. Anything
// that has an "opening time", a "closing time" or a "today" belongs to a place,
// so the zone must be an explicit, validated value rather than whatever the
// server or the viewer's browser happens to be set to.
//
// SHARED because the eligibility rules read the event's zone to decide what day
// it is there, and the dev mock has to refuse a corrupt zone for the same
// reason the server does. `functions/_shared/timezone.ts` re-exports all of it.
//
// Never store a UTC offset — offsets change twice a year under DST, identifiers
// do not.

/** Operational timezone of the business. */
export const DEFAULT_TIMEZONE = 'America/New_York';

/**
 * Every IANA identifier starts with a letter.
 *
 * Modern runtimes ALSO accept a fixed UTC offset here — `+05:30` resolves
 * happily through `Intl` — and that is precisely what must not be stored. An
 * offset does not observe daylight saving, so an event kept as `-05:00` is
 * correct in New York for half the year and an hour out for the other half.
 * Near local midnight that hour decides which calendar day it is, and the
 * calendar day decides somebody's age.
 *
 * `Etc/GMT+5` is a real identifier and starts with a letter, so it still
 * passes; `+05:30` and `-0500` do not.
 */
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

/**
 * True when the string is a timezone this runtime can actually resolve.
 *
 * Validated by asking Intl to use it: a bad identifier throws a RangeError.
 * That is the only honest check for existence — a hardcoded list would rot as
 * the IANA database changes — but existence is not enough on its own, so the
 * shape is checked first to keep raw offsets out.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    return false;
  }
  if (!IANA_SHAPE.test(value)) return false;
  // `UTC` is valid; single-word aliases otherwise tend to be legacy, but Intl
  // is the authority on what resolves, so defer to it rather than guessing.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(value: unknown, field = 'timezone'): string {
  if (!isValidTimeZone(value)) {
    throw new TypeError(`${field} must be a valid IANA timezone identifier`);
  }
  return value;
}

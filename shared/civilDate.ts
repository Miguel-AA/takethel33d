// A calendar day with no time and no zone: `YYYY-MM-DD`.
//
// SHARED because both sides of the wire now need it. A date of birth is
// answered in the browser, validated in the domain layer, stored by the
// backend, and rendered back in the admin UI — and every one of those needs the
// SAME answer to "is this a real day?". Two implementations of that question
// eventually disagree about 2025-02-29.
//
// A birthday is the same day everywhere. Converting one to an instant is what
// produces the classic off-by-one-day bug, so these values never go through
// `Date` arithmetic — the single use of `Date.UTC` below exists only to detect
// days that do not exist, and its result is thrown away.
//
// `functions/_shared/time.ts` re-exports all of this, so backend callers keep
// importing timestamps and civil dates from one place.

/** Exact shape of a stored civil date. */
export const CIVIL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True when the value is a real calendar day in `YYYY-MM-DD` form.
 *
 * Rejects shapes that pass a regex but do not exist (`2026-02-30`,
 * `2025-02-29`, `2026-13-01`) by round-tripping through UTC and checking the
 * components survived — `Date.UTC` silently rolls overflow forward.
 */
export function isCivilDate(value: unknown): value is string {
  if (typeof value !== 'string' || !CIVIL_DATE_PATTERN.test(value)) return false;

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const asUtc = new Date(Date.UTC(year, month - 1, day));
  return (
    asUtc.getUTCFullYear() === year &&
    asUtc.getUTCMonth() === month - 1 &&
    asUtc.getUTCDate() === day
  );
}

export function assertCivilDate(value: unknown, field = 'date'): string {
  if (!isCivilDate(value)) {
    throw new TypeError(`${field} must be a real calendar date (YYYY-MM-DD)`);
  }
  return value;
}

/**
 * Compares two civil dates: negative if a < b, 0 if equal, positive if a > b.
 *
 * String comparison is correct here precisely because the format is
 * zero-padded and fixed-width — and it avoids `Date`, which would drag a
 * timezone into a question that has none.
 */
export function compareCivilDates(a: string, b: string): number {
  assertCivilDate(a, 'a');
  assertCivilDate(b, 'b');
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The civil date of an instant, in a given IANA timezone.
 *
 * "Today" is a question about a place, not about UTC: in New York, 20:00 local
 * on the 4th is already the 5th in UTC. Anything that decides what day it is —
 * an age, an opening time, a deadline — must go through here with the zone that
 * owns the question, never with the server's zone or the viewer's.
 *
 * `en-CA` is used because its short date format IS `YYYY-MM-DD`, so the parts
 * come back already in the shape a civil date stores. The zone is applied by
 * Intl, which knows the DST rules; computing an offset by hand and adding
 * milliseconds is what produces an answer that is wrong twice a year.
 */
export function civilDateInTimeZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

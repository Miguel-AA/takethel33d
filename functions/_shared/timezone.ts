// IANA timezone support.
//
// The system stores instants in UTC and renders them in a timezone. Anything
// that has an "opening time", a "closing time" or a "today" belongs to a place,
// so the zone must be an explicit, validated value rather than whatever the
// server or the viewer's browser happens to be set to.
//
// Convention for future entities (Events in a later phase): store the IANA
// identifier in a `timezone TEXT NOT NULL` column defaulted to
// `DEFAULT_TIMEZONE`, and keep the instants themselves in UTC. Never store a
// UTC offset — offsets change twice a year under DST, identifiers do not.
//
// No timezone column is added to any table in this phase.

// The identifier, its validation and the default now live in
// `shared/timezone.ts` and are re-exported here, so the backend keeps one
// import while the dev mock and the shared eligibility rules read the SAME
// validator. A second definition of "is this zone real?" is a second answer.

export { DEFAULT_TIMEZONE, isValidTimeZone, assertTimeZone } from '../../shared/timezone';

import { DEFAULT_TIMEZONE } from '../../shared/timezone';

/** Formats an instant for display in a timezone. Never used for storage. */
export function formatInTimeZone(
  instant: Date,
  timeZone: string = DEFAULT_TIMEZONE,
  locale = 'en-US',
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(instant);
}

/**
 * The UTC offset of a zone at a given instant, in minutes.
 *
 * Computed at that instant rather than "now", so a value that straddles a DST
 * boundary gets the offset that actually applied then.
 */
export function offsetMinutesAt(instant: Date, timeZone: string): number {
  const utc = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
  const local = new Date(instant.toLocaleString('en-US', { timeZone }));
  return Math.round((local.getTime() - utc.getTime()) / 60_000);
}

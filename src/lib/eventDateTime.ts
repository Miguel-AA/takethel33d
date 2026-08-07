// Converting between an `<input type="datetime-local">` value and a stored
// UTC instant, in the EVENT's timezone.
//
// The browser's own timezone must never enter this. An administrator in Madrid
// scheduling a New York event types New York wall-clock time; if the field were
// interpreted locally the event would be stored six hours out. `Intl` is used
// to find the zone's offset AT THAT MOMENT, so the conversion is also correct
// across a daylight-saving boundary — no date library needed.

/** `2026-06-01T18:30` — the shape `datetime-local` produces and accepts. */
const LOCAL_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

/**
 * The offset of a timezone at a given instant, in minutes east of UTC.
 *
 * Derived by formatting the instant in the target zone and reading the parts
 * back as if they were UTC: the difference between the two is the offset that
 * actually applied then, DST included.
 */
function offsetMinutesAt(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Intl renders midnight as hour 24 in some locales/zones.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asUtc - instant.getTime()) / 60_000;
}

/**
 * Converts wall-clock text in a timezone to a stored UTC instant.
 *
 * The offset depends on the instant and the instant depends on the offset, so
 * this resolves in two passes: guess with the offset at the naive time, then
 * re-check with the offset at the candidate.
 *
 * The result is then VERIFIED by rendering it back in the same zone. That one
 * check rejects two whole classes of silent corruption:
 *
 *  - Times that do not exist. On the spring-forward night New York jumps
 *    02:00 -> 03:00, so 02:30 never happens. Without the check it would be
 *    stored as 01:30 — an hour earlier than the operator typed.
 *  - Impossible calendar dates. `Date.UTC` rolls overflow forward, so
 *    `2026-13-01` becomes 2027-01-01 and `2026-06-32` becomes 2026-07-02.
 *    Saving a DIFFERENT valid date than the one typed is worse than refusing.
 *
 * Ambiguous times are accepted, not rejected: on the fall-back night 01:30
 * happens twice, and the two-pass resolution settles on the FIRST (still
 * daylight-time) occurrence — which is what someone means by "1:30 that
 * morning". The value round-trips, so re-editing shows the same wall clock.
 */
export function localInputToIso(value: string, timeZone: string): string | null {
  if (!LOCAL_INPUT_PATTERN.test(value)) return null;

  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute, second = 0] = timePart.split(':').map(Number);

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(naiveUtc)) return null;

  let instant = naiveUtc - offsetMinutesAt(new Date(naiveUtc), timeZone) * 60_000;
  instant = naiveUtc - offsetMinutesAt(new Date(instant), timeZone) * 60_000;

  const candidate = new Date(instant);
  if (Number.isNaN(candidate.getTime())) return null;

  // The wall clock we land on must be the wall clock that was typed.
  const rendered = isoToLocalInput(candidate.toISOString(), timeZone);
  if (rendered !== `${datePart}T${timePart.slice(0, 5)}`) return null;

  return candidate.toISOString();
}

/** Converts a stored UTC instant to wall-clock text for the input field. */
export function isoToLocalInput(iso: string | null, timeZone: string): string {
  if (!iso) return '';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '';

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

/**
 * Human-readable instant in the event's timezone, with the zone named.
 *
 * Uses explicit component options rather than `dateStyle`/`timeStyle`: mixing
 * those shorthands with `timeZoneName` makes `Intl.DateTimeFormat` throw
 * ("Invalid option"), which would take the whole page down. Naming the zone
 * matters here — a time without it is ambiguous to an administrator working
 * from a different one.
 */
export function formatInEventZone(
  iso: string | null,
  timeZone: string,
  locale = 'en-US',
): string {
  if (!iso) return '—';
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return '—';

  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(instant);
  } catch {
    // A stored timezone the runtime cannot resolve must not break rendering.
    return new Date(iso).toISOString();
  }
}

/** Timezones offered in the picker. `Intl` validates anything else server-side. */
export const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Puerto_Rico',
  'America/Mexico_City',
  'UTC',
  'Europe/Madrid',
  'Europe/London',
] as const;

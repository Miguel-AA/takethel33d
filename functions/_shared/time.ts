// Timestamp and civil-date conventions.
//
// TWO distinct concepts, deliberately never mixed:
//
//   * Instant   — a moment in time. Stored as ISO-8601 UTC with milliseconds:
//                 `YYYY-MM-DDTHH:mm:ss.sssZ`. Always 24 characters, so
//                 lexicographic ordering in SQL equals chronological ordering,
//                 which the expiry, rate-limit and audit-listing queries rely on.
//
//   * CivilDate — a calendar day with no time and no zone: `YYYY-MM-DD`.
//                 A birthday is the same day everywhere; converting it to an
//                 instant is what produces the classic "off by one day" bug, so
//                 these values are never passed through `Date` arithmetic.
//
// All NEW tables write instants generated here. `datetime('now')` is not used
// for new tables: it produces a space-separated, zone-less value that sorts
// inconsistently against ISO strings.

/** Exact shape of a stored instant. */
export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Length of a canonical stored instant, for SQL CHECK constraints. */
export const ISO_TIMESTAMP_LENGTH = 24;

// --- Instants -------------------------------------------------------------

/** The canonical "now". Every new write goes through this. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** An instant offset from now, e.g. a session expiry. */
export function isoFromNow(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** True when the value is exactly in canonical stored form. */
export function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_TIMESTAMP_PATTERN.test(value);
}

/**
 * Throws when a value is not a canonical instant.
 *
 * Used at write boundaries so a malformed timestamp is rejected before it can
 * poison a column whose ordering the application depends on.
 */
export function assertIsoTimestamp(value: unknown, field = 'timestamp'): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(
      `${field} must be an ISO-8601 UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)`,
    );
  }
  return value;
}

/**
 * Parses a stored timestamp to epoch milliseconds, or null if unusable.
 *
 * Accepts the LEGACY shapes still present in the pre-0005 tables — SQLite's
 * `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` with no zone marker, which is
 * UTC in practice — so historical rows remain readable. New data is always
 * canonical.
 */
export function parseStoredTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized)
    ? normalized
    : `${normalized}Z`;
  const ms = Date.parse(withZone);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Rewrites a stored timestamp into canonical form, or null if unparseable.
 * Lets a query compare legacy and new rows on equal footing.
 */
export function normalizeStoredTimestamp(
  value: string | null | undefined,
): string | null {
  const ms = parseStoredTimestamp(value);
  return ms === null ? null : new Date(ms).toISOString();
}

// --- Civil dates ----------------------------------------------------------
//
// Defined in `shared/civilDate.ts` and re-exported here, so backend callers
// keep importing instants and civil dates from one module while the browser,
// the dev mock and the domain layer read the SAME implementation. Two answers
// to "is 2025-02-29 a real day?" is one answer too many.

export {
  CIVIL_DATE_PATTERN,
  isCivilDate,
  assertCivilDate,
  compareCivilDates,
} from '../../shared/civilDate';

/**
 * The civil date of an instant, in a given IANA timezone.
 *
 * Defined in `shared/civilDate.ts` and re-exported here. The eligibility phase
 * needs the same "what day is it there?" answer in the dev mock and in the
 * shared preview logic, and two implementations of that question would
 * eventually disagree about midnight — which is the one moment it matters.
 */
export { civilDateInTimeZone } from '../../shared/civilDate';

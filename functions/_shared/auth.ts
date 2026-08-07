// Low-level auth primitives shared by the password, token and session layers.
//
// Session lifetime lives here as the SINGLE source of truth. Nothing else in
// the codebase may hardcode a TTL — import `SESSION_TTL_MS` instead.

/** Administrative session lifetime: 12 hours (unchanged from the legacy flow). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Same value expressed in seconds, for the cookie `Max-Age` attribute. */
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/**
 * Constant-time string comparison.
 *
 * Note: like every JS implementation, this leaks the LENGTH of the inputs via
 * the early return. That is acceptable for the values compared here (hex
 * digests of fixed length).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// The byte-wise counterpart, `timingSafeEqualBytes`, lives in `password.ts` so
// that module can stay import-free (see its header).

// Timestamp helpers moved to `time.ts` in phase 2, which is now the single
// definition of the storage format for instants and civil dates. Re-exported
// here so existing call sites keep working without a second implementation.
export {
  nowIso,
  isoFromNow,
  parseStoredTimestamp,
  parseStoredTimestamp as parseIso,
} from './time';

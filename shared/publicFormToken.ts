// Everything about the form-session token EXCEPT the signature.
//
// WHY THIS LIVES IN `shared/`. Three parties have to agree on what a token IS:
// the server that mints and verifies one, the dev mock the UI is built against,
// and the tests that attack both. The SIGNATURE is server-only — it needs the
// secret and `crypto.subtle` — but the shape, the encoding, the claim set, the
// expiry and the event binding are not, and a second hand-written copy of them
// in the mock is exactly the kind of thing that drifts silently until a real
// user meets the difference.
//
// So: the rules live here, the key lives on the server, and the mock reuses
// this file verbatim rather than approximating it.
//
// This module has no runtime dependency beyond `TextEncoder`/`atob`/`btoa`,
// all of which exist in Workers, in Node and in a browser.

import {
  PUBLIC_FORM_TOKEN_MAX_BYTES,
  PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS,
  PUBLIC_FORM_TOKEN_TTL_SECONDS,
} from './limits.ts';

/** The only version issued, and the only one accepted. */
export const TOKEN_PREFIX = 'v1';

/**
 * The signed claims.
 *
 * Single letters because the token travels in a JSON response and back in a
 * request body, and a short payload keeps it well inside the size cap. There is
 * NO `alg` field — a token that names its own algorithm invites the caller to
 * choose one, which is the original JWT mistake. The algorithm is fixed by the
 * verifier and is not negotiable.
 */
export interface TokenPayload {
  /** eventId */
  e: string;
  /** versionId */
  v: string;
  /** issuedAt, SECONDS since the epoch */
  i: number;
  /** nonce — makes each issued token distinct */
  n: string;
}

/**
 * Why a token was refused.
 *
 * Granular for LOGGING and TESTS only. The HTTP layer collapses every one of
 * these into a single public code: telling a caller whether the signature
 * failed or the token merely expired hands them an oracle for probing the
 * secret.
 */
export type FormTokenFailure =
  | 'SECRET_MISSING'
  | 'TOO_LARGE'
  | 'MALFORMED'
  | 'UNSUPPORTED_VERSION'
  | 'BAD_SIGNATURE'
  | 'EXPIRED'
  | 'ISSUED_IN_FUTURE'
  | 'EVENT_MISMATCH';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decodes base64url, or returns null.
 *
 * The alphabet is checked EXPLICITLY before `atob` is called. `atob` is lax
 * about stray characters in several runtimes, so relying on it to reject
 * malformed input would let a token that is not canonical base64url through and
 * make two different strings decode to the same bytes — which is a signature
 * bypass waiting to happen.
 */
export function fromBase64Url(value: string): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);

  try {
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * Splits a token without decoding anything.
 *
 * The size is measured FIRST, in BYTES rather than characters — a multi-byte
 * string can be well under the limit by `length` and far over it in transit —
 * and before any split, decode or parse, so a hostile caller cannot make the
 * server do work by sending a megabyte of base64.
 */
export function splitToken(
  token: string,
): { prefix: string; payload: string; mac: string } | null {
  if (typeof token !== 'string') return null;
  if (encoder.encode(token).length > PUBLIC_FORM_TOKEN_MAX_BYTES) return null;

  const segments = token.split('.');
  if (segments.length !== 3) return null;
  return { prefix: segments[0], payload: segments[1], mac: segments[2] };
}

/**
 * Structural check on a decoded payload.
 *
 * EXACTLY the four claims — no more, no fewer. A signature already makes
 * injection impossible, so this is not what stops an attacker; it stops US. A
 * future issuer that quietly adds a fifth claim, or a payload carrying
 * `__proto__` as a literal key, should be refused loudly here rather than
 * accepted and half-understood. The token has one canonical shape and this is
 * it.
 *
 * Every field is read by name and type-checked, so an injected `__proto__`
 * never reaches a property access.
 */
export function isTokenPayload(value: unknown): value is TokenPayload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;

  const keys = Object.keys(candidate);
  if (keys.length !== 4) return false;
  for (const key of keys) {
    if (key !== 'e' && key !== 'v' && key !== 'i' && key !== 'n') return false;
  }

  return (
    typeof candidate.e === 'string' &&
    candidate.e.length > 0 &&
    typeof candidate.v === 'string' &&
    candidate.v.length > 0 &&
    typeof candidate.i === 'number' &&
    Number.isFinite(candidate.i) &&
    // A fractional issuedAt would make the TTL arithmetic meaningless.
    Number.isInteger(candidate.i) &&
    typeof candidate.n === 'string'
  );
}

/** Decodes and structurally validates a payload segment. */
export function decodeTokenPayload(encodedPayload: string): TokenPayload | null {
  const bytes = fromBase64Url(encodedPayload);
  if (bytes === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }

  return isTokenPayload(parsed) ? parsed : null;
}

/** Serializes a payload to its canonical encoded form. */
export function encodeTokenPayload(payload: TokenPayload): string {
  return toBase64Url(encoder.encode(JSON.stringify(payload)));
}

/**
 * The time and event rules, with `now` supplied ONCE by the caller.
 *
 * Never reads the clock itself. Two reads could straddle a boundary and leave a
 * token simultaneously "not yet valid" and "already expired", or neither.
 *
 * Boundaries are inclusive of the limit and exclusive beyond it: a token
 * exactly `TTL` seconds old is still good, and one exactly `skew` seconds ahead
 * is still accepted. Stated here so the two implementations cannot disagree by
 * one second.
 */
export function checkTokenClaims(
  payload: TokenPayload,
  expectedEventId: string,
  nowMs: number,
): FormTokenFailure | null {
  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.i - nowSeconds > PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS) {
    return 'ISSUED_IN_FUTURE';
  }
  if (nowSeconds - payload.i > PUBLIC_FORM_TOKEN_TTL_SECONDS) return 'EXPIRED';
  // A token minted for another event is refused even though its signature may
  // be genuine. Without this, one valid token would work on every event.
  if (payload.e !== expectedEventId) return 'EVENT_MISMATCH';
  return null;
}

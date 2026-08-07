// Uniform reading of JSON request bodies.
//
// Replaces the scattered `await request.json().catch(() => null)` pattern with
// one guard that enforces, in order:
//   1. content type  — a CSRF control (a cross-origin form cannot set it)
//   2. declared size — reject on Content-Length before reading anything
//   3. actual size   — a lying or absent Content-Length must not get a free pass
//   4. valid JSON    — parsed with the pollution-safe reviver
//
// Every failure is a typed API error, never a 500.

import { error } from './responses';
import { parseJson, type JsonValue } from './json';
import {
  PAYLOAD_LIMIT_ADMIN_BYTES,
  PAYLOAD_LIMIT_AUTH_BYTES,
  PAYLOAD_LIMIT_PUBLIC_FORM_BYTES,
} from '../../shared/limits';

export const PAYLOAD_LIMITS = {
  auth: PAYLOAD_LIMIT_AUTH_BYTES,
  admin: PAYLOAD_LIMIT_ADMIN_BYTES,
  /** Reserved for the public form flow of a later phase. */
  publicForm: PAYLOAD_LIMIT_PUBLIC_FORM_BYTES,
} as const;

export type PayloadResult =
  | { ok: true; value: JsonValue }
  | { ok: false; response: Response };

/** Content type must be exactly application/json, parameters aside. */
function hasJsonContentType(request: Request): boolean {
  const header = request.headers.get('Content-Type') ?? '';
  return header.split(';')[0].trim().toLowerCase() === 'application/json';
}

function declaredLength(request: Request): number | null {
  const header = request.headers.get('Content-Length');
  if (!header) return null;
  const parsed = Number(header);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Reads and validates a JSON request body.
 *
 * @param maxBytes  ceiling for this endpoint — see `PAYLOAD_LIMITS`.
 * @param requestId correlation id, echoed in every rejection so a client that
 *                  hits a limit can quote something traceable.
 */
export async function readJsonBody(
  request: Request,
  maxBytes: number = PAYLOAD_LIMITS.admin,
  requestId?: string,
): Promise<PayloadResult> {
  const reject = (
    status: number,
    code: 'UNSUPPORTED_MEDIA_TYPE' | 'PAYLOAD_TOO_LARGE' | 'INVALID_JSON',
    message: string,
  ): PayloadResult => ({
    ok: false,
    response: error(status, code, message, undefined, { requestId }),
  });

  if (!hasJsonContentType(request)) {
    return reject(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }

  // Cheap rejection first: refuse an oversized body before spending memory on it.
  const declared = declaredLength(request);
  if (declared !== null && declared > maxBytes) {
    return reject(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return reject(400, 'INVALID_JSON', 'Could not read body');
  }

  // A Content-Length header is client-controlled and may lie (or be absent for
  // a chunked body), so the real size is what decides.
  const actualBytes = new TextEncoder().encode(raw).length;
  if (actualBytes > maxBytes) {
    return reject(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  if (raw.trim().length === 0) {
    return reject(400, 'INVALID_JSON', 'Request body is empty');
  }

  const parsed = parseJson(raw, { maxBytes });
  if (!parsed.ok) {
    return parsed.reason === 'too_large'
      ? reject(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large')
      : reject(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }

  return { ok: true, value: parsed.value };
}

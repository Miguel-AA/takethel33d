// Per-request metadata shared by auditing, logging and error responses.
//
// Resolved once at the edge of a request and threaded through, so an audit row,
// a log line and the error the client saw all carry the SAME request id and can
// be correlated after the fact.

import { newId } from './ids';
import { hashOpaqueValue } from './tokens';
import { REQUEST_ID_MAX_LENGTH, USER_AGENT_MAX_LENGTH } from '../../shared/limits';

/**
 * A client-supplied request id is echoed into logs and the audit table, so it
 * is untrusted input: restricted to an opaque token shape and a bounded
 * length. This blocks log injection (newlines, ANSI escapes, JSON breakers)
 * and unbounded storage.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface RequestContext {
  requestId: string;
  ipHash: string | null;
  userAgent: string | null;
  origin: string | null;
  method: string;
  pathname: string;
}

/** Accepts a caller-provided id only when it is safe to store and print. */
export function sanitizeRequestId(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0 || trimmed.length > REQUEST_ID_MAX_LENGTH) return null;
  return SAFE_REQUEST_ID.test(trimmed) ? trimmed : null;
}

/**
 * Resolves the request id.
 *
 * Prefers Cloudflare's `CF-Ray`, which is assigned by the edge and therefore
 * correlates with Cloudflare's own logs. Falls back to a client-supplied
 * `X-Request-ID` (validated), and finally mints a UUID so a request id ALWAYS
 * exists — auditing must never be skipped for want of one.
 */
export function resolveRequestId(request: Request): string {
  return (
    sanitizeRequestId(request.headers.get('CF-Ray')) ??
    sanitizeRequestId(request.headers.get('X-Request-ID')) ??
    newId()
  );
}

/** Best-effort client IP, Cloudflare's header first. */
export function clientIpOf(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    null
  );
}

/** Truncates a user agent so a hostile header cannot bloat a row. */
export function normalizeUserAgent(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, USER_AGENT_MAX_LENGTH);
}

/**
 * Builds the context for a request.
 *
 * The IP is hashed here and the raw value is never returned, so no downstream
 * caller can accidentally persist it.
 */
export async function buildRequestContext(request: Request): Promise<RequestContext> {
  const url = new URL(request.url);
  const ip = clientIpOf(request);

  return {
    requestId: resolveRequestId(request),
    ipHash: ip ? await hashOpaqueValue(ip) : null,
    userAgent: normalizeUserAgent(request.headers.get('User-Agent')),
    origin: request.headers.get('Origin'),
    method: request.method,
    pathname: url.pathname,
  };
}

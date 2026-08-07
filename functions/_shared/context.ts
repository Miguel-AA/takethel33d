// Per-request data shared from `_middleware.ts` to handlers.
//
// Cloudflare Pages Functions pass `ctx.data` down the middleware chain. The
// middleware resolves the session and the request context ONCE and stores them
// here, so no handler re-implements token parsing, IP hashing or id generation.

import type { AuthenticatedAdmin } from '../../shared/types';
import {
  normalizeUserAgent,
  resolveRequestId,
  type RequestContext,
} from './requestContext';

export interface AdminRequestData extends Record<string, unknown> {
  /** Set by `_middleware.ts` on every protected route. */
  admin?: AuthenticatedAdmin;
  /** Set by `_middleware.ts` on EVERY route, protected or public. */
  requestContext?: RequestContext;
}

/**
 * Narrows `ctx.data.admin` to a non-optional actor.
 *
 * Throws only if a handler were reachable without the middleware having
 * authenticated it — a wiring bug, not a user-triggerable condition. Failing
 * loudly is correct: silently treating it as anonymous would turn a routing
 * mistake into an authorization hole.
 */
export function requireAdmin(data: AdminRequestData): AuthenticatedAdmin {
  if (!data.admin) {
    throw new Error(
      'requireAdmin: no authenticated admin on ctx.data — route is not covered by the auth middleware',
    );
  }
  return data.admin;
}

/**
 * Returns the request context, falling back to deriving one from the request.
 *
 * A handler must always be able to obtain a request id — auditing and error
 * correlation depend on it — so this never throws.
 *
 * The fallback still resolves the id from `CF-Ray` / `X-Request-ID` rather than
 * minting an unrelated UUID: were the middleware ever bypassed or reordered, an
 * invented id would silently sever the correlation between the client's error,
 * the audit row and Cloudflare's own logs. Only `ipHash` is dropped, because
 * hashing is async and this accessor is not.
 */
export function requireRequestContext(
  data: AdminRequestData,
  request: Request,
): RequestContext {
  if (data.requestContext) return data.requestContext;

  return {
    requestId: resolveRequestId(request),
    ipHash: null,
    userAgent: normalizeUserAgent(request.headers.get('User-Agent')),
    origin: request.headers.get('Origin'),
    method: request.method,
    pathname: new URL(request.url).pathname,
  };
}

/** The audit actor for an authenticated admin. */
export function actorFrom(admin: AuthenticatedAdmin): {
  id: string;
  email: string;
  displayName: string;
} {
  return { id: admin.id, email: admin.email, displayName: admin.displayName };
}

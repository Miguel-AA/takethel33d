// Authentication middleware for every administrative route, plus per-request
// correlation for every route.
//
// It does not merely check that a token exists: it resolves the token to a
// concrete administrator and publishes that actor on `ctx.data.admin`, so
// downstream handlers know WHO is acting without repeating any validation.

import { error, withRequestId } from './_shared/responses';
import { readSessionCookie } from './_shared/cookies';
import { AdminAuthService, type SessionOutcome } from './_shared/adminAuthService';
import { AuditService } from './_shared/auditService';
import { isProtectedPath } from './_shared/routes';
import { buildRequestContext, type RequestContext } from './_shared/requestContext';
import type { AdminRequestData } from './_shared/context';
import type { ApiErrorCode } from '../shared/types';

type Env = {
  DB: D1Database;
};

/**
 * Denial reasons worth auditing.
 *
 * ONLY outcomes whose session row actually EXISTS in the database. That bound
 * is what keeps the audit table from being a flooding target: an attacker
 * spraying random or absent cookies produces `invalid`/`missing`, which are
 * never recorded, so they cannot write a single row. Reaching any reason below
 * requires possession of a token that was genuinely issued — a real security
 * signal (a revoked or expired session being replayed, or a suspended
 * administrator still trying to act) and inherently rate-limited by how many
 * sessions have ever existed.
 */
const AUDITED_DENIALS: ReadonlySet<SessionOutcome['kind']> = new Set([
  'revoked',
  'expired',
  'admin_suspended',
  'admin_disabled',
]);

const DENIAL_CODES: Record<string, ApiErrorCode> = {
  missing: 'UNAUTHORIZED',
  invalid: 'SESSION_INVALID',
  expired: 'SESSION_EXPIRED',
  revoked: 'SESSION_REVOKED',
  admin_suspended: 'ADMIN_SUSPENDED',
  admin_disabled: 'ADMIN_DISABLED',
};

const DENIAL_MESSAGES: Record<string, string> = {
  missing: 'Missing session',
  invalid: 'Invalid session',
  expired: 'Session expired',
  revoked: 'Session revoked',
  admin_suspended: 'Administrator suspended',
  admin_disabled: 'Administrator disabled',
};

function auditDenial(
  ctx: { env: Env; waitUntil: (promise: Promise<unknown>) => void },
  outcome: SessionOutcome,
  requestContext: RequestContext,
): void {
  if (!AUDITED_DENIALS.has(outcome.kind)) return;

  const audit = new AuditService(ctx.env.DB);
  ctx.waitUntil(
    audit
      .record({
        action: 'ADMIN_ACCESS_DENIED',
        entityType: 'ADMIN_SESSION',
        requestContext,
        metadata: {
          // A generic reason only — never why a token failed to decode, and
          // never the token itself.
          reason: outcome.kind,
          method: requestContext.method,
          path: requestContext.pathname,
        },
      })
      .catch(() => {}),
  );
}

export const onRequest: PagesFunction<Env, never, AdminRequestData> = async (ctx) => {
  const url = new URL(ctx.request.url);

  // Resolved for EVERY request, public or not, so a request id exists to
  // correlate logs, audit rows and the client's error message.
  const requestContext = await buildRequestContext(ctx.request);
  ctx.data.requestContext = requestContext;

  // The path is normalised inside `isProtectedPath` — the raw pathname is never
  // trusted, so encoding and slash tricks cannot route around the guard.
  if (!isProtectedPath(url.pathname)) {
    return withRequestId(await ctx.next(), requestContext.requestId);
  }

  const token = readSessionCookie(ctx.request);
  const auth = new AdminAuthService(ctx.env.DB);
  const outcome = await auth.validateSessionToken(token);

  if (outcome.kind !== 'valid') {
    auditDenial(ctx, outcome, requestContext);
    // Every failure is a 401: in each case the request carries no usable
    // session, and the SPA reacts to 401 uniformly by sending the user to the
    // login page. The distinct codes exist for diagnosis, not for control flow.
    return error(
      401,
      DENIAL_CODES[outcome.kind] ?? 'UNAUTHORIZED',
      DENIAL_MESSAGES[outcome.kind] ?? 'Unauthorized',
      undefined,
      { requestId: requestContext.requestId },
    );
  }

  ctx.data.admin = outcome.admin;

  // Non-blocking: keeps session activity roughly current without delaying the
  // response, and is internally throttled so polling does not hammer D1.
  ctx.waitUntil(
    auth.touchSession(outcome.admin.sessionId, outcome.lastSeenAt).catch(() => {}),
  );

  return withRequestId(await ctx.next(), requestContext.requestId);
};

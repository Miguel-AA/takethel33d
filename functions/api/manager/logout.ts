// POST /api/manager/logout — auth
//
// Real server-side revocation: it writes `revoked_at` on the session row, so
// the token stops authenticating immediately even if a copy of the cookie was
// captured. This is the behaviour the previous client-only logout lacked.

import { json } from '../../_shared/responses';
import { readJsonBody, PAYLOAD_LIMITS } from '../../_shared/payload';
import {
  actorFrom,
  requireAdmin,
  requireRequestContext,
  type AdminRequestData,
} from '../../_shared/context';
import { AdminAuthService } from '../../_shared/adminAuthService';
import { AuditService } from '../../_shared/auditService';
import { buildClearedSessionCookies, isSecureRequest } from '../../_shared/cookies';
import type { AdminLogoutResponse } from '../../../shared/types';

type Env = {
  DB: D1Database;
};

export const onRequestPost: PagesFunction<Env, never, AdminRequestData> = async (
  ctx,
) => {
  const requestContext = requireRequestContext(ctx.data, ctx.request);

  // An empty body is normal for logout, so only the content type and size are
  // enforced; a parse failure is tolerated below.
  const body = await readJsonBody(
    ctx.request,
    PAYLOAD_LIMITS.auth,
    requestContext.requestId,
  );
  // An empty body is normal for logout, so only the content-type and size
  // rejections are fatal; a missing/unparseable body is simply ignored.
  if (!body.ok && (body.response.status === 415 || body.response.status === 413)) {
    return body.response;
  }

  // The session to revoke comes from the authenticated context, NEVER from the
  // request body — otherwise any admin could revoke another admin's session by
  // naming its id.
  const actor = requireAdmin(ctx.data);

  await new AdminAuthService(ctx.env.DB).repositories.sessions.revokeById(
    actor.sessionId,
  );

  // BEST-EFFORT audit. Logging out is a security action: it must succeed even
  // if the audit insert fails, otherwise a database hiccup would strand a user
  // in an authenticated state they explicitly asked to leave. The failure is
  // recorded by the structured logger inside AuditService.
  ctx.waitUntil(
    new AuditService(ctx.env.DB)
      .record({
        action: 'ADMIN_LOGOUT',
        entityType: 'ADMIN_SESSION',
        entityId: actor.sessionId,
        actor: actorFrom(actor),
        requestContext,
        metadata: { sessionId: actor.sessionId },
      })
      .catch(() => {}),
  );

  // Idempotent by construction: `revokeById` only writes when `revoked_at` is
  // still NULL, and the cookies are cleared unconditionally, so repeating the
  // call is harmless and always leaves the client signed out.
  const responseBody: AdminLogoutResponse = { ok: true };
  const headers: Array<[string, string]> = [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestContext.requestId],
  ];
  for (const cookie of buildClearedSessionCookies(isSecureRequest(ctx.request))) {
    headers.push(['Set-Cookie', cookie]);
  }

  return json(200, responseBody, headers);
};

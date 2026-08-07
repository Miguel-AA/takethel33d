// POST /api/manager/login — public
//
// Authenticates an INDIVIDUAL administrator with email + password and installs
// an HttpOnly session cookie. The shared-password flow it replaces is gone:
// `env.MANAGER_PASSWORD` is no longer read anywhere.

import { adminLoginSchema } from '../../../shared/schemas';
import { error, json } from '../../_shared/responses';
import { readJsonBody, PAYLOAD_LIMITS } from '../../_shared/payload';
import { AdminAuthService } from '../../_shared/adminAuthService';
import { AuditService } from '../../_shared/auditService';
import { clientIpOf } from '../../_shared/requestContext';
import { buildSessionCookie, isSecureRequest } from '../../_shared/cookies';
import { requireRequestContext, type AdminRequestData } from '../../_shared/context';
import { maskEmail } from '../../_shared/redact';
import type { AdminLoginResponse } from '../../../shared/types';

type Env = {
  DB: D1Database;
};

export const onRequestPost: PagesFunction<Env, never, AdminRequestData> = async (
  ctx,
) => {
  const requestContext = requireRequestContext(ctx.data, ctx.request);
  const { requestId } = requestContext;
  const audit = new AuditService(ctx.env.DB);

  // Enforces the JSON content type (a CSRF control: a cross-origin form cannot
  // set it, which would otherwise allow session fixation) and a 16 KB ceiling.
  const body = await readJsonBody(ctx.request, PAYLOAD_LIMITS.auth, requestId);
  if (!body.ok) return body.response;

  const parsed = adminLoginSchema.safeParse(body.value);
  if (!parsed.success) {
    // Deliberately field-less: echoing which field failed on a login form is a
    // free hint to an attacker probing the shape of valid input.
    return error(400, 'VALIDATION_ERROR', 'Invalid credentials payload', undefined, {
      requestId,
    });
  }

  const auth = new AdminAuthService(ctx.env.DB);
  const outcome = await auth.login({
    email: parsed.data.email,
    password: parsed.data.password,
    userAgent: ctx.request.headers.get('User-Agent'),
    clientIp: clientIpOf(ctx.request),
  });

  /**
   * Audits a failure.
   *
   * The email is MASKED, never stored whole: the address is attacker-supplied
   * and may belong to no account, so keeping it verbatim would turn the audit
   * table into a harvest of probed addresses. The reason is the generic public
   * one, so reading the audit log cannot enumerate accounts either — a
   * non-existent email and a wrong password record identically.
   */
  const auditFailure = (rateLimited: boolean) => {
    ctx.waitUntil(
      audit
        .record({
          action: 'ADMIN_LOGIN_FAILED',
          entityType: 'SYSTEM',
          requestContext,
          metadata: {
            emailMasked: maskEmail(parsed.data.email),
            reason: 'invalid_credentials',
            rateLimited,
          },
        })
        .catch(() => {}),
    );
  };

  switch (outcome.kind) {
    case 'rate_limited':
      auditFailure(true);
      return error(429, 'RATE_LIMIT', 'Too many login attempts', undefined, {
        requestId,
        headers: { 'Retry-After': String(outcome.retryAfterSeconds) },
      });
    case 'invalid_credentials':
      auditFailure(false);
      // Same response for "no such email" and "wrong password" — the endpoint
      // must not be usable to enumerate accounts.
      return error(401, 'INVALID_CREDENTIALS', 'Invalid email or password', undefined, {
        requestId,
      });
    case 'suspended':
      auditFailure(false);
      return error(403, 'ADMIN_SUSPENDED', 'This account is suspended', undefined, {
        requestId,
      });
    case 'disabled':
      auditFailure(false);
      return error(403, 'ADMIN_DISABLED', 'This account is disabled', undefined, {
        requestId,
      });
    case 'ok':
      break;
  }

  // Best-effort: a failed audit write must never prevent a successful login.
  // The failure is reported through the structured logger inside the service.
  ctx.waitUntil(
    audit
      .record({
        action: 'ADMIN_LOGIN_SUCCEEDED',
        entityType: 'ADMIN_SESSION',
        entityId: outcome.sessionId,
        actor: {
          id: outcome.admin.id,
          email: outcome.admin.email,
          displayName: outcome.admin.displayName,
        },
        requestContext,
        // No token, no token hash, no cookie, no password.
        metadata: { sessionId: outcome.sessionId, expiresAt: outcome.expiresAt },
      })
      .catch(() => {}),
  );

  // Housekeeping of long-expired sessions and stale rate-limit windows.
  ctx.waitUntil(auth.purgeExpired().catch(() => {}));

  const responseBody: AdminLoginResponse = {
    admin: outcome.admin,
    expiresAt: outcome.expiresAt,
  };

  return json(200, responseBody, [
    ['Set-Cookie', buildSessionCookie(outcome.token, isSecureRequest(ctx.request))],
    // The session cookie must never be cached by an intermediary.
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
};

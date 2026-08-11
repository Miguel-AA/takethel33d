// GET /api/public-events/:slug
//
// The only unauthenticated read in the system, and the entry point of the whole
// participant flow: it resolves a slug, decides what a visitor may be told, and
// — when the event is genuinely open — mints the token that binds their
// eventual submission to the exact version rendered here.
//
// WHY `/api/public-events/` AND NOT `/api/public/events/`.
//
// `functions/_shared/routes.ts` protects by PREFIX: `/api/events` guards
// everything beneath it. A public namespace nested as `/api/public/events/...`
// reads, to a person skimming the route table, as though it lives under the
// protected `events` tree; one carelessly-added prefix would either expose the
// administrative routes or silently protect the public ones. A sibling
// namespace cannot be confused with a child of `/api/events`, and it is the
// namespace the original architecture named.
//
// NOTHING IS ADDED TO `PROTECTED_ROUTES`. The middleware is a DENY-LIST: any
// path not listed there is public already. This endpoint is therefore public by
// omission rather than by an allow-rule — which matters, because an allow-list
// is what would make path traversal dangerous. Today `..` can only ever
// normalise a path INTO the protected set (yielding 401), never out of it.

import { error } from '../../../_shared/responses';
import { PublicEventService } from '../../../_shared/publicEventService';
import { PublicFormTokenService } from '../../../_shared/publicFormToken';
import { PublicRateLimiter } from '../../../_shared/publicRateLimit';
import { publicError, publicJson, refusal } from '../../../_shared/publicHttp';
import { requireRequestContext, type AdminRequestData } from '../../../_shared/context';
import { logger } from '../../../_shared/logger';
import type { PublicEventResponse } from '../../../../shared/types';

type Env = {
  DB: D1Database;
  /**
   * OPTIONAL in the type, because a binding is a deployment fact rather than a
   * compile-time guarantee. Making it required would only move the failure to a
   * place where it cannot be handled — the handler must be able to answer
   * "unavailable" rather than throw.
   */
  PUBLIC_FORM_TOKEN_SECRET?: string;
};

export const onRequestGet: PagesFunction<Env, 'slug', AdminRequestData> = async (ctx) => {
  // The middleware builds this for EVERY request, public or not, so a public
  // response carries the same correlation id an administrative one would and
  // the IP is already hashed. No parallel request-context system is created.
  const requestContext = requireRequestContext(ctx.data, ctx.request);
  const { requestId } = requestContext;

  const slug = ctx.params.slug;
  if (typeof slug !== 'string' || slug.length === 0) {
    return error(400, 'INVALID_QUERY', 'Invalid event address', undefined, { requestId });
  }

  const service = new PublicEventService(
    ctx.env.DB,
    new PublicFormTokenService(ctx.env.PUBLIC_FORM_TOKEN_SECRET),
  );

  const found = await service.findVisibleEvent(slug);
  if (!found.ok) return publicError(refusal('PUBLIC_EVENT_NOT_FOUND', 404), requestId);
  const event = found.value;

  // Rate limiting is keyed by EVENT as well as address, so hammering one event
  // cannot lock a visitor out of another. It runs after the lookup because the
  // event id is part of the key — the cost is one indexed read for a request
  // that was going to be refused, which is cheaper than a bucket keyed on a
  // caller-supplied string that anybody could vary at will.
  const limiter = new PublicRateLimiter(ctx.env.DB);

  // Bounded housekeeping, off the response path. The public flow mints a bucket
  // row per distinct address, so without a sweep the table only ever grows and
  // an attacker rotating addresses leaves permanent debris. One sweep removes a
  // fixed batch of windows that can no longer block anybody; failing is
  // irrelevant to the request and is swallowed.
  ctx.waitUntil(limiter.sweep().catch(() => 0));

  const verdict = await limiter.checkGet(requestContext.ipHash, event.id);
  if (verdict.limited) {
    return publicError(
      refusal('RATE_LIMITED', 429, verdict.retryAfterSeconds),
      requestId,
    );
  }

  // ONE instant for the status and for the token's issuedAt.
  const nowMs = Date.now();
  const described = await service.describe(event, nowMs);
  if (!described.ok) {
    logger.error('public event could not be described', {
      requestId,
      action: 'PUBLIC_EVENT_UNAVAILABLE',
      eventId: event.id,
      reason: described.failure.code === 'UNAVAILABLE' ? described.failure.reason : 'not_found',
    });
    return publicError(refusal('PUBLIC_EVENT_UNAVAILABLE', 503), requestId);
  }

  // Identical whether or not the caller happens to hold an administrator's
  // session cookie: this route is not in `PROTECTED_ROUTES`, so the middleware
  // never looks at the cookie, and nothing here reads `ctx.data.admin`. A
  // logged-in operator previewing the page sees exactly what a stranger sees.
  const body: PublicEventResponse = { event: described.value };
  return publicJson(200, body, requestId);
};

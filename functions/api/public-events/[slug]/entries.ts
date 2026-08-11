// POST /api/public-events/:slug/entries
//
// A participant registering themselves. This is the only write in the system
// reachable without a session, so the ordering below is the security design and
// not merely tidy code.
//
// THE ORDER, AND WHY EACH STEP SITS WHERE IT DOES:
//
//   1. request context      — a correlation id must exist before anything can fail
//   2. slug -> event        — the rate-limit buckets are keyed by event
//   3. IP rate limit        — the cheapest refusal, before a body is read
//   4. bot verification     — the seam; pass-through today
//   5. body: type/size/JSON — bounded before parsing, parsed pollution-safely
//   6. strict schema        — mass assignment dies here
//   7. token verification   — HMAC before the payload is trusted for anything
//   8. registration         — one shared core, with the exact version and a gate
//
// The EMAIL-keyed limits cannot run here. The address lives inside the answers,
// and the answers are only meaningful once validated against the exact version
// — which happens inside the registration service. Re-resolving the version and
// re-validating in this handler purely to read an email would mean two
// implementations of the submission pipeline. Instead the service is handed an
// `identityGate` it calls once, after the profile is extracted and before
// anything is written. Same ordering, one pipeline.

import { error } from '../../../_shared/responses';
import { readJsonBody, PAYLOAD_LIMITS } from '../../../_shared/payload';
import { publicSubmissionSchema } from '../../../../shared/schemas';
import { PublicEventService } from '../../../_shared/publicEventService';
import { PublicFormTokenService } from '../../../_shared/publicFormToken';
import { PublicRateLimiter, hashEmailForBucket } from '../../../_shared/publicRateLimit';
import { PassThroughBotVerificationService } from '../../../_shared/botVerification';
import { ParticipantRegistrationService } from '../../../_shared/participantRegistrationService';
import {
  publicError,
  publicJson,
  refusal,
  registrationRefusal,
  tokenRefusal,
} from '../../../_shared/publicHttp';
import { requireRequestContext, type AdminRequestData } from '../../../_shared/context';
import { logger } from '../../../_shared/logger';
import type { EntryFailure } from '../../../_shared/participantRegistrationService';
import type { PublicEntryResponse } from '../../../../shared/types';

type Env = {
  DB: D1Database;
  PUBLIC_FORM_TOKEN_SECRET?: string;
};

export const onRequestPost: PagesFunction<Env, 'slug', AdminRequestData> = async (ctx) => {
  const requestContext = requireRequestContext(ctx.data, ctx.request);
  const { requestId } = requestContext;

  const slug = ctx.params.slug;
  if (typeof slug !== 'string' || slug.length === 0) {
    return error(400, 'INVALID_QUERY', 'Invalid event address', undefined, { requestId });
  }

  const tokens = new PublicFormTokenService(ctx.env.PUBLIC_FORM_TOKEN_SECRET);
  const service = new PublicEventService(ctx.env.DB, tokens);

  const found = await service.findVisibleEvent(slug);
  if (!found.ok) return publicError(refusal('PUBLIC_EVENT_NOT_FOUND', 404), requestId);
  const event = found.value;

  const limiter = new PublicRateLimiter(ctx.env.DB);
  ctx.waitUntil(limiter.sweep().catch(() => 0));

  const ipVerdict = await limiter.checkEntryIp(requestContext.ipHash, event.id);
  if (ipVerdict.limited) {
    return publicError(
      refusal('RATE_LIMITED', 429, ipVerdict.retryAfterSeconds),
      requestId,
    );
  }

  // The seam. Pass-through today; a real provider slots in here without
  // disturbing anything above or below it.
  const bots = new PassThroughBotVerificationService();
  const botVerdict = await bots.verify(ctx.request);
  if (!botVerdict.ok) {
    logger.warn('public submission refused by bot verification', {
      requestId,
      action: 'PUBLIC_SUBMISSION_BOT_REFUSED',
      reason: botVerdict.reason,
    });
    return publicError(refusal('RATE_LIMITED', 429), requestId);
  }

  // Content type (a CSRF control — a cross-origin form cannot set
  // `application/json`), declared size, actual size, then pollution-safe
  // parsing. All four in one call, all four returning typed errors.
  const body = await readJsonBody(ctx.request, PAYLOAD_LIMITS.publicForm, requestId);
  if (!body.ok) return body.response;

  const parsed = publicSubmissionSchema.safeParse(body.value);
  if (!parsed.success) {
    // `.strict()` refuses `participantId`, `status`, `overallEligible`,
    // `submittedAt` and every other server-owned field. The specific issues are
    // NOT returned: the wizard validates against the same shared rules before
    // submitting, so a rejection here means a stale page or a hand-built
    // request, and echoing the schema's shape back helps only the latter.
    return publicError(refusal('INVALID_FORM_SESSION', 400), requestId);
  }

  const nowMs = Date.now();
  const verified = await tokens.verify(parsed.data.formToken, event.id, nowMs);
  if (!verified.ok) {
    return publicError(tokenRefusal(verified.reason, requestId, slug), requestId);
  }

  const registration = new ParticipantRegistrationService(ctx.env.DB);

  // Called once, after the identity is known and before anything is written.
  // The hash is kept so a successful registration can release the backstop.
  let identityHash: string | null = null;

  const identityGate = async (normalizedEmail: string): Promise<EntryFailure | null> => {
    identityHash = await hashEmailForBucket(normalizedEmail);
    const verdict = await limiter.checkEntryIdentity(
      requestContext.ipHash,
      identityHash,
      event.id,
    );
    return verdict.limited
      ? { code: 'ENTRY_RATE_LIMITED', retryAfterSeconds: verdict.retryAfterSeconds }
      : null;
  };

  const result = await registration.registerWithResolvedVersion(
    event.id,
    // From the SIGNED payload, never from the request body. A caller cannot
    // nominate a version; it can only return the one it was handed.
    verified.claims.versionId,
    parsed.data.answers,
    // No administrator: a participant acting for themselves. The audit row is
    // still written, attributed to the request rather than to a person.
    { admin: null, requestContext },
    { submissionId: parsed.data.submissionId, identityGate },
  );

  if (!result.ok) {
    return publicError(registrationRefusal(result.failure, requestId), requestId);
  }

  const { decision, replayed } = result.value;

  // The registration succeeded, so the attempts spent reaching it are not
  // evidence of abuse. Releasing the generous email backstop keeps a first
  // fumbled try from shortening a later legitimate one — and matters most for
  // the lockout case, where that bucket is the one an attacker could burn on
  // somebody else's behalf. The precise IP+email bucket is deliberately NOT
  // released: it is the control that resists probing.
  if (!replayed && identityHash) {
    ctx.waitUntil(limiter.releaseIdentity(identityHash, event.id).catch(() => {}));
  }
  const eligible = decision.overallEligible;
  const message = PublicEventService.messageFor(event, eligible);

  const response: PublicEntryResponse = {
    result: eligible ? 'ELIGIBLE' : 'INELIGIBLE',
    // Only ever a reason that is safe to state. `AGE_REQUIREMENT_NOT_MET` is
    // something the person can understand and act on; it does not disclose the
    // age that was computed, only that a threshold was not met.
    reason: eligible ? null : decision.reasonCode,
    message: {
      // Null falls back to the client's own i18n copy: the server does not know
      // the visitor's language and must not guess it.
      title: message.title ?? '',
      body: message.body ?? '',
    },
  };

  // 200 rather than 201 on a replay: nothing was created this time. The body is
  // byte-identical to the original, which is what makes the retry safe.
  return publicJson(replayed ? 200 : 201, response, requestId);
};

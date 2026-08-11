// HTTP plumbing for the results endpoints.
//
// Separate from `drawHttp.ts` because the vocabularies are different: that one
// translates refusals about running a draw, this one refusals about publishing
// and archiving what a draw produced. One table covering both would be a table
// where a change to either risks the other.

import { error, json } from './responses';
import type { ResultFailure } from './resultsService';

const FAILURE_STATUS: Record<ResultFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  // 404 rather than 403, and that is the privacy decision.
  //
  // "These results exist but you may not see them" would tell anybody who asked
  // that a private draw has happened — which is precisely what an operator is
  // withholding by not publishing. A slug nobody has used, an event that was
  // never drawn and an event drawn but unpublished must be indistinguishable.
  RESULTS_NOT_AVAILABLE: 404,
  RESULTS_ALREADY_PUBLISHED: 409,
  // The state forbids it, not the request.
  RESULTS_NOT_PUBLISHABLE: 409,
  RESULTS_CONFLICT: 409,
};

const FAILURE_MESSAGE: Record<ResultFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  RESULTS_NOT_AVAILABLE: 'Results are not available',
  RESULTS_ALREADY_PUBLISHED: 'These results have already been published',
  RESULTS_NOT_PUBLISHABLE: 'These results cannot be published',
  RESULTS_CONFLICT: 'The results could not be published',
};

/**
 * Translates a domain failure into a typed response.
 *
 * The detail travels in `fields` so a client can act on it — which precondition
 * blocked the publication, and what state the event is actually in — while the
 * `code` remains the contract.
 */
export function resultFailureResponse(failure: ResultFailure, requestId: string): Response {
  const fields: Record<string, string> = {};

  if (failure.code === 'RESULTS_NOT_PUBLISHABLE') {
    fields.blocker = failure.blocker;
    fields.eventStatus = failure.eventStatus;
  } else if (failure.code === 'RESULTS_CONFLICT') {
    fields.reason = failure.reason;
  }

  return error(
    FAILURE_STATUS[failure.code],
    failure.code,
    FAILURE_MESSAGE[failure.code],
    Object.keys(fields).length > 0 ? fields : undefined,
    { requestId },
  );
}

/**
 * Standard headers for an ADMINISTRATIVE results response.
 *
 * `no-store` because these bodies name winners with their email addresses, and
 * a cached copy in a shared browser or an intermediary is a copy nobody agreed
 * to.
 */
export function resultJson(status: number, body: unknown, requestId: string): Response {
  return json(status, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
}

/**
 * Standard headers for the PUBLIC results response.
 *
 * Also `no-store`, and deliberately so for a body that is, by definition,
 * public. A published result is immutable, so caching it would be safe in
 * principle — but the moment a cache sits in front of this endpoint, "is it
 * published yet?" starts being answered by something other than the database,
 * and an unpublished 404 could be served after publication or the reverse.
 * Correctness first; a CDN policy is a decision for a phase that measures it.
 */
export function publicResultJson(
  status: number,
  body: unknown,
  requestId: string,
): Response {
  return json(status, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
}

// HTTP plumbing for the draw endpoint.
//
// Separate from `participantAdminHttp.ts` because the vocabularies are
// different: that one translates administrative refusals about one participant,
// this one translates refusals about an irreversible act on a whole event. One
// table covering both would be a table where a change to either risks the other.
//
// EVERY REFUSAL IS A 409 EXCEPT THE MISSING EVENT. That is not laziness — none
// of them is a malformed request. The body was empty and valid; what was wrong
// was the state of the world, which is exactly what 409 means. A 400 would tell
// an operator to fix their request, and there is nothing in their request to
// fix.

import { error, json } from './responses';
import type { DrawFailure } from './drawService';

const FAILURE_STATUS: Record<DrawFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  DRAW_NOT_READY: 409,
  DRAW_ALREADY_COMPLETED: 409,
  NO_ELIGIBLE_PARTICIPANTS: 409,
  NO_ACTIVE_PRIZES: 409,
  DRAW_POPULATION_CHANGED: 409,
  DRAW_CONFLICT: 409,
};

const FAILURE_MESSAGE: Record<DrawFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  DRAW_NOT_READY: 'This event is not ready to draw',
  DRAW_ALREADY_COMPLETED: 'This event has already been drawn',
  NO_ELIGIBLE_PARTICIPANTS: 'There are no eligible participants to draw from',
  NO_ACTIVE_PRIZES: 'There are no active prizes to award',
  // Phrased as an instruction rather than a diagnosis: the operator's next step
  // is to look at what changed and decide again, not to retry blindly.
  DRAW_POPULATION_CHANGED:
    'The participant list changed while the draw was being prepared',
  DRAW_CONFLICT: 'The draw could not be completed',
};

/**
 * Translates a domain failure into a typed response.
 *
 * The detail travels in `fields` so a client can act on it — the event's
 * current status tells the UI what to show instead of the draw button, without
 * it having to guess from the code alone.
 */
export function drawFailureResponse(failure: DrawFailure, requestId: string): Response {
  const fields: Record<string, string> = {};

  if (failure.code === 'DRAW_NOT_READY') {
    fields.eventStatus = failure.eventStatus;
  } else if (failure.code === 'DRAW_CONFLICT') {
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
 * Standard headers for every draw response.
 *
 * `no-store` is not decoration: these bodies name the people who won something,
 * with their email addresses, and a cached copy in a shared browser or an
 * intermediary is a copy nobody agreed to. It matters more here than anywhere
 * else — a results list is precisely the thing somebody would want to see
 * before it is announced.
 */
export function drawJson(status: number, body: unknown, requestId: string): Response {
  return json(status, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
}

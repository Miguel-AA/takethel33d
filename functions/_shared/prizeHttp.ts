// HTTP plumbing for the prize endpoints.
//
// Keeps handlers to their job — resolve context, require an admin, validate
// both ids, call the service, translate, respond — instead of each one
// re-deriving the failure-to-status mapping.

import { error } from './responses';
import { asUuid } from './ids';
import type { PrizeFailure } from './prizeService';

const FAILURE_STATUS: Record<PrizeFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  PRIZE_NOT_FOUND: 404,
  // The state forbids it, not the request: a conflict, not a bad request.
  PRIZE_EVENT_NOT_EDITABLE: 409,
  PRIZE_CANNOT_BE_EDITED: 409,
  PRIZE_INVALID_STATUS: 409,
  PRIZE_ALREADY_ARCHIVED: 409,
  PRIZE_CANNOT_BE_DELETED: 409,
  PRIZE_LIMIT_REACHED: 409,
  PRIZE_REVISION_CONFLICT: 409,
  PRIZE_REORDER_CONFLICT: 409,
  PRIZE_ORDER_INVALID: 400,
};

const FAILURE_MESSAGE: Record<PrizeFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  PRIZE_NOT_FOUND: 'Prize not found',
  PRIZE_EVENT_NOT_EDITABLE: 'The event state does not allow this change',
  PRIZE_CANNOT_BE_EDITED: 'Those fields cannot be edited in the current state',
  PRIZE_INVALID_STATUS: 'That action is not allowed from the current status',
  PRIZE_ALREADY_ARCHIVED: 'This prize is archived',
  PRIZE_CANNOT_BE_DELETED: 'This prize cannot be deleted',
  PRIZE_LIMIT_REACHED: 'This event has reached its prize limit',
  PRIZE_REVISION_CONFLICT: 'This prize changed since you loaded it',
  PRIZE_REORDER_CONFLICT: 'The prize order changed since you loaded it',
  PRIZE_ORDER_INVALID: 'The submitted order is not valid',
};

/** Translates a domain failure into a typed response. */
export function prizeFailureResponse(failure: PrizeFailure, requestId: string): Response {
  const fields: Record<string, string> = {};

  switch (failure.code) {
    case 'PRIZE_EVENT_NOT_EDITABLE':
      fields.eventStatus = failure.eventStatus;
      fields.capability = failure.capability;
      break;
    case 'PRIZE_CANNOT_BE_EDITED':
      fields.locked = failure.fields.join(',');
      break;
    case 'PRIZE_INVALID_STATUS':
      fields.from = failure.from;
      fields.action = failure.action;
      break;
    case 'PRIZE_CANNOT_BE_DELETED':
      fields.reason = failure.reason;
      break;
    case 'PRIZE_LIMIT_REACHED':
      fields.limit = String(failure.limit);
      break;
    case 'PRIZE_ORDER_INVALID':
      fields.reason = failure.reason;
      break;
    default:
      break;
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
 * Validates both path identifiers.
 *
 * The prize id is only ever used TOGETHER with the event id downstream, which
 * is what prevents a prize from another event being reached by guessing its id.
 */
export function parsePrizePath(
  params: Record<string, string | string[]>,
): { eventId: string; prizeId: string } | null {
  const eventId = asUuid(params.id);
  const prizeId = asUuid(params.prizeId);
  return eventId && prizeId ? { eventId, prizeId } : null;
}

export function parseEventPath(
  params: Record<string, string | string[]>,
): string | null {
  return asUuid(params.id);
}

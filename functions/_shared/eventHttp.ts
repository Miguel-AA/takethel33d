// Shared HTTP plumbing for the event endpoints.
//
// Keeps the handlers to their job — resolve context, require an admin, parse,
// call the service, translate, respond — instead of each one re-deriving the
// mapping from a domain failure to a status code.

import { error, json } from './responses';
import { readJsonBody, PAYLOAD_LIMITS } from './payload';
import { requireAdmin, requireRequestContext, type AdminRequestData } from './context';
import type { EventFailure } from './eventService';
import type { JsonValue } from './json';

/** Status code for each domain failure. */
const FAILURE_STATUS: Record<EventFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  EVENT_SLUG_EXISTS: 409,
  EVENT_SLUG_RESERVED: 400,
  EVENT_INVALID_SLUG: 400,
  EVENT_INVALID_TRANSITION: 409,
  EVENT_INVALID_DATE_RANGE: 400,
  EVENT_REQUIRED_FIELDS_MISSING: 400,
  EVENT_CANNOT_BE_EDITED: 409,
  EVENT_CANNOT_BE_DELETED: 409,
  EVENT_REVISION_CONFLICT: 409,
  EVENT_INVALID_TIMEZONE: 400,
  // The state allows the action; the event's own dates no longer do.
  EVENT_NOT_READY: 409,
  EVENT_DUPLICATE_FAILED: 400,
};

const FAILURE_MESSAGE: Record<EventFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  EVENT_SLUG_EXISTS: 'That slug is already in use',
  EVENT_SLUG_RESERVED: 'That slug is reserved',
  EVENT_INVALID_SLUG: 'That slug is not valid',
  EVENT_INVALID_TRANSITION: 'That action is not allowed from the current state',
  EVENT_INVALID_DATE_RANGE: 'The dates are not in a valid order',
  EVENT_REQUIRED_FIELDS_MISSING: 'Required configuration is missing',
  EVENT_CANNOT_BE_EDITED: 'Those fields cannot be edited in the current state',
  EVENT_CANNOT_BE_DELETED: 'This event cannot be deleted',
  EVENT_REVISION_CONFLICT: 'This event changed since you loaded it',
  EVENT_INVALID_TIMEZONE: 'That timezone is not valid',
  EVENT_NOT_READY: 'The configured dates have already passed for this action',
  EVENT_DUPLICATE_FAILED: 'The event could not be duplicated',
};

/**
 * Translates a domain failure into a typed response.
 *
 * The extra detail travels in `fields` so a client can act on it — which fields
 * are missing, which are frozen — while the `code` remains the contract.
 * `EVENT_INVALID_TIMEZONE` maps onto the existing validation code so no new
 * public code is invented for something the schema layer already names.
 */
export function failureResponse(failure: EventFailure, requestId: string): Response {
  const status = FAILURE_STATUS[failure.code];
  const message = FAILURE_MESSAGE[failure.code];

  const fields: Record<string, string> = {};
  if (failure.code === 'EVENT_REQUIRED_FIELDS_MISSING') {
    fields.missing = failure.fields.join(',');
  } else if (failure.code === 'EVENT_CANNOT_BE_EDITED') {
    fields.locked = failure.fields.join(',');
  } else if (failure.code === 'EVENT_INVALID_DATE_RANGE') {
    fields.detail = failure.detail;
  } else if (failure.code === 'EVENT_INVALID_TRANSITION') {
    fields.from = failure.from;
    fields.action = failure.action;
  } else if (failure.code === 'EVENT_CANNOT_BE_DELETED') {
    fields.reason = failure.reason;
  } else if (failure.code === 'EVENT_DUPLICATE_FAILED') {
    fields.reason = failure.reason;
  } else if (failure.code === 'EVENT_NOT_READY') {
    fields.stale = failure.fields.join(',');
    fields.action = failure.action;
  }

  const code =
    failure.code === 'EVENT_INVALID_TIMEZONE' ? 'VALIDATION_ERROR' : failure.code;

  return error(
    status,
    code,
    message,
    Object.keys(fields).length > 0 ? fields : undefined,
    { requestId },
  );
}

/** Standard headers for every event response. */
export function eventJson(status: number, body: unknown, requestId: string): Response {
  return json(status, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
}

export interface AdminContext {
  admin: ReturnType<typeof requireAdmin>;
  requestContext: ReturnType<typeof requireRequestContext>;
  requestId: string;
}

/** Resolves the authenticated actor and the request context in one step. */
export function adminContext(
  data: AdminRequestData,
  request: Request,
): AdminContext {
  const admin = requireAdmin(data);
  const requestContext = requireRequestContext(data, request);
  return { admin, requestContext, requestId: requestContext.requestId };
}

/**
 * Reads a JSON body for a mutation.
 *
 * Transitions carry no parameters, so `allowEmpty` accepts a request with no
 * body at all and treats it as `{}` — demanding a payload that has nothing in
 * it would be ceremony, not safety. The content-type and size guards still
 * apply whenever a body IS sent.
 */
export async function readEventBody(
  request: Request,
  requestId: string,
  options: { allowEmpty?: boolean } = {},
): Promise<{ ok: true; value: JsonValue } | { ok: false; response: Response }> {
  const hasContentType = (request.headers.get('Content-Type') ?? '').length > 0;
  if (options.allowEmpty && !hasContentType) {
    return { ok: true, value: {} };
  }

  const body = await readJsonBody(request, PAYLOAD_LIMITS.admin, requestId);
  if (body.ok) return body;

  // An empty body with a JSON content type is also acceptable for a parameterless
  // action; anything else (wrong type, too large, malformed) is still refused.
  if (options.allowEmpty && body.response.status === 400) {
    return { ok: true, value: {} };
  }
  return body;
}

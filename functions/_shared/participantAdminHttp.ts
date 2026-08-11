// HTTP plumbing for the participant-administration endpoints.
//
// Keeps handlers to their job — resolve context, validate ids, parse, call the
// service, translate, respond — instead of each one re-deriving the mapping
// from a domain failure to a status code.
//
// Separate from `entryHttp.ts` because the failures are different: that one
// translates the REGISTRATION vocabulary (window closed, answer invalid,
// already entered), this one translates the ADMINISTRATIVE vocabulary
// (revision moved, already disqualified, event no longer editable). One table
// covering both would be a table where a change to either flow risks the other.

import { error, json } from './responses';
import type { ParticipantAdminFailure } from './participantAdministrationService';

const FAILURE_STATUS: Record<ParticipantAdminFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  // An entry from another event answers exactly as one that does not exist.
  // A 403 would confirm it exists somewhere, which is the disclosure the
  // scoping is there to prevent.
  EVENT_ENTRY_NOT_FOUND: 404,
  // The state forbids it, not the request.
  EVENT_PARTICIPANTS_NOT_EDITABLE: 409,
  ENTRY_ALREADY_DISQUALIFIED: 409,
  ENTRY_NOT_DISQUALIFIED: 409,
  ENTRY_REVISION_CONFLICT: 409,
  // A disqualified row with nothing to restore is corrupt data, not a bad
  // request: it cannot have been produced through the application.
  ENTRY_NO_RESTORABLE_STATUS: 409,
  ENTRY_UPDATE_FAILED: 500,
};

const FAILURE_MESSAGE: Record<ParticipantAdminFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  EVENT_ENTRY_NOT_FOUND: 'Entry not found',
  EVENT_PARTICIPANTS_NOT_EDITABLE:
    'Participants cannot be administered while the event is in this state',
  ENTRY_ALREADY_DISQUALIFIED: 'This entry is already disqualified',
  ENTRY_NOT_DISQUALIFIED: 'This entry is not disqualified',
  ENTRY_REVISION_CONFLICT: 'This entry changed since you loaded it',
  ENTRY_NO_RESTORABLE_STATUS: 'This entry has no previous status to return to',
  ENTRY_UPDATE_FAILED: 'The entry could not be updated',
};

/**
 * Translates a domain failure into a typed response.
 *
 * The detail travels in `fields` so a client can act on it — a revision
 * conflict carries the current revision, so the UI can refetch and retry
 * without asking the operator to work out what changed.
 */
export function participantAdminFailureResponse(
  failure: ParticipantAdminFailure,
  requestId: string,
): Response {
  const fields: Record<string, string> = {};

  if (failure.code === 'ENTRY_REVISION_CONFLICT') {
    fields.currentRevision = String(failure.currentRevision);
  } else if (failure.code === 'EVENT_PARTICIPANTS_NOT_EDITABLE') {
    fields.eventStatus = failure.eventStatus;
  } else if (failure.code === 'ENTRY_UPDATE_FAILED') {
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
 * Standard headers for every participant-administration response.
 *
 * `no-store` is not decoration: these bodies carry names, email addresses,
 * phone numbers, dates of birth and answers, and a cached copy in a shared
 * browser or an intermediary is a copy nobody agreed to.
 */
export function participantAdminJson(
  status: number,
  body: unknown,
  requestId: string,
): Response {
  return json(status, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
}

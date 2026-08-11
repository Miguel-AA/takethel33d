// HTTP plumbing for the participant endpoints.
//
// Keeps handlers to their job — resolve context, validate ids, parse, call the
// service, translate, respond — instead of each one re-deriving the mapping
// from a domain failure to a status code.

import { error, json } from './responses';
import type { EntryFailure } from './participantRegistrationService';

const FAILURE_STATUS: Record<EntryFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  EVENT_ENTRY_NOT_FOUND: 404,
  // The state forbids it, not the request.
  EVENT_NOT_ACCEPTING_ENTRIES: 409,
  PARTICIPANT_ALREADY_ENTERED: 409,
  PARTICIPANT_IDENTITY_CONFLICT: 409,
  // Produced only by the public flow's identity gate; the administrative
  // endpoint installs none and can never reach it.
  ENTRY_RATE_LIMITED: 429,
  // The rules the decision was computed from were edited mid-flight. A retry
  // with the current configuration is the right answer, so it is a conflict.
  EVENT_REGISTRATION_CONFIG_CHANGED: 409,
  // The event is not ready to receive anyone: no published form to fill in.
  FORM_VERSION_REQUIRED: 409,
  // A date of birth that is impossible, in the future, or older than anybody
  // has ever been. INVALID INPUT — not somebody who failed an age rule, who is
  // recorded as an ineligible participation instead.
  DATE_OF_BIRTH_INVALID: 400,
  DATE_OF_BIRTH_REQUIRED: 422,
  // These describe a payload that does not answer this form.
  DUPLICATE_FORM_ANSWER: 400,
  FORM_ANSWER_UNKNOWN_QUESTION: 400,
  FORM_ANSWER_NOT_ALLOWED: 400,
  FORM_ANSWER_INVALID: 400,
  // The request was well formed; the submission is incomplete.
  FORM_REQUIRED_ANSWER_MISSING: 422,
  // Something is wrong with stored data, not with the caller.
  FORM_VERSION_INVALID: 500,
  ENTRY_CREATE_FAILED: 500,
};

const FAILURE_MESSAGE: Record<EntryFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  EVENT_ENTRY_NOT_FOUND: 'Entry not found',
  EVENT_NOT_ACCEPTING_ENTRIES: 'This event is not accepting entries',
  PARTICIPANT_ALREADY_ENTERED: 'This person has already entered this event',
  PARTICIPANT_IDENTITY_CONFLICT: 'This email is already registered with different details',
  ENTRY_RATE_LIMITED: 'Too many attempts; please try again later',
  EVENT_REGISTRATION_CONFIG_CHANGED: 'This event’s registration rules changed; please try again',
  FORM_VERSION_REQUIRED: 'This event has no published form to fill in',
  DATE_OF_BIRTH_INVALID: 'That date of birth is not a possible one',
  DATE_OF_BIRTH_REQUIRED: 'This event requires a date of birth',
  DUPLICATE_FORM_ANSWER: 'The same question was answered twice',
  FORM_ANSWER_UNKNOWN_QUESTION: 'That question is not part of this form',
  FORM_ANSWER_NOT_ALLOWED: 'That question does not take an answer',
  FORM_ANSWER_INVALID: 'One or more answers are not valid',
  FORM_REQUIRED_ANSWER_MISSING: 'A required question was not answered',
  FORM_VERSION_INVALID: 'The published form could not be read',
  ENTRY_CREATE_FAILED: 'The entry could not be recorded',
};

/**
 * Translates a domain failure into a typed response.
 *
 * The detail travels in `fields` so a client can point at the right input,
 * while the `code` stays the contract. Question IDS are safe to return: the
 * caller just sent them, and they are only meaningful against a form the caller
 * is already looking at. Nothing here echoes an ANSWER back — a validation
 * message is not a place to reflect somebody's personal data.
 */
export function entryFailureResponse(failure: EntryFailure, requestId: string): Response {
  const fields: Record<string, string> = {};

  switch (failure.code) {
    case 'EVENT_NOT_ACCEPTING_ENTRIES':
      fields.reason = failure.reason;
      break;
    case 'FORM_VERSION_REQUIRED':
      fields.reason = failure.reason;
      break;
    case 'FORM_VERSION_INVALID':
    case 'ENTRY_CREATE_FAILED':
      fields.reason = failure.reason;
      break;
    case 'PARTICIPANT_IDENTITY_CONFLICT':
      fields.field = failure.field;
      break;
    case 'DATE_OF_BIRTH_INVALID':
      // Why it is impossible, never the value itself.
      fields.problem = failure.problem;
      break;
    case 'PARTICIPANT_ALREADY_ENTERED':
      if (failure.entryId) fields.entryId = failure.entryId;
      break;
    case 'DUPLICATE_FORM_ANSWER':
    case 'FORM_ANSWER_UNKNOWN_QUESTION':
      fields.questions = failure.questionIds.join(',');
      break;
    case 'FORM_ANSWER_NOT_ALLOWED':
      fields.questions = failure.questionIds.join(',');
      fields.reason = failure.reason;
      break;
    case 'FORM_ANSWER_INVALID':
      // `questionId:PROBLEM`, so a client can mark the exact input and say why.
      fields.answers = failure.answers
        .map((answer) => `${answer.questionId}:${answer.problem}`)
        .join(',');
      break;
    case 'FORM_REQUIRED_ANSWER_MISSING':
      fields.questions = failure.questions.map((question) => question.questionId).join(',');
      fields.keys = failure.questions.map((question) => question.questionKey).join(',');
      break;
    default:
      break;
  }

  if (failure.code === 'ENTRY_RATE_LIMITED') {
    fields.retryAfter = String(failure.retryAfterSeconds);
  }

  // One internal code maps onto an existing public one rather than inventing a
  // second name for the same condition — the same move `eventHttp` makes for
  // EVENT_INVALID_TIMEZONE. `ENTRY_RATE_LIMITED` names WHERE the refusal came
  // from; `RATE_LIMITED` is what a client acts on.
  const code = failure.code === 'ENTRY_RATE_LIMITED' ? 'RATE_LIMITED' : failure.code;

  return error(
    FAILURE_STATUS[failure.code],
    code,
    FAILURE_MESSAGE[failure.code],
    Object.keys(fields).length > 0 ? fields : undefined,
    { requestId },
  );
}

/**
 * Standard headers for every participant response.
 *
 * `no-store` is not decoration here: these bodies carry names, email addresses,
 * phone numbers and dates of birth, and a cached copy in a shared browser or an
 * intermediary is a copy nobody agreed to.
 */
export function entryJson(status: number, body: unknown, requestId: string): Response {
  return json(status, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
}

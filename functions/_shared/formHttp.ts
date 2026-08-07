// HTTP plumbing for the form builder endpoints.
//
// Keeps handlers to their job — resolve context, validate ids, parse, call the
// service, translate, respond — instead of each one re-deriving the mapping
// from a domain failure to a status code.

import { error } from './responses';
import { asUuid } from './ids';
import type { FormFailure } from './formDraftService';
import type { PublishFailure } from './formPublishingService';

const FAILURE_STATUS: Record<FormFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  FORM_DRAFT_NOT_FOUND: 404,
  FORM_STEP_NOT_FOUND: 404,
  FORM_QUESTION_NOT_FOUND: 404,
  FORM_OPTION_NOT_FOUND: 404,
  // The state forbids it, not the request: a conflict, not a bad request.
  FORM_NOT_EDITABLE: 409,
  FORM_REVISION_CONFLICT: 409,
  FORM_STEP_NOT_EMPTY: 409,
  FORM_QUESTION_PROTECTED: 409,
  FORM_KEY_EXISTS: 409,
  FORM_SYSTEM_FIELD_EXISTS: 409,
  FORM_LIMIT_REACHED: 409,
  // These are malformed requests: the payload does not describe a coherent form.
  FORM_QUESTION_INVALID: 400,
  FORM_OPTION_NOT_ALLOWED: 400,
  FORM_ORDER_INVALID: 400,
};

const FAILURE_MESSAGE: Record<FormFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  FORM_DRAFT_NOT_FOUND: 'This event has no form draft',
  FORM_STEP_NOT_FOUND: 'Step not found',
  FORM_QUESTION_NOT_FOUND: 'Question not found',
  FORM_OPTION_NOT_FOUND: 'Option not found',
  FORM_NOT_EDITABLE: 'The event state does not allow editing the form',
  FORM_REVISION_CONFLICT: 'This form changed since you loaded it',
  FORM_STEP_NOT_EMPTY: 'Only an empty step can be removed',
  FORM_QUESTION_PROTECTED: 'That change is not allowed on this question',
  FORM_KEY_EXISTS: 'Another question already uses that key',
  FORM_SYSTEM_FIELD_EXISTS: 'That system field is already on this form',
  FORM_LIMIT_REACHED: 'This form has reached its limit',
  FORM_QUESTION_INVALID: 'That configuration is not valid for this question type',
  FORM_OPTION_NOT_ALLOWED: 'This question type does not take options',
  FORM_ORDER_INVALID: 'The submitted order is not valid',
};

/** Translates a domain failure into a typed response. */
export function formFailureResponse(failure: FormFailure, requestId: string): Response {
  const fields: Record<string, string> = {};

  switch (failure.code) {
    case 'FORM_NOT_EDITABLE':
      fields.eventStatus = failure.eventStatus;
      break;
    case 'FORM_STEP_NOT_EMPTY':
      fields.questions = String(failure.questions);
      break;
    case 'FORM_QUESTION_PROTECTED':
      fields.reason = failure.reason;
      break;
    case 'FORM_QUESTION_INVALID':
      fields.reason = failure.reason;
      break;
    case 'FORM_OPTION_NOT_ALLOWED':
      fields.type = failure.type;
      break;
    case 'FORM_KEY_EXISTS':
      if (failure.key) fields.key = failure.key;
      break;
    case 'FORM_SYSTEM_FIELD_EXISTS':
      if (failure.systemField) fields.systemField = failure.systemField;
      break;
    case 'FORM_LIMIT_REACHED':
      fields.scope = failure.scope;
      fields.limit = String(failure.limit);
      break;
    case 'FORM_ORDER_INVALID':
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
 * Validates the path identifiers a form endpoint needs.
 *
 * Every id downstream is used TOGETHER with the ones above it — a question is
 * only ever resolved through its form, an option only through its question —
 * which is what stops another event's form being reached by guessing an id.
 */
export function parseFormPath(
  params: Record<string, string | string[]>,
  ...names: Array<'id' | 'stepId' | 'questionId' | 'optionId'>
): Record<string, string> | null {
  const resolved: Record<string, string> = {};
  for (const name of names) {
    const value = asUuid(params[name]);
    if (!value) return null;
    resolved[name] = value;
  }
  return resolved;
}

/** Turns Zod issues into the per-field detail the builder renders inline. */
export function validationFields(issues: Array<{ path: PropertyKey[]; message: string }>) {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const key = issue.path.map(String).join('.') || 'body';
    fields[key] = issue.message;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

const PUBLISH_STATUS: Record<PublishFailure['code'], number> = {
  EVENT_NOT_FOUND: 404,
  FORM_DRAFT_NOT_FOUND: 404,
  FORM_VERSION_NOT_FOUND: 404,
  // The state forbids it, not the request.
  FORM_DRAFT_REVISION_CONFLICT: 409,
  FORM_NO_UNPUBLISHED_CHANGES: 409,
  FORM_VERSION_NUMBER_CONFLICT: 409,
  // The draft is not ready; the request itself was well formed.
  FORM_DRAFT_NOT_PUBLISHABLE: 422,
  // Something is wrong with stored data, not with the caller.
  FORM_VERSION_INVALID: 500,
  FORM_PUBLISH_FAILED: 500,
};

const PUBLISH_MESSAGE: Record<PublishFailure['code'], string> = {
  EVENT_NOT_FOUND: 'Event not found',
  FORM_DRAFT_NOT_FOUND: 'This event has no form draft',
  FORM_VERSION_NOT_FOUND: 'Version not found',
  FORM_DRAFT_REVISION_CONFLICT: 'The form changed since you reviewed it',
  FORM_NO_UNPUBLISHED_CHANGES: 'There is nothing new to publish',
  FORM_VERSION_NUMBER_CONFLICT: 'Another publication happened first',
  FORM_DRAFT_NOT_PUBLISHABLE: 'This form is not ready to be published',
  FORM_VERSION_INVALID: 'This version could not be read',
  FORM_PUBLISH_FAILED: 'The form could not be published',
};

export function publishFailureResponse(
  failure: PublishFailure,
  requestId: string,
): Response {
  const fields: Record<string, string> = {};
  switch (failure.code) {
    case 'FORM_DRAFT_NOT_PUBLISHABLE':
      fields.issues = String(failure.issues);
      break;
    case 'FORM_NO_UNPUBLISHED_CHANGES':
      fields.versionNumber = String(failure.versionNumber);
      break;
    case 'FORM_VERSION_INVALID':
      fields.reason = failure.reason;
      break;
    case 'FORM_PUBLISH_FAILED':
      fields.reason = failure.reason;
      break;
    default:
      break;
  }

  return error(
    PUBLISH_STATUS[failure.code],
    failure.code,
    PUBLISH_MESSAGE[failure.code],
    Object.keys(fields).length > 0 ? fields : undefined,
    { requestId },
  );
}

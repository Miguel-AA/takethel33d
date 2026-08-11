// The boundary between what the server knows and what a stranger is told.
//
// This module exists because the administrative translation in `entryHttp.ts`
// is WRONG for the public flow, and not by a little. That one is written for an
// authenticated operator who is entitled to know why something failed: it
// returns the entry id of a duplicate, names `dateOfBirth` as the field that
// conflicted, and passes internal `reason` strings straight through. Every one
// of those is a disclosure to somebody who has proved nothing.
//
// The rule here: an unauthenticated caller learns what THEY need to do next,
// and nothing about anybody else. Concretely —
//
//   * every way a token can be wrong collapses to one code. Distinguishing
//     "expired" from "bad signature" tells an attacker whether their forgery
//     was structurally right, which is the feedback loop that makes forging
//     signatures tractable;
//
//   * a duplicate does not carry the entry id. Returning it would let anybody
//     who guesses an address harvest identifiers for real participations;
//
//   * an identity conflict does not name the field. "The date of birth we hold
//     differs" is an oracle for the stored date of birth of any address an
//     attacker cares to try;
//
//   * every corruption of stored data becomes one unavailability code. A
//     visitor cannot act on `system_fields` or `event_timezone`, and an
//     attacker should not learn which internal invariant broke.
//
// `entryHttp.ts` is untouched: it serves the administrative endpoint and is
// certified. Two audiences, two translations.

import { error, json } from './responses';
import { logger } from './logger';
import type { EntryFailure } from './participantRegistrationService';
import type { FormTokenFailure } from './publicFormToken';
import type { PublicSafeError } from '../../shared/publicEvent';

/** What a public refusal looks like on the wire. */
interface PublicRefusal {
  status: number;
  code: PublicSafeError;
  message: string;
  /** Seconds, for a 429 only. */
  retryAfterSeconds?: number;
}

const MESSAGES: Record<PublicSafeError, string> = {
  PUBLIC_EVENT_NOT_FOUND: 'This event could not be found',
  PUBLIC_EVENT_UNAVAILABLE: 'This event is not available right now',
  PUBLIC_EVENT_NOT_OPEN: 'This event is not accepting entries',
  INVALID_FORM_SESSION: 'This form session is no longer valid; please reload the page',
  ALREADY_ENTERED: 'An entry already exists for this email address',
  ENTRY_INFORMATION_CONFLICT: 'The details provided do not match an existing entry',
  RATE_LIMITED: 'Too many attempts; please try again shortly',
};

/**
 * Standard headers for every public response.
 *
 * `no-store` on BOTH verbs, and not as ceremony. The GET body carries a form
 * token with a two-hour life and a status derived from the current instant; a
 * copy held by a shared browser or an intermediary would hand the next visitor
 * a stale token and a status that may since have changed to CLOSED. The POST
 * body describes one person's eligibility and must never be cached anywhere.
 */
export function publicJson(status: number, body: unknown, requestId: string): Response {
  return json(status, body, [
    ['Cache-Control', 'no-store'],
    ['X-Request-ID', requestId],
  ]);
}

export function publicError(refusal: PublicRefusal, requestId: string): Response {
  const headers: Array<[string, string]> = [['Cache-Control', 'no-store']];
  if (refusal.retryAfterSeconds !== undefined) {
    // Retry-After is the ONE quantity a rate-limited caller is told. The bucket
    // that fired, its ceiling and its current count all stay private: knowing
    // which limit was hit tells an attacker which axis to vary.
    headers.push(['Retry-After', String(Math.max(1, refusal.retryAfterSeconds))]);
  }

  return error(refusal.status, refusal.code, refusal.message, undefined, {
    requestId,
    headers,
  });
}

/** Builds a refusal from a public code alone. */
export function refusal(
  code: PublicSafeError,
  status: number,
  retryAfterSeconds?: number,
): PublicRefusal {
  return { status, code, message: MESSAGES[code], retryAfterSeconds };
}

/**
 * Collapses every token failure into one public answer.
 *
 * The internal reason is LOGGED — an operator investigating a spike needs to
 * know whether they are seeing expired sessions or forgery attempts — and is
 * never returned. `SECRET_MISSING` is the exception in kind: it is a
 * deployment fault rather than a caller's, so it reports unavailability rather
 * than an invalid session, because telling somebody to reload a page will not
 * help when the server has no secret.
 */
export function tokenRefusal(
  reason: FormTokenFailure,
  requestId: string,
  eventSlug: string,
): PublicRefusal {
  if (reason === 'SECRET_MISSING') {
    logger.error('public form token secret is not configured', {
      requestId,
      action: 'PUBLIC_FORM_TOKEN_SECRET_MISSING',
      eventSlug,
    });
    return refusal('PUBLIC_EVENT_UNAVAILABLE', 503);
  }

  logger.warn('public form token rejected', {
    requestId,
    action: 'PUBLIC_FORM_TOKEN_REJECTED',
    // The REASON only. Never the token itself — `redact` would catch a field
    // named `token`, but the right habit is not to hand it over at all.
    reason,
    eventSlug,
  });
  return refusal('INVALID_FORM_SESSION', 400);
}

/**
 * Maps an internal registration failure onto its public answer.
 *
 * The list is exhaustive over `EntryFailure` so that a code added to the domain
 * later cannot silently fall through to a default and leak whatever detail it
 * carries — the compiler will demand a decision here.
 */
export function registrationRefusal(
  failure: EntryFailure,
  requestId: string,
): PublicRefusal {
  switch (failure.code) {
    case 'PARTICIPANT_ALREADY_ENTERED':
      // Without `entryId`. The administrative response includes it; this one
      // must not.
      return refusal('ALREADY_ENTERED', 409);

    case 'PARTICIPANT_IDENTITY_CONFLICT':
      // Without `field`. Naming `dateOfBirth` would confirm both that the
      // address is registered and what value is held against it.
      return refusal('ENTRY_INFORMATION_CONFLICT', 409);

    case 'ENTRY_RATE_LIMITED':
      return refusal('RATE_LIMITED', 429, failure.retryAfterSeconds);

    case 'EVENT_NOT_ACCEPTING_ENTRIES':
      // The three window reasons are genuinely for the visitor — "not started",
      // "closed", "not open" are all things a person needs to be told — but the
      // page re-renders from the GET, so one code with a reloadable state is
      // enough and avoids a second vocabulary.
      return refusal('PUBLIC_EVENT_NOT_OPEN', 409);

    case 'EVENT_REGISTRATION_CONFIG_CHANGED':
      // The rules moved under a submission in flight. A reload is the correct
      // remedy and the visitor can act on it.
      return refusal('INVALID_FORM_SESSION', 409);

    case 'EVENT_NOT_FOUND':
      return refusal('PUBLIC_EVENT_NOT_FOUND', 404);

    // Answer-shaped problems. These describe the caller's own payload against a
    // form they are looking at, so they are safe — but the public flow validates
    // client-side against the same shared rules, so reaching one means either a
    // stale page or a hand-crafted request. One generic code keeps the public
    // vocabulary small; the wizard re-validates and shows per-field messages.
    case 'DUPLICATE_FORM_ANSWER':
    case 'FORM_ANSWER_UNKNOWN_QUESTION':
    case 'FORM_ANSWER_NOT_ALLOWED':
    case 'FORM_ANSWER_INVALID':
    case 'FORM_REQUIRED_ANSWER_MISSING':
    case 'DATE_OF_BIRTH_INVALID':
    case 'DATE_OF_BIRTH_REQUIRED':
      return refusal('INVALID_FORM_SESSION', 400);

    // Stored data is not what it should be. A visitor can do nothing about any
    // of these, and which invariant broke is not their business.
    case 'FORM_VERSION_REQUIRED':
    case 'FORM_VERSION_INVALID':
    case 'EVENT_ENTRY_NOT_FOUND':
    case 'ENTRY_CREATE_FAILED':
      logger.error('public submission failed on stored data', {
        requestId,
        action: 'PUBLIC_SUBMISSION_UNAVAILABLE',
        code: failure.code,
      });
      return refusal('PUBLIC_EVENT_UNAVAILABLE', 503);
  }
}

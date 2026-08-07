// Deciding whether a participation counts.
//
// SEPARATE from `ParticipantRegistrationService` on purpose. Registration is
// about identity, answers and persistence; this is about a DECISION. Mixing
// them would mean the rule that excludes somebody lives inside the code that
// writes them down, and changing one would silently change the other.
//
// The service is deliberately thin and pure-ish: it reads the rules off the
// event and the version it is handed, asks `shared/eligibility` for the answer,
// and returns it. It writes nothing. Persistence — atomically, in the same
// batch that creates the entry — belongs to the caller, because an entry must
// be BORN decided rather than created and then judged.
//
// WHAT IS NOT A RULE HERE: the answers to custom questions. A client asked for
// "do you smoke?" and "do you drink?"; those are data about a person, not
// grounds for exclusion, and hardcoding either into this file would silently
// disqualify people on a basis nobody agreed to.

import type { Event, FormStep } from '../../shared/types';
import {
  civilDateInEventZone,
  evaluateAgeEligibility,
  type EligibilityDecision,
  type EligibilityOutcome,
} from '../../shared/eligibility';
import { isValidTimeZone } from '../../shared/timezone';
import { logger } from './logger';

export type EligibilityFailure =
  | { code: 'DATE_OF_BIRTH_REQUIRED' }
  | { code: 'DATE_OF_BIRTH_INVALID'; problem: string }
  | { code: 'FORM_INVALID'; reason: string }
  | { code: 'EVENT_TIMEZONE_INVALID' };

export type EligibilityResult =
  | { ok: true; decision: EligibilityDecision; referenceCivilDate: string }
  | { ok: false; failure: EligibilityFailure };

/** Everything the decision is made from, gathered by the caller. */
export interface EligibilityInput {
  /** The event as it was read AND as the batch guard will re-confirm it. */
  event: Pick<Event, 'id' | 'minimumAge' | 'timezone'>;
  /** The frozen structure the submission was validated against. */
  versionSteps: readonly FormStep[];
  /** The value extracted from the answers, if the form asked. */
  dateOfBirth: string | null;
  /** The one instant the whole operation reasons about. */
  now: Date;
}

export class EligibilityService {
  /**
   * Decides.
   *
   * Everything it needs is passed in, so the decision is a pure function of its
   * inputs and can be reproduced exactly from the row it produces — which is
   * what makes "why was this person excluded?" answerable a year later.
   */
  evaluate(input: EligibilityInput): EligibilityResult {
    const { event, versionSteps, dateOfBirth, now } = input;

    // A zone the runtime cannot resolve would silently become UTC in most
    // implementations, and UTC is a different day from New York for five hours
    // every night. Refused loudly rather than defaulted quietly.
    if (!isValidTimeZone(event.timezone)) {
      logger.error('event carries a timezone this runtime cannot resolve', {
        action: 'EVENT_TIMEZONE_INVALID',
        eventId: event.id,
      });
      return { ok: false, failure: { code: 'EVENT_TIMEZONE_INVALID' } };
    }

    // What day is it WHERE THE EVENT IS. Resolved once, from the operation's
    // single instant, so a submission that straddles local midnight cannot be
    // judged against two different days.
    const referenceCivilDate = civilDateInEventZone(now, event.timezone);

    const outcome = evaluateAgeEligibility({
      minimumAge: event.minimumAge,
      dateOfBirth,
      formAsksForDateOfBirth: formAsksForDateOfBirth(versionSteps),
      referenceCivilDate,
    });

    return this.translate(outcome, referenceCivilDate, event.id);
  }

  private translate(
    outcome: EligibilityOutcome,
    referenceCivilDate: string,
    eventId: string,
  ): EligibilityResult {
    if (outcome.kind === 'decided') {
      return { ok: true, decision: outcome.decision, referenceCivilDate };
    }

    switch (outcome.reasonCode) {
      case 'DATE_OF_BIRTH_INVALID':
        return {
          ok: false,
          failure: { code: 'DATE_OF_BIRTH_INVALID', problem: outcome.problem ?? 'INVALID' },
        };
      case 'DATE_OF_BIRTH_REQUIRED':
        return { ok: false, failure: { code: 'DATE_OF_BIRTH_REQUIRED' } };
      case 'FORM_INVALID':
        // Publishing guarantees the question is there whenever the event has a
        // minimum age, so this means the stored version is not what publishing
        // would have produced.
        logger.error('published version cannot support the event’s age rule', {
          action: 'FORM_VERSION_AGE_RULE_UNSUPPORTED',
          eventId,
        });
        return { ok: false, failure: { code: 'FORM_INVALID', reason: 'no_date_of_birth' } };
    }
  }
}

/**
 * Whether the frozen form even asks when somebody was born.
 *
 * Read off the VERSION, never off the draft: the question is whether the form
 * THIS PERSON FILLED IN asked, not whether the one an operator is editing does.
 */
export function formAsksForDateOfBirth(steps: readonly FormStep[]): boolean {
  return steps.some((step) =>
    step.questions.some(
      (question) => question.systemField === 'DATE_OF_BIRTH' && question.active,
    ),
  );
}

// How old somebody is, and what that means — as pure arithmetic.
//
// Every case here is fixed in time on purpose. Nothing calls a clock, nothing
// mocks one, and every expectation is a number somebody can check on a
// calendar. That is the whole point of keeping the age calculation pure: a
// decision made two years ago has to be reproducible from the row it produced.

import { describe, expect, it } from 'vitest';
import {
  LEAP_DAY_BIRTHDAY_FALLS_ON,
  MAX_REASONABLE_AGE,
  birthdayInYear,
  calculateAgeOnDate,
  civilDateInEventZone,
  evaluateAgeEligibility,
  isPersistableReason,
  resolveAge,
  statusForDecision,
  ELIGIBILITY_REASON_CODES,
} from '../shared/eligibility';

const age = (dob: string, on: string) => calculateAgeOnDate(dob, on);

// ---------------------------------------------------------------------------
describe('the age of a person on a day', () => {
  it('counts whole years, not fractions of one', () => {
    expect(age('2005-08-07', '2026-08-07')).toBe(21);
    expect(age('2005-08-07', '2026-12-31')).toBe(21);
    expect(age('2005-08-07', '2027-01-01')).toBe(21);
    expect(age('2005-08-07', '2027-08-07')).toBe(22);
  });

  it('turns over ON the birthday, not the day after', () => {
    // The single most consequential comparison in the whole phase: one day
    // either side of this is somebody being told they may or may not take part.
    expect(age('2005-08-08', '2026-08-07')).toBe(20);
    expect(age('2005-08-08', '2026-08-08')).toBe(21);
    expect(age('2005-08-08', '2026-08-09')).toBe(21);
  });

  it('handles the ends of the year', () => {
    expect(age('2000-01-01', '2026-01-01')).toBe(26);
    expect(age('2000-01-01', '2025-12-31')).toBe(25);
    expect(age('2000-12-31', '2026-12-30')).toBe(25);
    expect(age('2000-12-31', '2026-12-31')).toBe(26);
  });

  it('is zero on the day somebody is born, and stays zero for a year', () => {
    expect(age('2026-08-07', '2026-08-07')).toBe(0);
    expect(age('2026-08-07', '2027-08-06')).toBe(0);
    expect(age('2026-08-07', '2027-08-07')).toBe(1);
  });

  it('goes negative for a date in the future, rather than clamping to zero', () => {
    // Clamping would hide the bad input behind a plausible number; the caller
    // needs to be able to tell "newborn" from "not born yet".
    expect(age('2027-01-01', '2026-08-07')).toBe(-1);
  });

  it('reaches the far end of the range', () => {
    expect(age('1896-08-07', '2026-08-07')).toBe(130);
    expect(age('1895-08-07', '2026-08-07')).toBe(131);
  });

  it('refuses a day that is not a real one, rather than guessing', () => {
    expect(age('2025-02-29', '2026-08-07')).toBeNull();
    expect(age('2005-13-01', '2026-08-07')).toBeNull();
    expect(age('2005-08-07', 'not-a-date')).toBeNull();
    expect(age('2005-08-07T00:00:00.000Z', '2026-08-07')).toBeNull();
  });

  it('never divides milliseconds by a year', () => {
    // A duration-based calculation drifts by a day for every leap year in
    // between. Across a 40-year span it is simply wrong.
    expect(age('1984-02-29', '2024-02-29')).toBe(40);
    expect(age('1900-03-01', '2000-03-01')).toBe(100);
  });
});

// ---------------------------------------------------------------------------
describe('somebody born on 29 February', () => {
  it('has their birthday on 1 March in a common year — one documented policy', () => {
    expect(LEAP_DAY_BIRTHDAY_FALLS_ON).toBe('MARCH_1');
    expect(birthdayInYear('2004-02-29', 2025)).toEqual({ month: 3, day: 1 });
    expect(birthdayInYear('2004-02-29', 2028)).toEqual({ month: 2, day: 29 });
    // Everybody else is unaffected.
    expect(birthdayInYear('2004-03-01', 2025)).toEqual({ month: 3, day: 1 });
  });

  it('is NOT yet a year older on 28 February of a common year', () => {
    // The conservative reading. For an age RESTRICTION the other choice would
    // admit somebody a day before the calendar supports it.
    expect(age('2004-02-29', '2025-02-28')).toBe(20);
    expect(age('2004-02-29', '2025-03-01')).toBe(21);
  });

  it('turns over on the day itself in a leap year', () => {
    expect(age('2004-02-29', '2028-02-28')).toBe(23);
    expect(age('2004-02-29', '2028-02-29')).toBe(24);
  });

  it('applies the century rule for leap years', () => {
    // 1900 was not a leap year; 2000 was.
    expect(birthdayInYear('1996-02-29', 1900)).toEqual({ month: 3, day: 1 });
    expect(birthdayInYear('1996-02-29', 2000)).toEqual({ month: 2, day: 29 });
  });
});

// ---------------------------------------------------------------------------
describe('what day it is where the event is', () => {
  it('answers with the event’s calendar, not UTC', () => {
    // 03:30 UTC on the 8th is still the 7th in New York and already the 8th in
    // Tokyo. An age computed in UTC would be wrong for five hours every night.
    const instant = new Date('2026-08-08T03:30:00.000Z');
    expect(civilDateInEventZone(instant, 'UTC')).toBe('2026-08-08');
    expect(civilDateInEventZone(instant, 'America/New_York')).toBe('2026-08-07');
    expect(civilDateInEventZone(instant, 'America/Los_Angeles')).toBe('2026-08-07');
    expect(civilDateInEventZone(instant, 'Asia/Tokyo')).toBe('2026-08-08');
    expect(civilDateInEventZone(instant, 'Pacific/Kiritimati')).toBe('2026-08-08');
  });

  it('changes an ANSWER, not just a label', () => {
    // The same submission, the same person: a day younger in New York.
    const instant = new Date('2026-08-08T03:30:00.000Z');
    const dob = '2005-08-08';
    expect(age(dob, civilDateInEventZone(instant, 'Asia/Tokyo'))).toBe(21);
    expect(age(dob, civilDateInEventZone(instant, 'America/New_York'))).toBe(20);
  });

  it('survives both DST transitions', () => {
    // Spring forward: 2026-03-08 02:00 local in New York does not exist.
    expect(civilDateInEventZone(new Date('2026-03-08T06:59:00.000Z'), 'America/New_York')).toBe(
      '2026-03-08',
    );
    expect(civilDateInEventZone(new Date('2026-03-08T07:01:00.000Z'), 'America/New_York')).toBe(
      '2026-03-08',
    );
    // Fall back: 2026-11-01 01:00 local happens twice. Both are the 1st.
    expect(civilDateInEventZone(new Date('2026-11-01T05:30:00.000Z'), 'America/New_York')).toBe(
      '2026-11-01',
    );
    expect(civilDateInEventZone(new Date('2026-11-01T06:30:00.000Z'), 'America/New_York')).toBe(
      '2026-11-01',
    );
  });

  it('midnight local is where the day turns, in each zone', () => {
    const justBefore = new Date('2026-08-08T03:59:59.999Z');
    const justAfter = new Date('2026-08-08T04:00:00.000Z');
    expect(civilDateInEventZone(justBefore, 'America/New_York')).toBe('2026-08-07');
    expect(civilDateInEventZone(justAfter, 'America/New_York')).toBe('2026-08-08');
  });
});

// ---------------------------------------------------------------------------
describe('establishing an age, or saying why not', () => {
  const ON = '2026-08-07';

  it('tells the four failures apart', () => {
    expect(resolveAge(null, ON)).toEqual({ ok: false, problem: 'MISSING' });
    expect(resolveAge('2025-02-29', ON)).toEqual({ ok: false, problem: 'INVALID' });
    expect(resolveAge('2027-01-01', ON)).toEqual({ ok: false, problem: 'IN_FUTURE' });
    expect(resolveAge('1800-01-01', ON)).toEqual({ ok: false, problem: 'IMPLAUSIBLE' });
    expect(resolveAge('2005-08-07', ON)).toEqual({ ok: true, age: 21 });
  });

  it('draws the plausibility line exactly at the documented maximum', () => {
    expect(MAX_REASONABLE_AGE).toBe(130);
    expect(resolveAge('1896-08-07', ON)).toEqual({ ok: true, age: 130 });
    expect(resolveAge('1895-08-07', ON)).toEqual({ ok: false, problem: 'IMPLAUSIBLE' });
  });

  it('a newborn is a real age, not a rounding error', () => {
    expect(resolveAge('2026-08-07', ON)).toEqual({ ok: true, age: 0 });
  });
});

// ---------------------------------------------------------------------------
describe('the age rule', () => {
  const ON = '2026-08-07';
  const asks = { formAsksForDateOfBirth: true, referenceCivilDate: ON };

  it('passes somebody who is exactly old enough', () => {
    const outcome = evaluateAgeEligibility({
      minimumAge: 21,
      dateOfBirth: '2005-08-07',
      ...asks,
    });
    expect(outcome).toEqual({
      kind: 'decided',
      decision: {
        calculatedAge: 21,
        ageEligible: true,
        overallEligible: true,
        reasonCode: 'ELIGIBLE',
      },
    });
  });

  it('RECORDS somebody who is too young rather than refusing them', () => {
    // The client needs to see who tried and why they were excluded. Refusing
    // the submission would leave no trace of them at all.
    const outcome = evaluateAgeEligibility({
      minimumAge: 21,
      dateOfBirth: '2005-08-08',
      ...asks,
    });
    expect(outcome).toEqual({
      kind: 'decided',
      decision: {
        calculatedAge: 20,
        ageEligible: false,
        overallEligible: false,
        reasonCode: 'AGE_REQUIREMENT_NOT_MET',
      },
    });
  });

  it('treats a minimum age of ZERO as a rule, not as no rule', () => {
    // `if (event.minimumAge)` would silently discard this, leaving an event
    // that genuinely asked looking as though it never did.
    const outcome = evaluateAgeEligibility({
      minimumAge: 0,
      dateOfBirth: '2026-08-07',
      ...asks,
    });
    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') throw new Error('unreachable');
    expect(outcome.decision.ageEligible).toBe(true);
    expect(outcome.decision.calculatedAge).toBe(0);
  });

  it('with NO age rule, records the age but judges nothing', () => {
    const outcome = evaluateAgeEligibility({
      minimumAge: null,
      dateOfBirth: '2005-08-07',
      ...asks,
    });
    expect(outcome.kind).toBe('decided');
    if (outcome.kind !== 'decided') throw new Error('unreachable');
    expect(outcome.decision.calculatedAge).toBe(21);
    // NULL, not true. Nobody decided anything about this person's age.
    expect(outcome.decision.ageEligible).toBeNull();
    expect(outcome.decision.overallEligible).toBe(true);
  });

  it('with no age rule and no date asked, decides without an age at all', () => {
    const outcome = evaluateAgeEligibility({
      minimumAge: null,
      dateOfBirth: null,
      formAsksForDateOfBirth: false,
      referenceCivilDate: ON,
    });
    expect(outcome).toEqual({
      kind: 'decided',
      decision: {
        calculatedAge: null,
        ageEligible: null,
        overallEligible: true,
        reasonCode: 'ELIGIBLE',
      },
    });
  });

  it('REJECTS an impossible date rather than recording it as ineligible', () => {
    // The distinction the whole phase turns on: too young is a person, an
    // impossible birthday is broken input.
    for (const [dob, problem] of [
      ['2025-02-29', 'INVALID'],
      ['2027-01-01', 'IN_FUTURE'],
      ['1800-01-01', 'IMPLAUSIBLE'],
    ] as const) {
      const outcome = evaluateAgeEligibility({ minimumAge: 21, dateOfBirth: dob, ...asks });
      expect(outcome.kind, dob).toBe('rejected');
      if (outcome.kind !== 'rejected') throw new Error('unreachable');
      expect(outcome.reasonCode, dob).toBe('DATE_OF_BIRTH_INVALID');
      expect(outcome.problem, dob).toBe(problem);
    }
  });

  it('rejects an impossible date even when NO age rule reads it', () => {
    // Storing it because nothing happened to need it would leave a corruption
    // waiting for the first event that does have a rule.
    const outcome = evaluateAgeEligibility({
      minimumAge: null,
      dateOfBirth: '2027-01-01',
      ...asks,
    });
    expect(outcome.kind).toBe('rejected');
  });

  it('blames the FORM when the rule needs a date the form never asks for', () => {
    // Publishing guarantees the question is there whenever the event has a
    // minimum age, so arriving here means the stored version is not what
    // publishing would have produced.
    const outcome = evaluateAgeEligibility({
      minimumAge: 21,
      dateOfBirth: null,
      formAsksForDateOfBirth: false,
      referenceCivilDate: ON,
    });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('unreachable');
    expect(outcome.reasonCode).toBe('FORM_INVALID');
  });

  it('blames the ANSWER when the form asks but nothing arrived', () => {
    const outcome = evaluateAgeEligibility({
      minimumAge: 21,
      dateOfBirth: null,
      ...asks,
    });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') throw new Error('unreachable');
    expect(outcome.reasonCode).toBe('DATE_OF_BIRTH_REQUIRED');
  });

  it('a minimum age of 130 is reachable, and 131 is not a person', () => {
    const exactly = evaluateAgeEligibility({
      minimumAge: 130,
      dateOfBirth: '1896-08-07',
      ...asks,
    });
    expect(exactly.kind).toBe('decided');
    if (exactly.kind !== 'decided') throw new Error('unreachable');
    expect(exactly.decision.overallEligible).toBe(true);

    const beyond = evaluateAgeEligibility({
      minimumAge: 130,
      dateOfBirth: '1895-08-07',
      ...asks,
    });
    expect(beyond.kind).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
describe('the vocabulary of a decision', () => {
  it('a decision maps to exactly one status, and never to SUBMITTED', () => {
    expect(
      statusForDecision({
        calculatedAge: 21,
        ageEligible: true,
        overallEligible: true,
        reasonCode: 'ELIGIBLE',
      }),
    ).toBe('ELIGIBLE');
    expect(
      statusForDecision({
        calculatedAge: 20,
        ageEligible: false,
        overallEligible: false,
        reasonCode: 'AGE_REQUIREMENT_NOT_MET',
      }),
    ).toBe('INELIGIBLE');
  });

  it('separates reasons that can be STORED from reasons that refuse a submission', () => {
    // A duplicate or a closed event produces no row, so no row can carry those
    // reasons. An entry reading `DUPLICATE_ENTRY` would be a participation that
    // never happened.
    expect(isPersistableReason('ELIGIBLE')).toBe(true);
    expect(isPersistableReason('AGE_REQUIREMENT_NOT_MET')).toBe(true);
    for (const code of [
      'DUPLICATE_ENTRY',
      'EVENT_NOT_OPEN',
      'REGISTRATION_CLOSED',
      'DATE_OF_BIRTH_INVALID',
      'FORM_INVALID',
    ] as const) {
      expect(isPersistableReason(code), code).toBe(false);
    }
  });

  it('names every outcome the contract asks for', () => {
    for (const required of [
      'ELIGIBLE',
      'AGE_REQUIREMENT_NOT_MET',
      'DATE_OF_BIRTH_REQUIRED',
      'DATE_OF_BIRTH_INVALID',
      'EVENT_NOT_OPEN',
      'REGISTRATION_NOT_OPEN',
      'REGISTRATION_CLOSED',
      'FORM_INVALID',
      'REQUIRED_ANSWER_MISSING',
      'DUPLICATE_ENTRY',
      'DISQUALIFIED_BY_RULE',
    ]) {
      expect(ELIGIBILITY_REASON_CODES, required).toContain(required);
    }
  });
});

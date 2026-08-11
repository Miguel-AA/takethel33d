// @vitest-environment node
//
// The shared administrative rules: who may act, when, and where an undo lands.

import { describe, expect, it } from 'vitest';
import {
  EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION,
  PARTICIPANT_ADMINISTRATIVE_ACTIONS,
  REINSTATABLE_STATUSES,
  canDisqualify,
  canReinstate,
  describeParticipantAdministrativeActions,
  eventAllowsParticipantAdministration,
  isDrawEligible,
  isReinstatableStatus,
} from '../shared/participantAdministration';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import { EVENT_ENTRY_STATUSES } from '../shared/entryLifecycle';
import {
  adminParticipantListQuerySchema,
  disqualifyEntrySchema,
  reinstateEntrySchema,
} from '../shared/schemas';

const base = {
  eventStatus: 'OPEN' as const,
  entryStatus: 'ELIGIBLE' as const,
  preDisqualificationStatus: null,
};

describe('the action vocabulary', () => {
  it('is exactly two actions', () => {
    expect([...PARTICIPANT_ADMINISTRATIVE_ACTIONS]).toEqual(['DISQUALIFY', 'REINSTATE']);
  });
});

describe('which event states permit administration', () => {
  it('permits OPEN, CLOSED and DRAW_READY, and nothing else', () => {
    // DRAW_READY is included deliberately: the phase 3 lifecycle defines it as
    // "closed, with at least one active prize" — a readiness flag, not a freeze
    // — and no draw has consumed the population yet. Discovering a cheat in the
    // hour before a draw is exactly when this is needed.
    for (const status of EVENT_STATUSES) {
      const expected = status === 'OPEN' || status === 'CLOSED' || status === 'DRAW_READY';
      expect(eventAllowsParticipantAdministration(status), status).toBe(expected);
    }
    expect([...EVENT_STATUSES_ALLOWING_PARTICIPANT_ADMINISTRATION]).toEqual([
      'OPEN',
      'CLOSED',
      'DRAW_READY',
    ]);
  });

  it('refuses DRAW_COMPLETED absolutely', () => {
    // A draw has read this population and produced a result from it; changing
    // the inputs afterwards would leave a recorded outcome its own data no
    // longer explains.
    expect(
      canDisqualify({ ...base, eventStatus: 'DRAW_COMPLETED' }),
    ).toEqual({ allowed: false, blocker: 'EVENT_STATE_FORBIDS' });
  });

  it('refuses CANCELLED and ARCHIVED — read-only', () => {
    for (const status of ['CANCELLED', 'ARCHIVED'] as const) {
      expect(canDisqualify({ ...base, eventStatus: status }).allowed, status).toBe(false);
    }
  });

  it('refuses DRAFT and SCHEDULED explicitly, not by accident', () => {
    // Entries cannot exist in either, but "impossible" and "forbidden" are
    // different guarantees and only one of them survives a refactor.
    for (const status of ['DRAFT', 'SCHEDULED'] as const) {
      expect(canDisqualify({ ...base, eventStatus: status }).allowed, status).toBe(false);
    }
  });
});

describe('disqualification', () => {
  it('is offered for an entry that is not already disqualified', () => {
    for (const entryStatus of ['ELIGIBLE', 'INELIGIBLE', 'SUBMITTED'] as const) {
      expect(canDisqualify({ ...base, entryStatus }), entryStatus).toEqual({ allowed: true });
    }
  });

  it('is NOT silently idempotent', () => {
    // Disqualifying an already-disqualified entry would either overwrite the
    // recorded previous status — losing the original verdict — or quietly do
    // nothing while reporting success.
    expect(
      canDisqualify({
        ...base,
        entryStatus: 'DISQUALIFIED',
        preDisqualificationStatus: 'ELIGIBLE',
      }),
    ).toEqual({ allowed: false, blocker: 'ALREADY_DISQUALIFIED' });
  });
});

describe('reinstatement', () => {
  it('is offered only for a disqualified entry with somewhere to return to', () => {
    expect(
      canReinstate({
        ...base,
        entryStatus: 'DISQUALIFIED',
        preDisqualificationStatus: 'INELIGIBLE',
      }),
    ).toEqual({ allowed: true });
  });

  it('is refused for an entry that is not disqualified', () => {
    expect(canReinstate({ ...base, entryStatus: 'ELIGIBLE' })).toEqual({
      allowed: false,
      blocker: 'NOT_DISQUALIFIED',
    });
  });

  it('is refused when there is nothing recorded to restore', () => {
    // Reachable only for a row written outside the application. Choosing a
    // destination would invent a verdict.
    expect(
      canReinstate({
        ...base,
        entryStatus: 'DISQUALIFIED',
        preDisqualificationStatus: null,
      }),
    ).toEqual({ allowed: false, blocker: 'NO_RESTORABLE_STATUS' });
  });

  it('never accepts DISQUALIFIED as a destination', () => {
    // A disqualification undoing to a disqualification loses the verdict
    // between them.
    expect(isReinstatableStatus('DISQUALIFIED')).toBe(false);
    expect([...REINSTATABLE_STATUSES]).toEqual(['ELIGIBLE', 'INELIGIBLE', 'SUBMITTED']);
    for (const status of EVENT_ENTRY_STATUSES) {
      expect(isReinstatableStatus(status), status).toBe(status !== 'DISQUALIFIED');
    }
  });
});

describe('the described actions', () => {
  it('names where a reinstatement would land', () => {
    // So a dialog can say "this entry will return to INELIGIBLE" rather than
    // implying that reinstatement means eligible.
    const described = describeParticipantAdministrativeActions({
      eventStatus: 'CLOSED',
      entryStatus: 'DISQUALIFIED',
      preDisqualificationStatus: 'INELIGIBLE',
    });

    expect(described.available).toEqual(['REINSTATE']);
    expect(described.reinstatesTo).toBe('INELIGIBLE');
  });

  it('reports nothing to return to when reinstatement is not offered', () => {
    const described = describeParticipantAdministrativeActions({
      eventStatus: 'OPEN',
      entryStatus: 'ELIGIBLE',
      preDisqualificationStatus: null,
    });
    expect(described.available).toEqual(['DISQUALIFY']);
    expect(described.reinstatesTo).toBeNull();
  });

  it('offers nothing at all when the event forbids it, and says why', () => {
    const described = describeParticipantAdministrativeActions({
      eventStatus: 'DRAW_COMPLETED',
      entryStatus: 'ELIGIBLE',
      preDisqualificationStatus: null,
    });

    expect(described.available).toEqual([]);
    expect(described.blocked.map((b) => b.blocker)).toEqual([
      'EVENT_STATE_FORBIDS',
      'EVENT_STATE_FORBIDS',
    ]);
  });

  it('never offers both actions at once', () => {
    // They are mutually exclusive by construction: one requires DISQUALIFIED
    // and the other refuses it.
    for (const eventStatus of EVENT_STATUSES) {
      for (const entryStatus of EVENT_ENTRY_STATUSES) {
        for (const previous of [null, 'ELIGIBLE', 'INELIGIBLE', 'SUBMITTED'] as const) {
          const described = describeParticipantAdministrativeActions({
            eventStatus,
            entryStatus,
            preDisqualificationStatus: previous,
          });
          expect(described.available.length, `${eventStatus}/${entryStatus}`).toBeLessThan(2);
        }
      }
    }
  });
});

describe('the schemas refuse anything they do not name', () => {
  // Asserted at the SCHEMA rather than only through a handler, because the
  // handlers whitelist their inputs today — so a schema that quietly stopped
  // being strict would be invisible from the outside until somebody wired the
  // raw body or the raw query object straight through. The strictness is part
  // of the contract, so it is tested as part of the contract.

  it('the disqualification payload takes exactly two fields', () => {
    expect(
      disqualifyEntrySchema.safeParse({ expectedRevision: 1, reason: 'A good reason' }).success,
    ).toBe(true);

    for (const extra of [
      'status',
      'preDisqualificationStatus',
      'disqualifiedAt',
      'disqualifiedByAdminId',
      'revision',
      'newRevision',
      'actorId',
      'eventId',
      'entryId',
      'overallEligible',
      'eligibilityReason',
      'calculatedAge',
      'answers',
    ]) {
      const result = disqualifyEntrySchema.safeParse({
        expectedRevision: 1,
        reason: 'A good reason',
        [extra]: 'injected',
      });
      expect(result.success, extra).toBe(false);
    }
  });

  it('the reinstatement payload takes exactly one', () => {
    expect(reinstateEntrySchema.safeParse({ expectedRevision: 2 }).success).toBe(true);
    // A target status in particular: accepting one would let an administrator
    // promote somebody the rules excluded.
    for (const extra of ['status', 'preDisqualificationStatus', 'reason', 'overallEligible']) {
      expect(
        reinstateEntrySchema.safeParse({ expectedRevision: 2, [extra]: 'ELIGIBLE' }).success,
        extra,
      ).toBe(false);
    }
  });

  it('the listing query takes exactly the filters it names', () => {
    expect(adminParticipantListQuerySchema.safeParse({}).success).toBe(true);
    for (const extra of ['sort', 'orderBy', 'includeAnswers', 'dateOfBirth', 'select']) {
      expect(
        adminParticipantListQuerySchema.safeParse({ [extra]: 'x' }).success,
        extra,
      ).toBe(false);
    }
  });

  it('bounds the reason at both ends', () => {
    for (const reason of ['', '  ', 'ab', 'x'.repeat(501)]) {
      expect(
        disqualifyEntrySchema.safeParse({ expectedRevision: 1, reason }).success,
        JSON.stringify(reason),
      ).toBe(false);
    }
    // Trimmed BEFORE it is bounded, so padding cannot satisfy the minimum.
    const padded = disqualifyEntrySchema.safeParse({
      expectedRevision: 1,
      reason: '   Entered twice   ',
    });
    expect(padded.success).toBe(true);
    if (padded.success) expect(padded.data.reason).toBe('Entered twice');
  });

  it('demands a revision that could exist', () => {
    for (const expectedRevision of [0, -1, 1.5, '1', null, undefined]) {
      expect(
        disqualifyEntrySchema.safeParse({ expectedRevision, reason: 'A good reason' }).success,
        String(expectedRevision),
      ).toBe(false);
    }
  });
});

describe('the draw predicate', () => {
  it('needs BOTH the historical verdict and the current disposition', () => {
    expect(isDrawEligible({ status: 'ELIGIBLE', overallEligible: true })).toBe(true);
    // Qualified, then removed.
    expect(isDrawEligible({ status: 'DISQUALIFIED', overallEligible: true })).toBe(false);
    // Never qualified.
    expect(isDrawEligible({ status: 'INELIGIBLE', overallEligible: false })).toBe(false);
    // Never judged.
    expect(isDrawEligible({ status: 'SUBMITTED', overallEligible: null })).toBe(false);
  });

  it('is false for every status other than ELIGIBLE, whatever the verdict', () => {
    for (const status of EVENT_ENTRY_STATUSES) {
      if (status === 'ELIGIBLE') continue;
      expect(isDrawEligible({ status, overallEligible: true }), status).toBe(false);
    }
  });
});

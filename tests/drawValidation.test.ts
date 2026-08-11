// @vitest-environment node
//
// The areas the phase-11 certification singled out for attack, each stated as
// the property it is defending rather than as the code it exercises.
//
//   * what can and cannot change under a draw once the event is DRAW_READY
//   * exactly which participant changes move the population counter
//   * whether a new participation can appear after the population was declared
//   * the arithmetic at the edges of the random source
//   * that the candidate predicate means the same thing in all four places it
//     is written

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrizeService } from '../functions/_shared/prizeService';
import { ParticipantAdministrationService } from '../functions/_shared/participantAdministrationService';
import { EventRepository } from '../functions/_shared/eventRepository';
import { EventEntryRepository } from '../functions/_shared/eventEntryRepository';
import { DrawService } from '../functions/_shared/drawService';
import { setLogSink } from '../functions/_shared/logger';
import { CryptoRandomSource, DeterministicRandomSource, secureShuffle } from '../shared/secureRandom';
import { isDrawEligible } from '../shared/participantAdministration';
import { EVENT_ENTRY_STATUSES } from '../shared/entryLifecycle';
import { PRIZE_CAPABILITIES_BY_EVENT_STATUS } from '../shared/prizeLifecycle';
import {
  createDrawHarness,
  drawActor,
  seedDrawableEvent,
  type DrawHarness,
} from './helpers/drawFlow';
import { answersFor } from './helpers/publicFlow';

let harness: DrawHarness;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createDrawHarness();
});
afterEach(() => {
  setLogSink(null);
  harness.close();
});

const actor = () => drawActor(harness);
const revisionOf = (eventId: string) =>
  new EventRepository(harness.db.d1).populationRevision(eventId);

// ---------------------------------------------------------------------------
describe('nothing about the prizes can move under a draw', () => {
  it('DRAW_READY permits no prize operation at all', () => {
    // The table is the contract. If this ever grows an entry, the draw needs a
    // guard for whatever was added — including an editorial rename, which would
    // otherwise let a snapshot be taken from a name that changed after the
    // units were loaded.
    expect(PRIZE_CAPABILITIES_BY_EVENT_STATUS.DRAW_READY).toEqual([]);
    expect(PRIZE_CAPABILITIES_BY_EVENT_STATUS.CLOSED).toEqual([]);
    expect(PRIZE_CAPABILITIES_BY_EVENT_STATUS.DRAW_COMPLETED).toEqual([]);
  });

  it('refuses every prize mutation while the event is DRAW_READY', async () => {
    const { event, prizes } = await seedDrawableEvent(harness, { participants: 3, prizes: [2] });
    const service = new PrizeService(harness.db.d1);
    const prize = prizes[0];

    const attempts: Array<[string, Promise<{ ok: boolean }>]> = [
      [
        'rename',
        service.update(
          event.id,
          prize.id,
          { expectedRevision: prize.revision, name: 'Renamed' } as never,
          actor() as never,
        ),
      ],
      [
        'describe',
        service.update(
          event.id,
          prize.id,
          { expectedRevision: prize.revision, description: 'New copy' } as never,
          actor() as never,
        ),
      ],
      [
        'requantify',
        service.update(
          event.id,
          prize.id,
          { expectedRevision: prize.revision, quantity: 9 } as never,
          actor() as never,
        ),
      ],
      ['deactivate', service.transition(event.id, prize.id, 'deactivate', actor() as never)],
      ['archive', service.transition(event.id, prize.id, 'archive', actor() as never)],
      [
        'create',
        service.create(event.id, { name: 'Late addition', quantity: 1 } as never, actor() as never),
      ],
      [
        'reorder',
        service.reorder(
          event.id,
          [{ id: prize.id, sortOrder: 5 }] as never,
          actor() as never,
        ) as never,
      ],
    ];

    for (const [label, promise] of attempts) {
      const result = await promise;
      expect(result.ok, `${label} must be refused while DRAW_READY`).toBe(false);
    }

    // The offering is bit-for-bit what it was.
    const after = harness.db.raw
      .prepare('SELECT name, description, quantity, status, sort_order FROM event_prizes WHERE id = ?')
      .get(prize.id);
    expect(after).toMatchObject({ name: prize.name, quantity: 2, status: 'ACTIVE' });
  });

  it('takes the draw down if the offering is changed behind the lifecycle', async () => {
    // Prizes are frozen, so this can only be reached by editing the database
    // directly — and even then the draw must not award something that is no
    // longer on offer.
    const { event, prizes } = await seedDrawableEvent(harness, { participants: 3, prizes: [2] });

    let fired = false;
    const service = new DrawService(harness.db.d1, {
      random: {
        randomInt: (maxExclusive: number) => {
          if (!fired) {
            fired = true;
            harness.db.raw
              .prepare('UPDATE event_prizes SET quantity = 1 WHERE id = ?')
              .run(prizes[0].id);
          }
          return maxExclusive - 1;
        },
      },
    });

    const result = await service.run(event.id, actor());
    expect(fired).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('DRAW_CONFLICT');
      if (result.failure.code === 'DRAW_CONFLICT') {
        expect(result.failure.reason).toBe('prizes_changed');
      }
    }
    const drawn = harness.db.raw.prepare('SELECT COUNT(*) AS n FROM draws').get() as {
      n: number;
    };
    expect(drawn.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('exactly which changes move the population counter', () => {
  /** Puts one entry into a starting state and applies one disposition. */
  async function applyTo(
    from: 'ELIGIBLE' | 'INELIGIBLE' | 'SUBMITTED',
    action: 'disqualify' | 'reinstate',
  ): Promise<number> {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 2 });
    const entryId = entryIds[0];

    if (from !== 'ELIGIBLE') {
      harness.db.raw
        .prepare(
          from === 'INELIGIBLE'
            ? `UPDATE event_entries
                  SET status = 'INELIGIBLE', overall_eligible = 0,
                      eligibility_reason = 'AGE_REQUIREMENT_NOT_MET'
                WHERE id = ?`
            : `UPDATE event_entries
                  SET status = 'SUBMITTED', overall_eligible = NULL,
                      eligibility_reason = NULL
                WHERE id = ?`,
        )
        .run(entryId);
    }

    const admin = new ParticipantAdministrationService(harness.db.d1);
    const removed = await admin.disqualify(
      event.id,
      entryId,
      { expectedRevision: 1, reason: 'Recorded for the population matrix' },
      actor() as never,
    );
    expect(removed.ok, `disqualify from ${from}`).toBe(true);

    if (action === 'disqualify') {
      const before = 0;
      return (await revisionOf(event.id)) - before;
    }

    const at = await revisionOf(event.id);
    const back = await admin.reinstate(event.id, entryId, { expectedRevision: 2 }, actor() as never);
    expect(back.ok, `reinstate to ${from}`).toBe(true);
    return (await revisionOf(event.id)) - at;
  }

  it('advances by one when an eligible entry leaves the running', async () => {
    expect(await applyTo('ELIGIBLE', 'disqualify')).toBe(1);
  });

  it('advances by one when an entry returns to the running', async () => {
    expect(await applyTo('ELIGIBLE', 'reinstate')).toBe(1);
  });

  it('does not move for an INELIGIBLE entry, in either direction', async () => {
    expect(await applyTo('INELIGIBLE', 'disqualify')).toBe(0);
    expect(await applyTo('INELIGIBLE', 'reinstate')).toBe(0);
  });

  it('does not move for a SUBMITTED entry, in either direction', async () => {
    // A change that cannot affect who could win must not invalidate a draw in
    // flight. Counting every edit would turn the guard into a source of
    // spurious failures, and an operator refused often enough stops reading.
    expect(await applyTo('SUBMITTED', 'disqualify')).toBe(0);
    expect(await applyTo('SUBMITTED', 'reinstate')).toBe(0);
  });

  it('never moves backwards, and never for an unrelated write', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 2 });
    const before = await revisionOf(event.id);

    // Editorial changes, transitions and reads all leave it alone.
    harness.db.raw
      .prepare("UPDATE events SET name = 'Renamed', revision = revision + 1 WHERE id = ?")
      .run(event.id);
    await harness.draws.status(event.id);
    await new EventEntryRepository(harness.db.d1).listDrawEligibleByEvent(event.id);

    expect(await revisionOf(event.id)).toBe(before);
    expect(before).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
describe('no new participation can appear after DRAW_READY', () => {
  it('administrative registration is refused', async () => {
    const { event, version } = await seedDrawableEvent(harness, { participants: 2 });

    const attempt = await harness.registration.register(
      event.id,
      answersFor(version, {
        first_name: 'Late',
        last_name: 'Arrival',
        email: 'late@example.com',
      }),
      harness.actor(),
    );

    // Registration requires OPEN and a draw requires DRAW_READY, so the two can
    // never interleave. This is what lets the population counter be the only
    // thing the draw has to watch.
    expect(attempt.ok).toBe(false);
    const count = harness.db.raw
      .prepare('SELECT COUNT(*) AS n FROM event_entries WHERE event_id = ?')
      .get(event.id) as { n: number };
    expect(count.n).toBe(2);
  });

  it('is refused for every state a draw could run from or after', async () => {
    const { event, version } = await seedDrawableEvent(harness, { participants: 1 });
    for (const status of ['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED']) {
      harness.db.raw.prepare('UPDATE events SET status = ? WHERE id = ?').run(status, event.id);
      const attempt = await harness.registration.register(
        event.id,
        answersFor(version, { email: `late-${status}@example.com` }),
        harness.actor(),
      );
      expect(attempt.ok, `registration during ${status}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the arithmetic at the edges of the random source', () => {
  it('is exact at 2^32 in JavaScript numbers', () => {
    // The rejection boundary is computed from 2^32, which is well inside the
    // safe integer range — but only if it is never routed through a bitwise
    // operator, which would truncate it to signed 32-bit and make `limit`
    // negative.
    const range = 0x1_0000_0000;
    expect(Number.isSafeInteger(range)).toBe(true);
    expect(range).toBe(4294967296);
    expect(range - 1).toBe(4294967295);
    for (const n of [2, 3, 5, 7, 256, 65536, 1_000_000]) {
      const limit = Math.floor(range / n) * n;
      expect(Number.isSafeInteger(limit)).toBe(true);
      expect(limit).toBeGreaterThan(0);
      expect(limit % n).toBe(0);
      expect(range - limit).toBeLessThan(n);
    }
  });

  it('wastes no values when the bound divides 2^32 exactly', () => {
    // For a power of two the whole range is usable, so a correct implementation
    // never redraws. Scripted so this is a fact rather than a probability.
    const range = 0x1_0000_0000;
    for (const n of [2, 4, 256, 65536]) {
      expect(Math.floor(range / n) * n).toBe(range);

      let consumed = 0;
      const original = crypto.getRandomValues;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (crypto as any).getRandomValues = (buffer: Uint32Array) => {
        // The largest possible value: inside the range, so it must be accepted.
        buffer[0] = range - 1;
        consumed += 1;
        return buffer;
      };
      try {
        expect(new CryptoRandomSource().randomInt(n)).toBe((range - 1) % n);
        expect(consumed, `n = ${n} must not redraw`).toBe(1);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (crypto as any).getRandomValues = original;
      }
    }
  });

  it('accepts limit-1 and redraws on limit and above', () => {
    const n = 3;
    const range = 0x1_0000_0000;
    const limit = Math.floor(range / n) * n;

    for (const [value, shouldRedraw] of [
      [limit - 1, false],
      [limit, true],
      [range - 1, true],
    ] as Array<[number, boolean]>) {
      let consumed = 0;
      const original = crypto.getRandomValues;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (crypto as any).getRandomValues = (buffer: Uint32Array) => {
        buffer[0] = consumed === 0 ? value : 7;
        consumed += 1;
        return buffer;
      };
      try {
        new CryptoRandomSource().randomInt(n);
        expect(consumed > 1, `value ${value}`).toBe(shouldRedraw);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (crypto as any).getRandomValues = original;
      }
    }
  });

  it('handles a bound at the top of what a draw can reach', () => {
    // A candidate list cannot exceed what the system can hold, but the source
    // must not misbehave for a large bound either.
    const random = new CryptoRandomSource();
    for (const n of [65_536, 1_000_000, 0x7fff_ffff]) {
      const value = random.randomInt(n);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(n);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the candidate predicate means one thing everywhere', () => {
  it('agrees across the shared rule, the SQL and the phase 10 aggregate', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 6 });

    // An exhaustive spread of dispositions across the six entries, written
    // directly so every combination the schema permits is represented.
    const states: Array<[string, string, number | null]> = [
      ['ELIGIBLE', 'ELIGIBLE', 1],
      ['INELIGIBLE', 'INELIGIBLE', 0],
      ['SUBMITTED', 'SUBMITTED', null],
      ['DISQUALIFIED', 'DISQUALIFIED', 1],
      ['DISQUALIFIED', 'DISQUALIFIED', 0],
      ['ELIGIBLE', 'ELIGIBLE', 1],
    ];

    entryIds.forEach((entryId, index) => {
      const [status, , overall] = states[index];
      harness.db.raw
        .prepare(
          `UPDATE event_entries
              SET status = ?, overall_eligible = ?,
                  eligibility_reason = CASE WHEN ? = 0 THEN 'AGE_REQUIREMENT_NOT_MET' ELSE eligibility_reason END,
                  pre_disqualification_status = CASE WHEN ? = 'DISQUALIFIED' THEN 'ELIGIBLE' ELSE NULL END,
                  disqualified_at = CASE WHEN ? = 'DISQUALIFIED' THEN '2026-01-01T00:00:00.000Z' ELSE NULL END,
                  disqualification_reason = CASE WHEN ? = 'DISQUALIFIED' THEN 'Recorded for the matrix' ELSE NULL END
            WHERE id = ?`,
        )
        .run(status, overall, overall ?? 1, status, status, status, entryId);
    });

    const entries = new EventEntryRepository(harness.db.d1);
    const fromSql = await entries.listDrawEligibleByEvent(event.id);
    const aggregate = await entries.aggregateByEvent(event.id);

    const fromShared = entryIds.filter((entryId, index) => {
      const [status, , overall] = states[index];
      return isDrawEligible({
        status: status as never,
        overallEligible: overall === null ? null : overall === 1,
      });
    });

    expect([...fromSql].sort()).toEqual([...fromShared].sort());
    expect(aggregate.drawEligible).toBe(fromShared.length);

    // ...and the draw itself takes exactly that population.
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.value.response.draw?.candidateCount).toBe(fromShared.length);
  });

  it('admits exactly one status, whatever the verdict says', () => {
    for (const status of EVENT_ENTRY_STATUSES) {
      for (const overallEligible of [true, false, null]) {
        expect(isDrawEligible({ status, overallEligible })).toBe(
          status === 'ELIGIBLE' && overallEligible === true,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('the candidate order does not come from the database', () => {
  it('gives the same winners whatever order the rows were written in', async () => {
    // Two events with the same candidate IDs inserted in opposite orders. With
    // the same scripted randomness, a loader that relied on the query plan
    // would produce different winners.
    const ids = ['aaa', 'bbb', 'ccc', 'ddd'];

    async function drawWith(order: string[]): Promise<string[]> {
      const local = await createDrawHarness();
      try {
        const { event, entryIds } = await seedDrawableEvent(local, {
          participants: 4,
          prizes: [2],
        });
        // Rewrite the entry ids in the given order, so the physical row order
        // and the logical order disagree.
        entryIds.forEach((entryId, index) => {
          local.db.raw.exec('PRAGMA foreign_keys = OFF');
          local.db.raw
            .prepare('UPDATE event_entries SET id = ? WHERE id = ?')
            .run(order[index], entryId);
          local.db.raw.exec('PRAGMA foreign_keys = ON');
        });

        const service = new DrawService(local.db.d1, {
          random: new DeterministicRandomSource([1, 0, 2]),
        });
        const result = await service.run(event.id, drawActor(local));
        if (!result.ok) throw new Error(JSON.stringify(result.failure));
        return result.value.response.assignments.map((a) => a.winner.entryId);
      } finally {
        local.close();
      }
    }

    const forwards = await drawWith(ids);
    const backwards = await drawWith([...ids].reverse());
    expect(backwards).toEqual(forwards);
    // ...and it is the answer the shuffle gives over the SORTED list.
    expect(forwards).toEqual(
      secureShuffle([...ids].sort(), new DeterministicRandomSource([1, 0, 2])).slice(0, 2),
    );
  });
});

// ---------------------------------------------------------------------------
describe('the predicate does not lean on the coherence trigger', () => {
  it('both the loader AND the phase 10 aggregate exclude an incoherent row', async () => {
    // While phase 8's trigger stands, `status = 'ELIGIBLE'` and
    // `overall_eligible = 1` are equivalent, so half of either predicate could
    // be deleted with no visible effect. Removing the trigger is what makes the
    // difference observable — and both places must name both columns.
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 3 });

    harness.db.raw.exec('DROP TRIGGER trg_event_entries_decision_update');
    harness.db.raw
      .prepare(
        `UPDATE event_entries
            SET overall_eligible = 0, eligibility_reason = 'AGE_REQUIREMENT_NOT_MET'
          WHERE id = ?`,
      )
      .run(entryIds[0]);

    const entries = new EventEntryRepository(harness.db.d1);
    expect(await entries.listDrawEligibleByEvent(event.id)).not.toContain(entryIds[0]);
    expect((await entries.aggregateByEvent(event.id)).drawEligible).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('randomness is spent only on a draw that can happen', () => {
  it('a refused draw shuffles nothing', async () => {
    // Every refusal is decided from reads. A service that shuffled first and
    // checked afterwards would be discarding real selections on every failed
    // attempt, which is wasteful at best and, for anyone counting draws against
    // an entropy budget, misleading.
    const counted = () => {
      let calls = 0;
      return {
        source: {
          randomInt: (maxExclusive: number) => {
            calls += 1;
            return maxExclusive - 1;
          },
        },
        spent: () => calls,
      };
    };

    // Not ready.
    {
      const { event } = await seedDrawableEvent(harness, { markReady: false });
      const rng = counted();
      const result = await new DrawService(harness.db.d1, { random: rng.source }).run(
        event.id,
        actor(),
      );
      expect(result.ok).toBe(false);
      expect(rng.spent(), 'a not-ready event must not be shuffled').toBe(0);
    }

    // Nobody eligible.
    {
      const { event, entryIds } = await seedDrawableEvent(harness, { participants: 1 });
      const admin = new ParticipantAdministrationService(harness.db.d1);
      await admin.disqualify(
        event.id,
        entryIds[0],
        { expectedRevision: 1, reason: 'Removed before the draw' },
        actor() as never,
      );
      const rng = counted();
      const result = await new DrawService(harness.db.d1, { random: rng.source }).run(
        event.id,
        actor(),
      );
      expect(result.ok).toBe(false);
      expect(rng.spent(), 'an empty population must not be shuffled').toBe(0);
    }

    // Nothing to award.
    {
      const { event, prizes } = await seedDrawableEvent(harness, { participants: 2 });
      harness.db.raw
        .prepare("UPDATE event_prizes SET status = 'INACTIVE' WHERE id = ?")
        .run(prizes[0].id);
      const rng = counted();
      const result = await new DrawService(harness.db.d1, { random: rng.source }).run(
        event.id,
        actor(),
      );
      expect(result.ok).toBe(false);
      expect(rng.spent(), 'an empty offering must not be shuffled').toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('the population counter is captured BEFORE the candidates', () => {
  it('a change landing between the two reads takes the draw down', async () => {
    // The narrow window the read order exists for. Read the counter second and
    // this interleaving is invisible: the candidate list is stale, the counter
    // has already moved to match it, and the guard compares equal — so a draw
    // commits winners chosen from a set that no longer exists.
    const { event, entryIds } = await seedDrawableEvent(harness, {
      participants: 4,
      prizes: [2],
    });

    const entries = new EventEntryRepository(harness.db.d1);
    let fired = false;
    const racing = {
      listDrawEligibleByEvent: async (eventId: string) => {
        const candidates = await entries.listDrawEligibleByEvent(eventId);
        if (!fired) {
          fired = true;
          // Somebody leaves the running as the list is being read.
          harness.db.raw
            .prepare(
              `UPDATE event_entries
                  SET status = 'DISQUALIFIED', pre_disqualification_status = 'ELIGIBLE',
                      disqualified_at = '2026-01-01T00:00:00.000Z',
                      disqualification_reason = 'Between the two reads',
                      revision = revision + 1
                WHERE id = ?`,
            )
            .run(entryIds[0]);
          harness.db.raw
            .prepare(
              `UPDATE events
                  SET participant_population_revision = participant_population_revision + 1
                WHERE id = ?`,
            )
            .run(eventId);
        }
        return candidates;
      },
    };

    const result = await new DrawService(harness.db.d1, {
      entries: racing as never,
    }).run(event.id, actor());

    expect(fired).toBe(true);
    expect(result.ok, 'a draw over a population that moved must not commit').toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('DRAW_POPULATION_CHANGED');

    const drawn = harness.db.raw.prepare('SELECT COUNT(*) AS n FROM draws').get() as {
      n: number;
    };
    expect(drawn.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the atomic assignment ceiling', () => {
  /** Adds `count` draw-eligible entries directly, and enough units to match. */
  function inflate(eventId: string, versionId: string, count: number) {
    const now = new Date().toISOString();
    harness.db.raw.exec('BEGIN');
    for (let i = 0; i < count; i++) {
      const participantId = crypto.randomUUID();
      const email = `bulk-${participantId}@example.com`;
      harness.db.raw
        .prepare(
          `INSERT INTO participants
             (id, email, normalized_email, first_name, last_name, created_at, updated_at)
           VALUES (?, ?, ?, 'Bulk', 'Entrant', ?, ?)`,
        )
        .run(participantId, email, email, now, now);
      harness.db.raw
        .prepare(
          `INSERT INTO event_entries
             (id, event_id, participant_id, form_version_id, status, overall_eligible,
              submitted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'ELIGIBLE', 1, ?, ?, ?)`,
        )
        .run(crypto.randomUUID(), eventId, participantId, versionId, now, now, now);
    }
    harness.db.raw.exec('COMMIT');
  }

  it('refuses a draw that would need more assignments than one batch can carry', async () => {
    const { event, version } = await seedDrawableEvent(harness, {
      participants: 1,
      prizes: [1000],
    });
    // 1001 people in the running and 1001 units on offer, so the draw would
    // need 1001 assignments in a single transaction.
    inflate(event.id, version.id, 1000);
    harness.db.raw
      .prepare("UPDATE event_prizes SET quantity = 1000 WHERE event_id = ?")
      .run(event.id);
    const now = new Date().toISOString();
    harness.db.raw
      .prepare(
        `INSERT INTO event_prizes
           (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, 'Overflow', 1, 1, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), event.id, harness.admin.id, harness.admin.id, now, now);

    const status = await harness.draws.status(event.id);
    if (!status.ok) throw new Error('unreachable');
    expect(status.value.readiness.plannedWinnerCount).toBe(1001);

    const result = await harness.draws.run(event.id, actor());
    expect(result.ok, 'a draw that cannot commit atomically must not commit').toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('DRAW_CONFLICT');
      if (result.failure.code === 'DRAW_CONFLICT') {
        expect(result.failure.reason).toBe('too_many_assignments');
      }
    }

    // Refused, not half-written.
    const rows = harness.db.raw
      .prepare(
        `SELECT (SELECT COUNT(*) FROM draws) AS draws,
                (SELECT COUNT(*) FROM draw_assignments) AS assignments`,
      )
      .get();
    expect(rows).toEqual({ draws: 0, assignments: 0 });
    expect((await new EventRepository(harness.db.d1).findById(event.id))?.status).toBe(
      'DRAW_READY',
    );
  });

  it('is a ceiling on ASSIGNMENTS, not on the size of the offering', async () => {
    // A thousand people and a hundred thousand units is a thousand winners, and
    // that is allowed. The catalogue being large is not the problem the ceiling
    // exists for.
    const { event } = await seedDrawableEvent(harness, { participants: 2, prizes: [1000] });
    const now = new Date().toISOString();
    for (let i = 1; i < 100; i++) {
      harness.db.raw
        .prepare(
          `INSERT INTO event_prizes
             (id, event_id, name, quantity, sort_order, created_by, updated_by, created_at, updated_at)
           VALUES (?, ?, ?, 1000, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          event.id,
          `Bulk ${i}`,
          i,
          harness.admin.id,
          harness.admin.id,
          now,
          now,
        );
    }

    const result = await harness.draws.run(event.id, actor());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.response.draw?.prizeUnitCount).toBe(100000);
      expect(result.value.response.draw?.assignmentCount).toBe(2);
    }
  });
});

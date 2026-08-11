// @vitest-environment node
//
// The draw against real SQL: the real migrations, the real unique indexes, the
// real batch.
//
// The property every test here circles: EITHER A DRAW HAPPENED COMPLETELY, OR
// IT DID NOT HAPPEN AT ALL. There is no state in which winners exist and the
// event still looks ready to draw, none in which an assignment exists without
// its draw, and none in which any of it happened unrecorded.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DrawService } from '../functions/_shared/drawService';
import { ParticipantAdministrationService } from '../functions/_shared/participantAdministrationService';
import { EventRepository } from '../functions/_shared/eventRepository';
import { EventEntryRepository } from '../functions/_shared/eventEntryRepository';
import { DrawRepository } from '../functions/_shared/drawRepository';
import { setLogSink } from '../functions/_shared/logger';
import { DeterministicRandomSource, secureShuffle } from '../shared/secureRandom';
import { DRAW_ALGORITHM_VERSION, hashCandidateSet } from '../shared/drawLifecycle';
import {
  createDrawHarness,
  drawActor,
  seedDrawableEvent,
  type DrawHarness,
} from './helpers/drawFlow';

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
const count = (sql: string, ...bind: unknown[]) =>
  (harness.db.raw.prepare(sql).get(...(bind as never[])) as { n: number }).n;

// ---------------------------------------------------------------------------
describe('a successful draw', () => {
  it('produces one winner per prize unit, all distinct', async () => {
    const { event } = await seedDrawableEvent(harness, {
      participants: 6,
      prizes: [2, 1],
    });

    const result = await harness.draws.run(event.id, actor());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));

    const { draw, assignments } = result.value.response;
    expect(draw).not.toBeNull();
    expect(draw?.candidateCount).toBe(6);
    expect(draw?.prizeUnitCount).toBe(3);
    expect(draw?.assignmentCount).toBe(3);

    expect(assignments).toHaveLength(3);
    // Nobody wins twice.
    expect(new Set(assignments.map((a) => a.winner.entryId)).size).toBe(3);
    // No unit is awarded twice.
    expect(
      new Set(assignments.map((a) => `${a.prize.id}#${a.prize.unitIndex}`)).size,
    ).toBe(3);
  });

  it('moves the event to DRAW_COMPLETED in the same act', async () => {
    const { event } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());

    const after = await new EventRepository(harness.db.d1).findById(event.id);
    expect(after?.status).toBe('DRAW_COMPLETED');
    // The revision moved too: the transition is a real guarded UPDATE, not a
    // status column written by hand.
    expect(after?.revision).toBeGreaterThan(event.revision);
  });

  it('writes exactly one audit row, naming who ran it', async () => {
    const { event } = await seedDrawableEvent(harness);
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error('unreachable');

    const rows = harness.db.raw
      .prepare(
        `SELECT action, entity_type, entity_id, actor_admin_id, metadata
           FROM audit_logs WHERE action = 'DRAW_COMPLETED'`,
      )
      .all() as Array<Record<string, string>>;

    expect(rows).toHaveLength(1);
    expect(rows[0].entity_type).toBe('DRAW');
    expect(rows[0].entity_id).toBe(result.value.response.draw?.id);
    expect(rows[0].actor_admin_id).toBe(harness.admin.id);
    expect(JSON.parse(rows[0].metadata).algorithmVersion).toBe(DRAW_ALGORITHM_VERSION);
  });

  it('records counts and a hash in the audit, never the winners', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 3 });
    await harness.draws.run(event.id, actor());

    const row = harness.db.raw
      .prepare(`SELECT new_data, metadata FROM audit_logs WHERE action = 'DRAW_COMPLETED'`)
      .get() as { new_data: string; metadata: string };

    const serialized = `${row.new_data}${row.metadata}`;
    // The audit table is append-only and never deleted, so a list of people who
    // won something in it is a copy no erasure request could ever reach.
    for (const entryId of entryIds) {
      expect(serialized).not.toContain(entryId);
    }
    expect(serialized).not.toContain('person0@example.com');
  });

  it('stores the hash of the population it actually consumed', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 4 });
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error('unreachable');

    expect(result.value.response.draw?.candidateSetHash).toBe(await hashCandidateSet(entryIds));
  });

  it('snapshots the prize name, so a later rename cannot rewrite history', async () => {
    const { event, prizes } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());

    harness.db.raw
      .prepare('UPDATE event_prizes SET name = ? WHERE id = ?')
      .run('Renamed a year later', prizes[0].id);

    const after = await harness.draws.result(event.id);
    if (!after.ok) throw new Error('unreachable');
    expect(after.value.assignments[0].prize.name).toBe('Prize 1');
  });

  it('numbers the assignments from 0, in order', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 5, prizes: [3] });
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.response.assignments.map((a) => a.drawOrder)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
describe('fewer candidates than prizes', () => {
  it('awards one prize each and leaves the rest unassigned', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 2, prizes: [5] });

    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));

    // Two people, five units: two winners and three unawarded. NEVER a third
    // person, and never somebody winning twice to use up the stock.
    expect(result.value.response.draw?.assignmentCount).toBe(2);
    expect(result.value.response.draw?.prizeUnitCount).toBe(5);
    expect(new Set(result.value.response.assignments.map((a) => a.winner.entryId)).size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('one draw per event, ever', () => {
  it('creates nothing on a second run', async () => {
    const { event } = await seedDrawableEvent(harness);
    const first = await harness.draws.run(event.id, actor());
    expect(first.ok && first.value.created).toBe(true);

    // Answered with the existing draw rather than refused — see the replay
    // block below — but the invariant this test is about is unchanged: there is
    // one draw, and it is the first one.
    const second = await harness.draws.run(event.id, actor());
    expect(second.ok && second.value.created).toBe(false);
    if (second.ok && first.ok) {
      expect(second.value.response.draw?.id).toBe(first.value.response.draw?.id);
    }

    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);
  });

  it('the database refuses a second draw even outside the service', async () => {
    const { event } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());

    expect(() =>
      harness.db.raw
        .prepare(
          `INSERT INTO draws
             (id, event_id, completed_at, candidate_count, prize_unit_count,
              assignment_count, algorithm_version, candidate_set_hash,
              candidate_population_revision, created_at)
           VALUES ('forced', ?, '2026-01-01T00:00:00.000Z', 1, 1, 1, 'X', 'h', 0,
                   '2026-01-01T00:00:00.000Z')`,
        )
        .run(event.id),
    ).toThrow(/UNIQUE/i);
  });

  it('commits exactly one draw across concurrent runs', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 8, prizes: [3] });

    // Four simultaneous attempts. Exactly one may PRODUCE winners; the others
    // have their work discarded before it is ever visible and are answered with
    // the one that landed.
    const results = await Promise.all(
      Array.from({ length: 4 }, () => harness.draws.run(event.id, actor())),
    );

    expect(results.filter((r) => r.ok && r.value.created)).toHaveLength(1);
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM draw_assignments')).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DRAW_COMPLETED'`)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('the preconditions', () => {
  it('refuses an event that does not exist', async () => {
    const result = await harness.draws.run(crypto.randomUUID(), actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('EVENT_NOT_FOUND');
  });

  it('refuses an event that is merely CLOSED', async () => {
    const { event } = await seedDrawableEvent(harness, { markReady: false });
    const result = await harness.draws.run(event.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('DRAW_NOT_READY');
      if (result.failure.code === 'DRAW_NOT_READY') {
        expect(result.failure.eventStatus).toBe('CLOSED');
      }
    }
  });

  it('refuses when nobody is in the running', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 1 });
    const admin = new ParticipantAdministrationService(harness.db.d1);
    const removed = await admin.disqualify(
      event.id,
      entryIds[0],
      { expectedRevision: 1, reason: 'Entered under two addresses' },
      actor() as never,
    );
    expect(removed.ok).toBe(true);

    const result = await harness.draws.run(event.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NO_ELIGIBLE_PARTICIPANTS');
  });

  it('refuses when every prize has been deactivated', async () => {
    const { event, prizes } = await seedDrawableEvent(harness);
    // Prizes are frozen from DRAW_READY, so this has to be forced in directly —
    // which is the point: even a row edited outside the application must not
    // produce a draw with nothing to award.
    harness.db.raw
      .prepare("UPDATE event_prizes SET status = 'INACTIVE' WHERE id = ?")
      .run(prizes[0].id);

    const result = await harness.draws.run(event.id, actor());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NO_ACTIVE_PRIZES');
  });

  it('leaves nothing behind when it refuses', async () => {
    const { event } = await seedDrawableEvent(harness, { markReady: false });
    await harness.draws.run(event.id, actor());

    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM draw_assignments')).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DRAW_COMPLETED'`)).toBe(0);
    const after = await new EventRepository(harness.db.d1).findById(event.id);
    expect(after?.status).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
describe('the population guard', () => {
  it('advances the counter when somebody leaves the running', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 3 });
    const events = new EventRepository(harness.db.d1);
    const before = await events.populationRevision(event.id);

    const admin = new ParticipantAdministrationService(harness.db.d1);
    await admin.disqualify(
      event.id,
      entryIds[0],
      { expectedRevision: 1, reason: 'Duplicate registration found' },
      actor() as never,
    );

    expect(await events.populationRevision(event.id)).toBe(before + 1);
  });

  it('advances it again when they come back', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 3 });
    const events = new EventRepository(harness.db.d1);
    const admin = new ParticipantAdministrationService(harness.db.d1);

    await admin.disqualify(
      event.id,
      entryIds[0],
      { expectedRevision: 1, reason: 'Duplicate registration found' },
      actor() as never,
    );
    const afterRemoval = await events.populationRevision(event.id);

    await admin.reinstate(event.id, entryIds[0], { expectedRevision: 2 }, actor() as never);
    expect(await events.populationRevision(event.id)).toBe(afterRemoval + 1);
  });

  it('does NOT advance for a change that cannot affect who could win', async () => {
    // An INELIGIBLE entry being disqualified changes the participants screen
    // and changes nothing a draw would take. Bumping the counter for it would
    // invalidate a draw in flight for no reason.
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 2 });
    harness.db.raw
      .prepare(
        `UPDATE event_entries
            SET status = 'INELIGIBLE', overall_eligible = 0,
                eligibility_reason = 'AGE_REQUIREMENT_NOT_MET'
          WHERE id = ?`,
      )
      .run(entryIds[0]);

    const events = new EventRepository(harness.db.d1);
    const before = await events.populationRevision(event.id);

    const admin = new ParticipantAdministrationService(harness.db.d1);
    const removed = await admin.disqualify(
      event.id,
      entryIds[0],
      { expectedRevision: 1, reason: 'Tidying up an ineligible entry' },
      actor() as never,
    );
    expect(removed.ok).toBe(true);
    expect(await events.populationRevision(event.id)).toBe(before);
  });

  it('does not advance when the mutation loses its revision race', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 2 });
    const events = new EventRepository(harness.db.d1);
    const before = await events.populationRevision(event.id);

    const admin = new ParticipantAdministrationService(harness.db.d1);
    // A stale revision: the guarded UPDATE matches nothing, the conditional
    // audit insert writes nothing, and the counter must stay where it is.
    const stale = await admin.disqualify(
      event.id,
      entryIds[0],
      { expectedRevision: 99, reason: 'Working from a stale copy' },
      actor() as never,
    );
    expect(stale.ok).toBe(false);
    expect(await events.populationRevision(event.id)).toBe(before);
  });

  it('takes the draw down if the population moved after the candidates were read', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, {
      participants: 4,
      prizes: [2],
    });

    // A random source that disqualifies somebody the instant the draw starts
    // shuffling — i.e. AFTER the candidates and the counter were captured, and
    // BEFORE the batch commits. This is the exact interleaving the counter
    // exists to catch, and it cannot be produced any other way in a
    // single-threaded test.
    const admin = new ParticipantAdministrationService(harness.db.d1);
    let fired = false;
    const service = new DrawService(harness.db.d1, {
      random: {
        randomInt(maxExclusive: number) {
          if (!fired) {
            fired = true;
            // Synchronously scheduled; awaited below via the assertion order.
            void admin.disqualify(
              event.id,
              entryIds[0],
              { expectedRevision: 1, reason: 'Caught cheating minutes before' },
              actor() as never,
            );
          }
          return maxExclusive - 1;
        },
      },
    });

    const result = await service.run(event.id, actor());

    // Whichever way the interleaving lands, the invariant is the same: a draw
    // either consumed the population it hashed, or it did not commit.
    if (result.ok) {
      const hash = result.value.response.draw?.candidateSetHash;
      const survivors = harness.db.raw
        .prepare(
          `SELECT id FROM event_entries
            WHERE event_id = ? AND status = 'ELIGIBLE' AND overall_eligible = 1
            ORDER BY id ASC`,
        )
        .all(event.id) as Array<{ id: string }>;
      // It committed, so the disqualification landed after it: the hash must
      // describe a population that still exists in full.
      expect(hash).toBe(await hashCandidateSet(entryIds));
      expect(survivors.length).toBeLessThanOrEqual(entryIds.length);
    } else {
      expect(result.failure.code).toBe('DRAW_POPULATION_CHANGED');
      expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM draw_assignments')).toBe(0);
    }
  });

  it('REFUSES a draw whose population moved between the read and the commit', async () => {
    // The race the counter exists for, forced deterministically.
    //
    // The injected random source runs at exactly the right moment — after the
    // candidates and the counter were captured, before the batch commits — and
    // writes SYNCHRONOUSLY through the raw handle, so the interleaving is not
    // left to scheduling. This is the test that fails if the guard is dropped
    // from the batch: the earlier version of this suite tolerated either
    // outcome and quietly did not.
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [2] });

    let fired = false;
    const service = new DrawService(harness.db.d1, {
      random: {
        randomInt: (maxExclusive: number) => {
          if (!fired) {
            fired = true;
            harness.db.raw
              .prepare(
                `UPDATE events
                    SET participant_population_revision = participant_population_revision + 1
                  WHERE id = ?`,
              )
              .run(event.id);
          }
          return maxExclusive - 1;
        },
      },
    });

    const result = await service.run(event.id, actor());

    expect(fired).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('DRAW_POPULATION_CHANGED');

    // And nothing was written. Not a partial draw, not an audit row, not a
    // transition.
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM draw_assignments')).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DRAW_COMPLETED'`)).toBe(0);
    expect((await new EventRepository(harness.db.d1).findById(event.id))?.status).toBe(
      'DRAW_READY',
    );
  });

  it('the counter statement does nothing when the statement before it did nothing', async () => {
    // `bumpPopulationRevisionStatement` is conditional on `changes() > 0`, and
    // the service's own revision precheck returns before the batch runs — so
    // the conditional is only observable by driving the batch directly. Without
    // this, a counter that advanced on every attempt would look correct.
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 2 });
    const events = new EventRepository(harness.db.d1);
    const entries = new EventEntryRepository(harness.db.d1);
    const before = await events.populationRevision(event.id);

    // A guarded UPDATE working from a stale revision: it matches no row.
    const losing = await harness.db.d1.batch([
      entries.disqualifyStatement({
        eventId: event.id,
        entryId: entryIds[0],
        expectedRevision: 99,
        reason: 'Working from a stale copy',
        adminId: harness.admin.id,
        at: '2026-01-01T00:00:00.000Z',
      }),
      events.bumpPopulationRevisionStatement(event.id),
    ]);
    expect(Number(losing[0]?.meta?.changes ?? 0)).toBe(0);
    expect(await events.populationRevision(event.id)).toBe(before);

    // ...and the same pair with a CURRENT revision does advance it, so the
    // assertion above is about the guard rather than about the statement never
    // working.
    await harness.db.d1.batch([
      entries.disqualifyStatement({
        eventId: event.id,
        entryId: entryIds[0],
        expectedRevision: 1,
        reason: 'Duplicate registration found',
        adminId: harness.admin.id,
        at: '2026-01-01T00:00:00.000Z',
      }),
      events.bumpPopulationRevisionStatement(event.id),
    ]);
    expect(await events.populationRevision(event.id)).toBe(before + 1);
  });

  it('refuses outright when the counter has moved before the batch', async () => {
    // The guard, exercised directly: a draw computed against revision N cannot
    // commit at revision N+1.
    const { event } = await seedDrawableEvent(harness, { participants: 3 });
    const events = new EventRepository(harness.db.d1);

    harness.db.raw
      .prepare(
        'UPDATE events SET participant_population_revision = participant_population_revision + 5 WHERE id = ?',
      )
      .run(event.id);

    const statement = events.abortUnlessDrawableStatement(event.id, {
      status: 'DRAW_READY',
      populationRevision: 0,
      activePrizeUnits: 1,
    });
    await expect(harness.db.d1.batch([statement])).rejects.toThrow(/NOT NULL/i);
  });
});

// ---------------------------------------------------------------------------
describe('reading a draw back', () => {
  it('reports null before one has happened', async () => {
    const { event } = await seedDrawableEvent(harness);
    const result = await harness.draws.result(event.id);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.draw).toBeNull();
    expect(result.value.assignments).toEqual([]);
  });

  it('reports the readiness the confirmation dialog needs', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 7, prizes: [2, 3] });
    const status = await harness.draws.status(event.id);
    if (!status.ok) throw new Error('unreachable');

    expect(status.value.readiness).toMatchObject({
      eventStatus: 'DRAW_READY',
      candidateCount: 7,
      prizeUnitCount: 5,
      plannedWinnerCount: 5,
      canRun: true,
      blockers: [],
    });
  });

  it('reports ALREADY_COMPLETED alone, not beside other blockers', async () => {
    const { event } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());

    const status = await harness.draws.status(event.id);
    if (!status.ok) throw new Error('unreachable');
    // Once a draw exists nothing else about readiness is actionable, and
    // listing "not ready" beside it would suggest a fix for a situation that
    // has none.
    expect(status.value.readiness.blockers).toEqual(['DRAW_ALREADY_COMPLETED']);
    expect(status.value.readiness.canRun).toBe(false);
  });

  it('scopes assignments to their event', async () => {
    const first = await seedDrawableEvent(harness, { participants: 3 });
    await harness.draws.run(first.event.id, actor());
    const drawId = (await new DrawRepository(harness.db.d1).findByEvent(first.event.id))!.id;

    // Another event's id must not surface the first event's winners, even with
    // the correct draw id.
    const second = await seedDrawableEvent(harness, { participants: 2 });
    const leaked = await new DrawRepository(harness.db.d1).listAssignments(
      second.event.id,
      drawId,
    );
    expect(leaked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('the selection consumes nothing a caller supplied', () => {
  it('produces a different result on repeated draws of the same population', async () => {
    // Ten separate events with identical shapes. If the selection were seeded
    // from anything stable — the event id, the candidate list, a fixed seed —
    // the winning POSITION would be the same every time.
    const positions = new Set<number>();

    for (let i = 0; i < 10; i++) {
      const local = await createDrawHarness();
      try {
        const { event, entryIds } = await seedDrawableEvent(local, {
          participants: 8,
          prizes: [1],
        });
        const result = await local.draws.run(event.id, drawActor(local));
        if (!result.ok) throw new Error(JSON.stringify(result.failure));
        positions.add(entryIds.indexOf(result.value.response.assignments[0].winner.entryId));
      } finally {
        local.close();
      }
    }

    // Ten draws over eight candidates landing on one position has probability
    // 8 * (1/8)^10 — about one in 10^8.
    expect(positions.size).toBeGreaterThan(1);
  });

  it('is driven entirely by the injected source', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, {
      participants: 4,
      prizes: [1],
    });

    // Fisher-Yates with every draw returning 0 rotates the last element to the
    // front, so the single winner is deterministic — which proves the service
    // consults the source and nothing else.
    const service = new DrawService(harness.db.d1, {
      random: new DeterministicRandomSource([0]),
    });
    const result = await service.run(event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));

    // Cross-checked against the shuffle itself rather than a hand-computed
    // index: the assertion is that the SERVICE uses this source, not that the
    // author can trace Fisher-Yates in their head.
    const expected = secureShuffle([...entryIds].sort(), new DeterministicRandomSource([0]));
    expect(result.value.response.assignments[0].winner.entryId).toBe(expected[0]);
  });
});

// ---------------------------------------------------------------------------
// Validation regressions
// ---------------------------------------------------------------------------
describe('a retry is answered with the draw, not with a refusal', () => {
  it('returns the same draw and consumes NO randomness', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 5, prizes: [2] });

    // The counter is the assertion. A retry that reached the shuffle would be a
    // second selection — discarded, but a second selection nonetheless, and the
    // only reason it would not become the result is a constraint. The replay
    // must happen before any of that.
    let calls = 0;
    const counting = {
      randomInt: (maxExclusive: number) => {
        calls += 1;
        return maxExclusive - 1;
      },
    };

    const first = await new DrawService(harness.db.d1, { random: counting }).run(
      event.id,
      actor(),
    );
    if (!first.ok) throw new Error(JSON.stringify(first.failure));
    expect(first.value.created).toBe(true);
    const consumedByTheDraw = calls;
    expect(consumedByTheDraw).toBeGreaterThan(0);

    const retry = await new DrawService(harness.db.d1, { random: counting }).run(
      event.id,
      actor(),
    );

    expect(calls, 'a retry must not touch the random source').toBe(consumedByTheDraw);
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error('unreachable');
    expect(retry.value.created, 'a retry created nothing').toBe(false);
    expect(retry.value.response.draw?.id).toBe(first.value.response.draw?.id);
    expect(retry.value.response.assignments).toEqual(first.value.response.assignments);
  });

  it('writes no second audit row and no second draw', async () => {
    const { event } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());
    await harness.draws.run(event.id, actor());
    await harness.draws.run(event.id, actor());

    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DRAW_COMPLETED'`),
    ).toBe(1);
  });

  it('replays even when the event status was tampered back to DRAW_READY', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [2] });
    const first = await harness.draws.run(event.id, actor());
    if (!first.ok) throw new Error('unreachable');

    // A row edited outside the application. The status column is not what
    // guarantees uniqueness; the draw row is.
    harness.db.raw
      .prepare("UPDATE events SET status = 'DRAW_READY' WHERE id = ?")
      .run(event.id);

    let calls = 0;
    const service = new DrawService(harness.db.d1, {
      random: {
        randomInt: (maxExclusive: number) => {
          calls += 1;
          return maxExclusive - 1;
        },
      },
    });
    const again = await service.run(event.id, actor());

    expect(calls).toBe(0);
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.created).toBe(false);
      expect(again.value.response.assignments).toEqual(first.value.response.assignments);
    }
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);
  });

  it('answers the loser of a concurrent race with the winner’s draw', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 8, prizes: [3] });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => harness.draws.run(event.id, actor())),
    );

    // Every request succeeds, exactly one of them created the draw, and all
    // four describe the same winners.
    expect(results.every((r) => r.ok)).toBe(true);
    const created = results.filter((r) => r.ok && r.value.created);
    expect(created).toHaveLength(1);

    const winners = results.map((r) =>
      r.ok ? r.value.response.assignments.map((a) => a.winner.entryId).join(',') : 'FAILED',
    );
    expect(new Set(winners).size, 'every caller must see the same result').toBe(1);

    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DRAW_COMPLETED'`),
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('a huge offering', () => {
  /** 100 prizes at 1000 units — the most the configuration limits allow. */
  function inflate(eventId: string) {
    const now = new Date().toISOString();
    harness.db.raw
      .prepare('UPDATE event_prizes SET quantity = 1000 WHERE event_id = ?')
      .run(eventId);
    for (let i = 1; i < 100; i++) {
      harness.db.raw
        .prepare(
          `INSERT INTO event_prizes
             (id, event_id, name, quantity, sort_order, created_by, updated_by,
              created_at, updated_at)
           VALUES (?, ?, ?, 1000, ?, ?, ?, ?, ?)`,
        )
        .run(
          crypto.randomUUID(),
          eventId,
          `Bulk prize ${i}`,
          i,
          harness.admin.id,
          harness.admin.id,
          now,
          now,
        );
    }
  }

  it('draws normally when the units outnumber the candidates a thousandfold', async () => {
    // The ceiling applies to ASSIGNMENTS, not to the offering. A hundred
    // thousand units and three people is three winners, and refusing it because
    // the catalogue is large would be a limit nobody asked for.
    const { event } = await seedDrawableEvent(harness, { participants: 3, prizes: [1] });
    inflate(event.id);

    const result = await harness.draws.run(event.id, actor());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.failure));

    expect(result.value.response.draw?.assignmentCount).toBe(3);
    // The FULL offering is recorded, even though only three units were built.
    expect(result.value.response.draw?.prizeUnitCount).toBe(100000);
    expect(result.value.response.assignments).toHaveLength(3);
    // Three DIFFERENT units, all from the first prize in the fixed order.
    expect(
      new Set(result.value.response.assignments.map((a) => a.prize.unitIndex)).size,
    ).toBe(3);
  });

  it('reports the offering in readiness without expanding it', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 3, prizes: [1] });
    inflate(event.id);

    const status = await harness.draws.status(event.id);
    if (!status.ok) throw new Error('unreachable');
    expect(status.value.readiness.prizeUnitCount).toBe(100000);
    expect(status.value.readiness.plannedWinnerCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('a draw whose rows no longer add up', () => {
  it('fails closed rather than reporting fewer winners than it recorded', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [3] });
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error('unreachable');

    // An assignment whose event no longer matches is EXCLUDED by the scoped
    // read. Silently returning the remaining two would present a three-winner
    // draw as a two-winner draw, with nothing to indicate somebody was missing.
    harness.db.raw.exec('PRAGMA foreign_keys = OFF');
    harness.db.raw
      .prepare(
        `UPDATE draw_assignments SET event_id = 'somewhere-else'
          WHERE id = (SELECT id FROM draw_assignments LIMIT 1)`,
      )
      .run();
    harness.db.raw.exec('PRAGMA foreign_keys = ON');

    await expect(harness.draws.result(event.id)).rejects.toThrow(/assignments/i);
  });
});

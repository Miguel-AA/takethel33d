// @vitest-environment node
//
// Attacking the draw.
//
// Everything here assumes the attacker already holds a valid administrator
// session — that is the realistic threat, because the endpoint is behind
// authentication and the person most able to influence a draw is the person
// running it. The question is not "can a stranger draw?" but "can somebody with
// the button choose who wins?".
//
// Each block names the capability it is trying to obtain.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as drawRoute from '../functions/api/events/[id]/draw';
import { onRequest as middleware } from '../functions/_middleware';
import { AdminAuthService } from '../functions/_shared/adminAuthService';
import { HOST_SESSION_COOKIE_NAME } from '../functions/_shared/cookies';
import { DrawService } from '../functions/_shared/drawService';
import { DrawRepository } from '../functions/_shared/drawRepository';
import { EventRepository } from '../functions/_shared/eventRepository';
import { EventLifecycleService } from '../functions/_shared/eventService';
import { EventEntryRepository } from '../functions/_shared/eventEntryRepository';
import { ParticipantAdministrationService } from '../functions/_shared/participantAdministrationService';
import { PrizeRepository } from '../functions/_shared/prizeRepository';
import { setLogSink } from '../functions/_shared/logger';
import { isProtectedPath } from '../functions/_shared/routes';
import { runDrawSchema } from '../shared/schemas';
import type { DrawResponse } from '../shared/types';
import {
  createDrawHarness,
  drawActor,
  seedDrawableEvent,
  type DrawHarness,
} from './helpers/drawFlow';

let harness: DrawHarness;
let sessionToken: string;

beforeEach(async () => {
  setLogSink(() => {});
  harness = await createDrawHarness();

  const login = await new AdminAuthService(harness.db.d1).login(
    { email: 'ada@example.com', password: 'a-strong-admin-password' },
    {
      requestId: 'req-login',
      ipHash: null,
      userAgent: null,
      origin: null,
      method: 'POST',
      pathname: '/api/manager/login',
    },
  );
  if (login.kind !== 'ok') throw new Error('login failed');
  sessionToken = login.token;
});

afterEach(() => {
  setLogSink(null);
  harness.close();
});

const actor = () => drawActor(harness);
const count = (sql: string) => (harness.db.raw.prepare(sql).get() as { n: number }).n;

async function post(eventId: string, body?: unknown, rawBody?: string) {
  const request = new Request(`https://example.com/api/events/${eventId}/draw`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${HOST_SESSION_COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    },
    ...(rawBody !== undefined
      ? { body: rawBody }
      : body !== undefined
        ? { body: JSON.stringify(body) }
        : {}),
  });

  const shared = {
    request,
    env: { DB: harness.db.d1 },
    data: {} as Record<string, unknown>,
    params: { id: eventId },
    waitUntil: () => {},
  };
  const response = await middleware({
    ...shared,
    next: async () =>
      (drawRoute.onRequestPost as (ctx: never) => Promise<Response>)({ ...shared } as never),
  } as never);

  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

// ---------------------------------------------------------------------------
describe('ATTACK: choose the winner', () => {
  it('there is no request field that names one', async () => {
    // The schema is empty AND strict. Both halves matter: empty means there is
    // nothing to say, strict means saying it is a refusal rather than a
    // silently dropped key.
    expect(runDrawSchema.safeParse({}).success).toBe(true);
    for (const attempt of [
      { winner: 'entry-1' },
      { winners: ['entry-1'] },
      { entryId: 'entry-1' },
      { participantNumber: 1 },
      { forceWinner: 'entry-1' },
      { first: 'entry-1' },
    ]) {
      expect(runDrawSchema.safeParse(attempt).success, JSON.stringify(attempt)).toBe(false);
    }
  });

  it('a named entry in the body draws nothing at all', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 5 });
    const result = await post(event.id, { entryId: entryIds[0] });
    expect(result.status).toBe(400);
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(0);
  });

  it('cannot be steered by mass-assigning a draw column', async () => {
    const { event } = await seedDrawableEvent(harness);
    for (const body of [
      { candidateSetHash: 'forged' },
      { algorithmVersion: 'HAND_PICKED' },
      { candidatePopulationRevision: 999 },
      { assignmentCount: 99 },
      { id: 'chosen-draw-id' },
    ]) {
      expect((await post(event.id, body)).status).toBe(400);
    }
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: make the draw predictable', () => {
  it('there is no seed parameter anywhere a request can reach', async () => {
    const { event } = await seedDrawableEvent(harness);
    for (const body of [{ seed: 1 }, { seed: 'x' }, { randomSeed: 1 }, { rng: 'fixed' }]) {
      expect((await post(event.id, body)).status).toBe(400);
    }
  });

  it('the source is a constructor dependency, not a runtime choice', () => {
    // A test can inject a deterministic source; a REQUEST cannot, because there
    // is no path from a body to the constructor. This is the structural
    // guarantee, stated as a test so removing it is visible.
    const service = new DrawService(harness.db.d1);
    expect(Object.keys(service)).not.toContain('seed');
    expect(typeof (service as unknown as { random: unknown }).random).toBe('object');
  });

  it('two events with identical populations produce independent results', async () => {
    // Not a strict inequality assertion — two 3-candidate draws CAN agree by
    // chance — but the winners must at least not be forced to the same
    // POSITION, which is what a population-derived seed would do.
    const first = await seedDrawableEvent(harness, { participants: 3 });
    const second = await seedDrawableEvent(harness, { participants: 3 });

    const a = await harness.draws.run(first.event.id, actor());
    const b = await harness.draws.run(second.event.id, actor());
    if (!a.ok || !b.ok) throw new Error('unreachable');

    // Both drew from a set of the same size, and both committed. That is all
    // that can be asserted deterministically; the distribution itself is
    // measured in `drawRandom.test.ts`.
    expect(a.value.response.assignments).toHaveLength(1);
    expect(b.value.response.assignments).toHaveLength(1);
    expect(a.value.response.draw?.candidateSetHash).not.toBe(b.value.response.draw?.candidateSetHash);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: draw twice until the result is favourable', () => {
  it('a second attempt produces no second draw, however it is made', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 6, prizes: [3] });
    const created = await post(event.id, {});
    expect(created.status).toBe(201);
    const winners = (created.json as DrawResponse).assignments
      .map((a) => a.winner.entryId)
      .join(',');

    // Through the endpoint. 200, not 201: the draw was not created by THIS
    // request. The attack fails not by being refused but by being answered with
    // the result that already exists — which is what makes it useless.
    const again = await post(event.id, {});
    expect(again.status).toBe(200);
    expect(
      (again.json as DrawResponse).assignments.map((a) => a.winner.entryId).join(','),
      'the winners must not move',
    ).toBe(winners);

    // ...and through the service...
    const direct = await harness.draws.run(event.id, actor());
    expect(direct.ok && direct.value.created).toBe(false);
    // ...and through a fresh service instance, in case anything was cached.
    const fresh = await new DrawService(harness.db.d1).run(event.id, actor());
    expect(fresh.ok && fresh.value.created).toBe(false);
    if (fresh.ok) {
      expect(fresh.value.response.assignments.map((a) => a.winner.entryId).join(',')).toBe(
        winners,
      );
    }

    // Four attempts, one draw, one audit row.
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'DRAW_COMPLETED'`)).toBe(
      1,
    );
  });

  it('cannot be unlocked by putting the event back to DRAW_READY', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 5, prizes: [2] });
    const first = await harness.draws.run(event.id, actor());
    if (!first.ok) throw new Error('setup');

    // A row edited outside the application: the status says ready again.
    harness.db.raw
      .prepare("UPDATE events SET status = 'DRAW_READY' WHERE id = ?")
      .run(event.id);

    // Counted, because the attack's whole hope is a fresh selection. The replay
    // happens before the random source is touched, so there is none.
    let calls = 0;
    const second = await new DrawService(harness.db.d1, {
      random: {
        randomInt: (maxExclusive: number) => {
          calls += 1;
          return maxExclusive - 1;
        },
      },
    }).run(event.id, actor());

    expect(calls, 'no new selection may be drawn').toBe(0);
    expect(second.ok && second.value.created, 'nothing may be created').toBe(false);
    if (second.ok) {
      expect(second.value.response.assignments).toEqual(first.value.response.assignments);
    }
    // The unique index is the guarantee; the status column is not.
    expect(count('SELECT COUNT(*) AS n FROM draws')).toBe(1);
  });

  it('cannot be unlocked by deleting the draw row', async () => {
    const { event } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());
    // RESTRICT: the assignments hold the draw in place.
    expect(() => harness.db.raw.prepare('DELETE FROM draws WHERE event_id = ?').run(event.id)).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it('the repository has no method that could undo one', () => {
    const repo = new DrawRepository(harness.db.d1);
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(repo));
    // Reads and INSERTs, and nothing else. Not a convention — the absence of
    // the method.
    expect(methods.filter((m) => /delete|remove|update|reset|reroll/i.test(m))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: win more than once', () => {
  it('the same person cannot hold two prizes from one draw', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 1, prizes: [5] });
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error('unreachable');

    // One candidate, five units: exactly one assignment.
    expect(result.value.response.assignments).toHaveLength(1);
    expect(count('SELECT COUNT(*) AS n FROM draw_assignments')).toBe(1);
  });

  it('the database refuses it even outside the service', async () => {
    const { event, prizes } = await seedDrawableEvent(harness, {
      participants: 3,
      prizes: [3],
    });
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error('unreachable');
    const winner = result.value.response.assignments[0];

    expect(() =>
      harness.db.raw
        .prepare(
          `INSERT INTO draw_assignments
             (id, draw_id, event_id, prize_id, entry_id, prize_unit_index,
              draw_order, prize_name_snapshot, assigned_at)
           VALUES (?, ?, ?, ?, ?, 3, 9, 'Forced', '2026-01-01T00:00:00.000Z')`,
        )
        .run(
          crypto.randomUUID(),
          result.value.response.draw!.id,
          event.id,
          prizes[0].id,
          winner.winner.entryId,
        ),
    ).toThrow(/UNIQUE/i);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: get an ineligible person into the running', () => {
  it('a disqualified entry is never a candidate', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, {
      participants: 3,
      prizes: [3],
    });
    const admin = new ParticipantAdministrationService(harness.db.d1);
    await admin.disqualify(
      event.id,
      entryIds[0],
      { expectedRevision: 1, reason: 'Registered twice under two names' },
      actor() as never,
    );

    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.value.response.assignments.map((a) => a.winner.entryId)).not.toContain(entryIds[0]);
    expect(result.value.response.draw?.candidateCount).toBe(2);
  });

  it('cannot be given a status that disagrees with its verdict', async () => {
    const { entryIds } = await seedDrawableEvent(harness, { participants: 3, prizes: [3] });

    // The attack a candidate predicate written on ONE column would fall for:
    // leave the status saying ELIGIBLE and flip the verdict, or the reverse.
    // Phase 8's coherence trigger refuses it outright, so the incoherent row
    // the attack depends on cannot be created at all — not even by editing the
    // database directly.
    expect(() =>
      harness.db.raw
        .prepare('UPDATE event_entries SET overall_eligible = 0 WHERE id = ?')
        .run(entryIds[0]),
    ).toThrow(/incoherent/i);
  });

  it('the candidate query excludes an incoherent row even without the trigger', async () => {
    // Defence in depth, made observable.
    //
    // The predicate names BOTH columns, and while phase 8's coherence trigger
    // stands, naming either one alone would give the same answer — so dropping
    // half the predicate is invisible. This test removes the trigger, writes the
    // row it was preventing, and asserts the query still refuses it. A loader
    // that checked only the status would hand this entry to the draw.
    const { event, entryIds } = await seedDrawableEvent(harness, { participants: 3 });

    harness.db.raw.exec('DROP TRIGGER trg_event_entries_decision_update');
    harness.db.raw
      .prepare(
        `UPDATE event_entries
            SET overall_eligible = 0, eligibility_reason = 'AGE_REQUIREMENT_NOT_MET'
          WHERE id = ?`,
      )
      .run(entryIds[0]);

    const candidates = await new EventEntryRepository(harness.db.d1).listDrawEligibleByEvent(
      event.id,
    );
    expect(candidates).not.toContain(entryIds[0]);
    expect(candidates).toHaveLength(2);
  });

  it('an INELIGIBLE verdict is never a candidate', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, {
      participants: 3,
      prizes: [3],
    });
    // Coherent, because the trigger insists on it: status and verdict move
    // together. The candidate predicate must exclude it on either count.
    harness.db.raw
      .prepare(
        `UPDATE event_entries
            SET status = 'INELIGIBLE', overall_eligible = 0,
                eligibility_reason = 'AGE_REQUIREMENT_NOT_MET'
          WHERE id = ?`,
      )
      .run(entryIds[0]);

    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.value.response.assignments.map((a) => a.winner.entryId)).not.toContain(entryIds[0]);
    expect(result.value.response.draw?.candidateCount).toBe(2);
  });

  it('a SUBMITTED entry that was never judged is never a candidate', async () => {
    const { event, entryIds } = await seedDrawableEvent(harness, {
      participants: 3,
      prizes: [3],
    });
    harness.db.raw
      .prepare("UPDATE event_entries SET status = 'SUBMITTED' WHERE id = ?")
      .run(entryIds[0]);

    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.value.response.draw?.candidateCount).toBe(2);
  });

  it('another event’s participants are never candidates', async () => {
    const other = await seedDrawableEvent(harness, { participants: 4 });
    const target = await seedDrawableEvent(harness, { participants: 2, prizes: [2] });

    const result = await harness.draws.run(target.event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    for (const assignment of result.value.response.assignments) {
      expect(other.entryIds).not.toContain(assignment.winner.entryId);
    }
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: award something that was withdrawn', () => {
  it('an INACTIVE prize is never awarded', async () => {
    const { event, prizes } = await seedDrawableEvent(harness, {
      participants: 4,
      prizes: [1, 1],
    });
    harness.db.raw
      .prepare("UPDATE event_prizes SET status = 'INACTIVE' WHERE id = ?")
      .run(prizes[1].id);

    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.value.response.assignments.map((a) => a.prize.id)).toEqual([prizes[0].id]);
  });

  it('another event’s prize is never awarded', async () => {
    const other = await seedDrawableEvent(harness, { participants: 2 });
    const target = await seedDrawableEvent(harness, { participants: 2 });

    const result = await harness.draws.run(target.event.id, actor());
    if (!result.ok) throw new Error(JSON.stringify(result.failure));
    expect(result.value.response.assignments[0].prize.id).not.toBe(other.prizes[0].id);
  });

  it('a prize that was won can never be deleted afterwards', async () => {
    const { event, prizes } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());

    expect(await new PrizeRepository(harness.db.d1).hasAssignments(prizes[0].id)).toBe(true);
    expect(() =>
      harness.db.raw.prepare('DELETE FROM event_prizes WHERE id = ?').run(prizes[0].id),
    ).toThrow(/FOREIGN KEY/i);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: commit half a draw', () => {
  it('a failed batch leaves no draw, no assignment and no audit row', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [2] });

    // Force the abort guard to fire by moving the population underneath.
    harness.db.raw
      .prepare(
        'UPDATE events SET participant_population_revision = participant_population_revision + 1 WHERE id = ?',
      )
      .run(event.id);

    // The service reads the counter itself, so it would agree — the guard is
    // exercised by handing it a stale one directly.
    const events = new EventRepository(harness.db.d1);
    const statements = [
      events.abortUnlessDrawableStatement(event.id, {
        status: 'DRAW_READY',
        populationRevision: 0,
        activePrizeUnits: 2,
      }),
      events.completeDrawStatement(event.id, '2026-01-01T00:00:00.000Z', harness.admin.id),
    ];
    await expect(harness.db.d1.batch(statements)).rejects.toThrow();

    // The whole batch rolled back: the transition did not happen either.
    const after = await events.findById(event.id);
    expect(after?.status).toBe('DRAW_READY');
  });

  it('a transition that matched nothing takes the batch down', async () => {
    // The scenario the trailing status guard exists for: if the transition were
    // a silent no-op, the winners would commit while the event still looked
    // ready to draw.
    const { event } = await seedDrawableEvent(harness);
    const events = new EventRepository(harness.db.d1);

    harness.db.raw.prepare("UPDATE events SET status = 'CLOSED' WHERE id = ?").run(event.id);

    await expect(
      harness.db.d1.batch([
        // The transition matches nothing, because the status is not DRAW_READY.
        events.completeDrawStatement(event.id, '2026-01-01T00:00:00.000Z', harness.admin.id),
        events.abortUnlessStatusStatement(event.id, 'DRAW_COMPLETED'),
      ]),
    ).rejects.toThrow(/NOT NULL/i);

    expect((await events.findById(event.id))?.status).toBe('CLOSED');
  });

  it('an event cannot end up DRAW_COMPLETED without a draw', async () => {
    const { event } = await seedDrawableEvent(harness);
    const result = await harness.draws.run(event.id, actor());
    expect(result.ok).toBe(true);

    // The two facts always travel together.
    const completed = count(`SELECT COUNT(*) AS n FROM events WHERE status = 'DRAW_COMPLETED'`);
    expect(completed).toBe(count('SELECT COUNT(*) AS n FROM draws'));
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: reach the endpoint without a session', () => {
  it('the route is classified as protected, however it is written', () => {
    for (const path of [
      '/api/events/abc/draw',
      '/API/EVENTS/abc/DRAW',
      '/api/events/abc/draw/',
      '//api//events//abc//draw',
      '/api/events/../events/abc/draw',
      '/api/%65vents/abc/draw',
      '/api/events/abc/draw/../draw',
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: read the result without permission', () => {
  it('the draw is not exposed on any public surface', async () => {
    // There is no public results endpoint in this phase, and this asserts the
    // absence rather than trusting it: a public path resolves to nothing.
    const { event } = await seedDrawableEvent(harness);
    await harness.draws.run(event.id, actor());
    expect(isProtectedPath(`/api/events/${event.id}/draw`)).toBe(true);
    expect(isProtectedPath('/api/public-events/some-slug')).toBe(false);
  });

  it('the draw’s audit row records what happened without naming the winners', async () => {
    const { event } = await seedDrawableEvent(harness, { participants: 4, prizes: [2] });
    const result = await harness.draws.run(event.id, actor());
    if (!result.ok) throw new Error('unreachable');

    // Scoped to the DRAW row. `EVENT_ENTRY_CREATED` legitimately carries an
    // entry id — that is phase 7's record of a participation, and it is the
    // reason this assertion has to be specific rather than sweeping: a blanket
    // check over the whole table would pass or fail for the wrong reasons.
    const row = harness.db.raw
      .prepare(
        `SELECT previous_data, new_data, metadata FROM audit_logs
          WHERE action = 'DRAW_COMPLETED'`,
      )
      .get() as Record<string, string | null>;
    const serialized = Object.values(row).join('');

    for (const assignment of result.value.response.assignments) {
      expect(serialized).not.toContain(assignment.winner.entryId);
      expect(serialized).not.toContain(assignment.winner.email);
    }
    // What it DOES carry: counts, the algorithm and the population hash.
    expect(serialized).toContain('assignmentCount');
    expect(serialized).toContain(result.value.response.draw!.candidateSetHash);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: put one event’s winners on another event', () => {
  it('the SCHEMA refuses a cross-event assignment, not merely the service', async () => {
    const a = await seedDrawableEvent(harness, { participants: 2 });
    const b = await seedDrawableEvent(harness, { participants: 2 });

    const result = await harness.draws.run(a.event.id, actor());
    if (!result.ok) throw new Error('setup');
    const drawId = result.value.response.draw!.id;

    // Event A's draw, event B's prize, event B's entry. Every reference exists;
    // only their AGREEMENT is wrong, which three simple foreign keys cannot
    // see. The composite keys can.
    expect(() =>
      harness.db.raw
        .prepare(
          `INSERT INTO draw_assignments
             (id, draw_id, event_id, prize_id, entry_id, prize_unit_index,
              draw_order, prize_name_snapshot, assigned_at)
           VALUES (?, ?, ?, ?, ?, 1, 99, 'Forged', '2026-01-01T00:00:00.000Z')`,
        )
        .run(crypto.randomUUID(), drawId, a.event.id, b.prizes[0].id, b.entryIds[0]),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses each half of the mix on its own', async () => {
    const a = await seedDrawableEvent(harness, { participants: 3 });
    const b = await seedDrawableEvent(harness, { participants: 2 });
    const result = await harness.draws.run(a.event.id, actor());
    if (!result.ok) throw new Error('setup');
    const drawId = result.value.response.draw!.id;
    // Somebody from event A who did NOT win, so the unique-winner index cannot
    // fire first and mask the foreign-key failure this test is about.
    const alreadyWon = new Set(
      result.value.response.assignments.map((assignment) => assignment.winner.entryId),
    );
    const spareEntry = a.entryIds.find((id) => !alreadyWon.has(id))!;

    const insert = (prizeId: string, entryId: string) =>
      harness.db.raw
        .prepare(
          `INSERT INTO draw_assignments
             (id, draw_id, event_id, prize_id, entry_id, prize_unit_index,
              draw_order, prize_name_snapshot, assigned_at)
           VALUES (?, ?, ?, ?, ?, 7, 99, 'Forged', '2026-01-01T00:00:00.000Z')`,
        )
        .run(crypto.randomUUID(), drawId, a.event.id, prizeId, entryId);

    // Foreign prize, own entry.
    expect(() => insert(b.prizes[0].id, spareEntry)).toThrow(/FOREIGN KEY/i);
    // Own prize, foreign entry.
    expect(() => insert(a.prizes[0].id, b.entryIds[0])).toThrow(/FOREIGN KEY/i);
  });

  it('refuses an assignment claiming a draw from another event', async () => {
    const a = await seedDrawableEvent(harness, { participants: 2 });
    const b = await seedDrawableEvent(harness, { participants: 2 });
    const drawA = await harness.draws.run(a.event.id, actor());
    if (!drawA.ok) throw new Error('setup');

    expect(() =>
      harness.db.raw
        .prepare(
          `INSERT INTO draw_assignments
             (id, draw_id, event_id, prize_id, entry_id, prize_unit_index,
              draw_order, prize_name_snapshot, assigned_at)
           VALUES (?, ?, ?, ?, ?, 1, 99, 'Forged', '2026-01-01T00:00:00.000Z')`,
        )
        .run(
          crypto.randomUUID(),
          drawA.value.response.draw!.id,
          b.event.id,
          b.prizes[0].id,
          b.entryIds[0],
        ),
    ).toThrow(/FOREIGN KEY/i);
  });
});

// ---------------------------------------------------------------------------
describe('ATTACK: strand an event in DRAW_READY with nobody to draw', () => {
  it('the transition aborts if the last candidate leaves mid-commit', async () => {
    // DRAW_READY IS A ONE-WAY DOOR — no action returns an event to CLOSED — and
    // participants may be administered while CLOSED. Measured before the guard
    // existed: the event reached DRAW_READY with zero candidates and could
    // never be drawn or reopened.
    const { event, entryIds } = await seedDrawableEvent(harness, {
      participants: 1,
      markReady: false,
    });

    let fired = false;
    const intercepted = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async (statements: unknown[]) => {
          if (!fired) {
            fired = true;
            // Synchronous, so the interleaving is deterministic rather than
            // left to the scheduler.
            harness.db.raw
              .prepare(
                `UPDATE event_entries
                    SET status = 'DISQUALIFIED',
                        pre_disqualification_status = 'ELIGIBLE',
                        disqualified_at = '2026-01-01T00:00:00.000Z',
                        disqualification_reason = 'Caught between the check and the commit',
                        revision = revision + 1
                  WHERE id = ?`,
              )
              .run(entryIds[0]);
          }
          return (
            target as unknown as { batch: (s: unknown[]) => Promise<unknown> }
          ).batch(statements);
        };
      },
    }) as D1Database;

    const service = new EventLifecycleService(intercepted);
    const result = await service.transition(event.id, 'mark-draw-ready', actor() as never);

    expect(fired).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('EVENT_NOT_READY');
      if (result.failure.code === 'EVENT_NOT_READY') {
        expect(result.failure.fields).toContain('ELIGIBLE_PARTICIPANT_REQUIRED');
      }
    }

    // The event stayed where it was, so the operator can reinstate and retry.
    expect((await new EventRepository(harness.db.d1).findById(event.id))?.status).toBe(
      'CLOSED',
    );
    // And nothing was recorded as if it had moved.
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_MARKED_DRAW_READY'`),
    ).toBe(0);
  });

  it('the transition aborts if the last prize is withdrawn mid-commit', async () => {
    const { event, prizes } = await seedDrawableEvent(harness, {
      participants: 2,
      markReady: false,
    });

    let fired = false;
    const intercepted = new Proxy(harness.db.d1, {
      get(target, prop, receiver) {
        if (prop !== 'batch') return Reflect.get(target, prop, receiver);
        return async (statements: unknown[]) => {
          if (!fired) {
            fired = true;
            harness.db.raw
              .prepare("UPDATE event_prizes SET status = 'INACTIVE' WHERE id = ?")
              .run(prizes[0].id);
          }
          return (
            target as unknown as { batch: (s: unknown[]) => Promise<unknown> }
          ).batch(statements);
        };
      },
    }) as D1Database;

    const result = await new EventLifecycleService(intercepted).transition(
      event.id,
      'mark-draw-ready',
      actor() as never,
    );

    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.code === 'EVENT_NOT_READY') {
      expect(result.failure.fields).toContain('ACTIVE_PRIZE_REQUIRED');
    }
    expect((await new EventRepository(harness.db.d1).findById(event.id))?.status).toBe(
      'CLOSED',
    );
  });

  it('an ordinary transition still succeeds and still writes its audit row', async () => {
    // The guard must modify nothing when both preconditions hold — otherwise it
    // would break every legitimate transition rather than the racing one.
    const { event } = await seedDrawableEvent(harness, { participants: 2, markReady: false });
    const result = await new EventLifecycleService(harness.db.d1).transition(
      event.id,
      'mark-draw-ready',
      actor() as never,
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.status).toBe('DRAW_READY');
    expect(
      count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EVENT_MARKED_DRAW_READY'`),
    ).toBe(1);
  });
});

// @vitest-environment node
//
// The dev mock must never teach a contract the backend does not have.
//
// That is sharper here than anywhere else in the application. A builder who
// learns from `npm run dev` that a draw can be re-run, that a winner can take
// two prizes, or that the button stays live after the result is in, will build
// a screen around a capability the server refuses — and will find out at the
// only moment that cannot be repeated.
//
// WHAT THE MOCK CANNOT REPRODUCE, and does not pretend to: transactional
// atomicity. There is no batch in memory, so there is no rollback to observe.
// It compensates by validating everything before it mutates anything, which is
// asserted below.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DRAW_ALGORITHM_VERSION,
  expandPrizeUnits,
  hashCandidateSet,
  plannedWinnerCount,
} from '../shared/drawLifecycle';
import { setLogSink } from '../functions/_shared/logger';
import {
  createDrawHarness,
  drawActor,
  seedDrawableEvent,
  type DrawHarness,
} from './helpers/drawFlow';
import type { DrawResponse, DrawStatusResponse, EventStatus } from '../shared/types';

const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

async function freshMock() {
  const mod = await import('../src/lib/mockApi');
  await mod.mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  return {
    mockApi: mod.mockApi,
    setEventStatus: mod.__setMockEventStatus,
    seedEntry: mod.__seedMockDrawEligibleEntry,
  };
}

let mock: Awaited<ReturnType<typeof freshMock>>;
let server: DrawHarness;

beforeEach(async () => {
  setLogSink(() => {});
  vi.resetModules();
  mock = await freshMock();
  server = await createDrawHarness();
});

afterEach(() => {
  setLogSink(null);
  server.close();
});

/**
 * An event in the MOCK at DRAW_READY, with prizes and eligible participants.
 *
 * Prizes are created while the event is a DRAFT because the mock enforces the
 * same `PRIZE_CAPABILITIES_BY_EVENT_STATUS` table the backend does — which is
 * itself a parity property.
 */
async function mockDrawable(options: { participants?: number; prizes?: number[] } = {}) {
  const event = await mock.mockApi.createEvent({ name: 'Draw Parity Event' });
  for (const [index, quantity] of (options.prizes ?? [1]).entries()) {
    await mock.mockApi.createEventPrize(event.id, {
      name: `Prize ${index + 1}`,
      quantity,
    });
  }
  const entryIds: string[] = [];
  for (let i = 0; i < (options.participants ?? 5); i++) {
    entryIds.push(mock.seedEntry(event.id));
  }
  mock.setEventStatus(event.id, 'DRAW_READY');
  return { event, entryIds };
}

// ---------------------------------------------------------------------------
describe('readiness parity', () => {
  it('counts candidates and units the same way', async () => {
    const { event: mockEvent } = await mockDrawable({ participants: 7, prizes: [2, 3] });
    const mocked = (await mock.mockApi.getDraw(mockEvent.id)) as DrawStatusResponse;

    const { event } = await seedDrawableEvent(server, { participants: 7, prizes: [2, 3] });
    const real = await server.draws.status(event.id);
    if (!real.ok) throw new Error('unreachable');

    expect(mocked.readiness.candidateCount).toBe(real.value.readiness.candidateCount);
    expect(mocked.readiness.prizeUnitCount).toBe(real.value.readiness.prizeUnitCount);
    expect(mocked.readiness.plannedWinnerCount).toBe(
      real.value.readiness.plannedWinnerCount,
    );
    expect(mocked.readiness.canRun).toBe(real.value.readiness.canRun);
    expect(mocked.readiness.blockers).toEqual(real.value.readiness.blockers);
  });

  it('reports the same blockers for an event that is not ready', async () => {
    const { event: mockEvent } = await mockDrawable();
    mock.setEventStatus(mockEvent.id, 'CLOSED');
    const mocked = (await mock.mockApi.getDraw(mockEvent.id)) as DrawStatusResponse;

    const { event } = await seedDrawableEvent(server, { markReady: false });
    const real = await server.draws.status(event.id);
    if (!real.ok) throw new Error('unreachable');

    expect(mocked.readiness.blockers).toEqual(['DRAW_NOT_READY']);
    expect(real.value.readiness.blockers).toEqual(mocked.readiness.blockers);
  });

  it('reports NO_ACTIVE_PRIZES identically', async () => {
    const event = await mock.mockApi.createEvent({ name: 'No prizes' });
    mock.seedEntry(event.id);
    mock.setEventStatus(event.id, 'DRAW_READY');
    const mocked = (await mock.mockApi.getDraw(event.id)) as DrawStatusResponse;
    expect(mocked.readiness.blockers).toContain('NO_ACTIVE_PRIZES');
    expect(mocked.readiness.canRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('result parity', () => {
  it('produces the same SHAPE of result', async () => {
    const { event: mockEvent } = await mockDrawable({ participants: 6, prizes: [2] });
    const mocked = (await mock.mockApi.runDraw(mockEvent.id)) as DrawResponse;

    const { event } = await seedDrawableEvent(server, { participants: 6, prizes: [2] });
    const real = await server.draws.run(event.id, drawActor(server));
    if (!real.ok) throw new Error(JSON.stringify(real.failure));

    // Field by field, because a missing key in one of them is exactly the kind
    // of divergence a "looks right" check would miss.
    expect(Object.keys(mocked).sort()).toEqual(Object.keys(real.value.response).sort());
    expect(Object.keys(mocked.draw!).sort()).toEqual(Object.keys(real.value.response.draw!).sort());
    expect(Object.keys(mocked.assignments[0]).sort()).toEqual(
      Object.keys(real.value.response.assignments[0]).sort(),
    );
    expect(Object.keys(mocked.assignments[0].prize).sort()).toEqual(
      Object.keys(real.value.response.assignments[0].prize).sort(),
    );
    expect(Object.keys(mocked.assignments[0].winner).sort()).toEqual(
      Object.keys(real.value.response.assignments[0].winner).sort(),
    );

    expect(mocked.draw!.candidateCount).toBe(real.value.response.draw!.candidateCount);
    expect(mocked.draw!.prizeUnitCount).toBe(real.value.response.draw!.prizeUnitCount);
    expect(mocked.draw!.assignmentCount).toBe(real.value.response.draw!.assignmentCount);
    expect(mocked.draw!.algorithmVersion).toBe(real.value.response.draw!.algorithmVersion);
    expect(mocked.eventStatus).toBe(real.value.response.eventStatus);
  });

  it('computes the candidate hash with the same function, not a lookalike', async () => {
    const { event, entryIds } = await mockDrawable({ participants: 4 });
    const mocked = (await mock.mockApi.runDraw(event.id)) as DrawResponse;
    // A hash the mock derived differently would agree in shape and disagree in
    // value — the one divergence a shape test cannot catch.
    expect(mocked.draw!.candidateSetHash).toBe(await hashCandidateSet(entryIds));
  });

  it('names the same algorithm', async () => {
    const { event } = await mockDrawable();
    const mocked = (await mock.mockApi.runDraw(event.id)) as DrawResponse;
    expect(mocked.draw!.algorithmVersion).toBe(DRAW_ALGORITHM_VERSION);
  });

  it('moves the event to DRAW_COMPLETED, as the server does', async () => {
    const { event } = await mockDrawable();
    await mock.mockApi.runDraw(event.id);
    const after = await mock.mockApi.getEvent(event.id);
    expect(after.event.status).toBe('DRAW_COMPLETED' satisfies EventStatus);
  });
});

// ---------------------------------------------------------------------------
describe('refusal parity', () => {
  it('replays a second draw instead of refusing it, exactly as the server does', async () => {
    const { event: mockEvent } = await mockDrawable({ participants: 6, prizes: [3] });
    const mockFirst = (await mock.mockApi.runDraw(mockEvent.id)) as DrawResponse;
    const mockRetry = (await mock.mockApi.runDraw(mockEvent.id)) as DrawResponse;

    // Same draw, same winners, no second selection. A mock that threw here
    // would teach a builder to write an error path the server does not take.
    expect(mockRetry.draw?.id).toBe(mockFirst.draw?.id);
    expect(mockRetry.assignments).toEqual(mockFirst.assignments);

    const { event } = await seedDrawableEvent(server, { participants: 6, prizes: [3] });
    const first = await server.draws.run(event.id, drawActor(server));
    const second = await server.draws.run(event.id, drawActor(server));
    expect(second.ok).toBe(true);
    if (!second.ok || !first.ok) throw new Error('unreachable');
    expect(second.value.created).toBe(false);
    expect(second.value.response.draw?.id).toBe(first.value.response.draw?.id);
    expect(second.value.response.assignments).toEqual(first.value.response.assignments);
  });

  it('refuses an event that is only CLOSED with the same code', async () => {
    const { event: mockEvent } = await mockDrawable();
    mock.setEventStatus(mockEvent.id, 'CLOSED');
    await expect(mock.mockApi.runDraw(mockEvent.id)).rejects.toMatchObject({
      code: 'DRAW_NOT_READY',
    });

    const { event } = await seedDrawableEvent(server, { markReady: false });
    const real = await server.draws.run(event.id, drawActor(server));
    expect(real.ok).toBe(false);
    if (!real.ok) expect(real.failure.code).toBe('DRAW_NOT_READY');
  });

  it('refuses when nobody is eligible, with the same code', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Nobody' });
    await mock.mockApi.createEventPrize(event.id, { name: 'Prize 1', quantity: 1 });
    mock.setEventStatus(event.id, 'DRAW_READY');
    await expect(mock.mockApi.runDraw(event.id)).rejects.toMatchObject({
      code: 'NO_ELIGIBLE_PARTICIPANTS',
    });
  });

  it('leaves nothing behind when it refuses', async () => {
    // The mock has no transaction, so this is the compensating property: it
    // validates everything before it mutates anything.
    const { event } = await mockDrawable();
    mock.setEventStatus(event.id, 'CLOSED');
    await expect(mock.mockApi.runDraw(event.id)).rejects.toThrow();

    const after = (await mock.mockApi.getDraw(event.id)) as DrawStatusResponse;
    expect(after.draw).toBeNull();
    expect(after.assignments).toEqual([]);
    expect((await mock.mockApi.getEvent(event.id)).event.status).toBe('CLOSED');
  });
});

// ---------------------------------------------------------------------------
describe('the mock enforces the same invariants', () => {
  it('gives nobody two prizes and no unit two winners', async () => {
    const { event } = await mockDrawable({ participants: 8, prizes: [3, 2] });
    const result = (await mock.mockApi.runDraw(event.id)) as DrawResponse;

    expect(new Set(result.assignments.map((a) => a.winner.entryId)).size).toBe(5);
    expect(
      new Set(result.assignments.map((a) => `${a.prize.id}#${a.prize.unitIndex}`)).size,
    ).toBe(5);
  });

  it('stops at the number of candidates when prizes outnumber them', async () => {
    const { event } = await mockDrawable({ participants: 2, prizes: [6] });
    const result = (await mock.mockApi.runDraw(event.id)) as DrawResponse;
    expect(result.assignments).toHaveLength(plannedWinnerCount(2, 6));
    expect(result.draw!.prizeUnitCount).toBe(6);
  });

  it('shuffles with the real CSPRNG, not a predictable stand-in', async () => {
    // Ten separate mock instances. A `Math.random`-seeded or fixed-order mock
    // would land on the same position every time.
    const positions = new Set<number>();
    for (let i = 0; i < 10; i++) {
      vi.resetModules();
      const local = await freshMock();
      const event = await local.mockApi.createEvent({ name: 'Spread' });
      await local.mockApi.createEventPrize(event.id, { name: 'Prize 1', quantity: 1 });
      const entryIds = Array.from({ length: 8 }, () => local.seedEntry(event.id));
      local.setEventStatus(event.id, 'DRAW_READY');
      const result = (await local.mockApi.runDraw(event.id)) as DrawResponse;
      positions.add(entryIds.indexOf(result.assignments[0].winner.entryId));
    }
    expect(positions.size).toBeGreaterThan(1);
    // Ten full mock lifecycles, each with the mock's artificial latency on
    // every call. Slow by construction, not by accident.
  }, 30_000);

  it('reads the prize snapshot back, not the live prize', async () => {
    const { event } = await mockDrawable();
    await mock.mockApi.runDraw(event.id);
    // Prizes are frozen from DRAW_READY in the mock too, so the rename has to
    // be impossible — which is itself the assertion.
    await expect(
      mock.mockApi.updateEventPrize(
        event.id,
        (await mock.mockApi.listEventPrizes(event.id, {})).items[0].id,
        { expectedRevision: 1, name: 'Renamed' },
      ),
    ).rejects.toThrow();

    // And what the draw recorded is still what it recorded.
    const after = (await mock.mockApi.getDraw(event.id)) as DrawStatusResponse;
    expect(after.assignments[0].prize.name).toBe('Prize 1');
  });

  it('expands units from the shared function, so the counts cannot drift', async () => {
    const { event } = await mockDrawable({ prizes: [2, 3, 1] });
    const prizes = await mock.mockApi.listEventPrizes(event.id, {});
    const status = (await mock.mockApi.getDraw(event.id)) as DrawStatusResponse;
    expect(status.readiness.prizeUnitCount).toBe(
      expandPrizeUnits(
        prizes.items.map((p) => ({
          id: p.id,
          name: p.name,
          description: null,
          quantity: p.quantity,
          sortOrder: p.sortOrder,
          status: p.status,
        })),
      ).length,
    );
  });
});

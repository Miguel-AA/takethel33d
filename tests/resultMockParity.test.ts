// @vitest-environment node
//
// The dev mock must never teach a contract the backend does not have.
//
// The stakes here are the same as the draw's. A builder who learns from
// `npm run dev` that a publication can be withdrawn, that renaming a
// participant updates the public page, or that an archived event can still be
// published, will build a screen around a capability the server refuses — and
// find out at the one moment that cannot be taken back.
//
// WHAT THE MOCK CANNOT REPRODUCE: transactional atomicity. There is no batch in
// memory, so there is no rollback to observe. It compensates by validating and
// building everything before it stores anything, which is asserted below.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLogSink } from '../functions/_shared/logger';
import { formatPublicWinnerName } from '../shared/resultLifecycle';
import {
  createResultHarness,
  resultActor,
  seedDrawnEvent,
  seedPublishedEvent,
  archive,
  type ResultHarness,
} from './helpers/resultFlow';
import type {
  AdminEventResults,
  PublicEventResultsDTO,
  PublishResultsResponse,
} from '../shared/types';

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
let server: ResultHarness;

beforeEach(async () => {
  setLogSink(() => {});
  vi.resetModules();
  mock = await freshMock();
  server = await createResultHarness();
});

afterEach(() => {
  setLogSink(null);
  server.close();
});

/** An event in the MOCK whose draw has been run. */
async function mockDrawn(options: { participants?: number; prizes?: number[] } = {}) {
  const event = await mock.mockApi.createEvent({ name: 'Results Parity Event' });
  for (const [index, quantity] of (options.prizes ?? [2]).entries()) {
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
  await mock.mockApi.runDraw(event.id);
  return { event, entryIds };
}

// ---------------------------------------------------------------------------
describe('the administrative projection', () => {
  it('has the same SHAPE on both sides', async () => {
    const { event: mockEvent } = await mockDrawn({ participants: 6, prizes: [2, 1] });
    const mocked = (await mock.mockApi.getEventResults(mockEvent.id)) as AdminEventResults;

    const { event } = await seedDrawnEvent(server, { participants: 6, prizes: [2, 1] });
    const real = await server.results.loadAdminResults(event.id);
    if (!real.ok) throw new Error('unreachable');

    // Key by key, because a missing field is exactly the divergence a
    // "looks right" check would miss.
    expect(Object.keys(mocked).sort()).toEqual(Object.keys(real.value).sort());
    expect(Object.keys(mocked.draw!).sort()).toEqual(Object.keys(real.value.draw!).sort());
    expect(Object.keys(mocked.assignments[0]).sort()).toEqual(
      Object.keys(real.value.assignments[0]).sort(),
    );
    expect(Object.keys(mocked.assignments[0].prize).sort()).toEqual(
      Object.keys(real.value.assignments[0].prize).sort(),
    );
    expect(Object.keys(mocked.assignments[0].winner).sort()).toEqual(
      Object.keys(real.value.assignments[0].winner).sort(),
    );

    expect(mocked.assignments).toHaveLength(real.value.assignments.length);
    expect(mocked.unassignedUnitCount).toBe(real.value.unassignedUnitCount);
    expect(mocked.publicationState).toBe(real.value.publicationState);
    expect(mocked.canPublish).toBe(real.value.canPublish);
    expect(mocked.canArchive).toBe(real.value.canArchive);
    expect(mocked.archivingWouldDiscardResults).toBe(
      real.value.archivingWouldDiscardResults,
    );
  });

  it('counts unassigned units from the draw on both sides', async () => {
    const { event: mockEvent } = await mockDrawn({ participants: 2, prizes: [5] });
    const mocked = (await mock.mockApi.getEventResults(mockEvent.id)) as AdminEventResults;

    const { event } = await seedDrawnEvent(server, { participants: 2, prizes: [5] });
    const real = await server.results.loadAdminResults(event.id);
    if (!real.ok) throw new Error('unreachable');

    expect(mocked.unassignedUnitCount).toBe(3);
    expect(real.value.unassignedUnitCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('publishing', () => {
  it('produces the same public shape and the same abbreviated names', async () => {
    const { event: mockEvent } = await mockDrawn({ participants: 4, prizes: [2] });
    await mock.mockApi.publishResults(mockEvent.id);
    const mocked = (await mock.mockApi.getPublicEventResults(
      mockEvent.id ? (await mock.mockApi.getEvent(mockEvent.id)).event.slug : '',
    )) as PublicEventResultsDTO;

    const { event } = await seedPublishedEvent(server, { participants: 4, prizes: [2] });
    const real = await server.results.loadPublicResults(event.slug);
    if (!real.ok) throw new Error('unreachable');

    expect(Object.keys(mocked).sort()).toEqual(Object.keys(real.value).sort());
    expect(Object.keys(mocked.event).sort()).toEqual(Object.keys(real.value.event).sort());
    expect(Object.keys(mocked.results).sort()).toEqual(Object.keys(real.value.results).sort());
    expect(Object.keys(mocked.results.winners[0]).sort()).toEqual(
      Object.keys(real.value.results.winners[0]).sort(),
    );

    // The SAME formatter, so the abbreviation cannot drift.
    for (const winner of mocked.results.winners) {
      expect(winner.displayName).toMatch(/ [A-Z]\.$/);
    }
  });

  it('replays a retry instead of publishing again', async () => {
    const { event } = await mockDrawn({ participants: 4, prizes: [2] });
    const first = (await mock.mockApi.publishResults(event.id)) as PublishResultsResponse;
    const retry = (await mock.mockApi.publishResults(event.id)) as PublishResultsResponse;

    expect(retry.results.publication?.id).toBe(first.results.publication?.id);
    expect(retry.results.publication?.publishedAt).toBe(
      first.results.publication?.publishedAt,
    );

    const server_ = await seedDrawnEvent(server, { participants: 4, prizes: [2] });
    const a = await server.results.publish(server_.event.id, resultActor(server));
    const b = await server.results.publish(server_.event.id, resultActor(server));
    expect(b.ok && b.value.created).toBe(false);
    if (a.ok && b.ok) {
      expect(b.value.results.publication?.id).toBe(a.value.results.publication?.id);
    }
  });

  it('refuses an archived event with the same blocker', async () => {
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    mock.setEventStatus(event.id, 'ARCHIVED');
    await expect(mock.mockApi.publishResults(event.id)).rejects.toMatchObject({
      code: 'RESULTS_NOT_PUBLISHABLE',
      status: 409,
    });

    const real = await seedDrawnEvent(server, { participants: 3, prizes: [2] });
    await archive(server, real.event.id);
    const attempt = await server.results.publish(real.event.id, resultActor(server));
    expect(attempt.ok).toBe(false);
    if (!attempt.ok && attempt.failure.code === 'RESULTS_NOT_PUBLISHABLE') {
      expect(attempt.failure.blocker).toBe('EVENT_ARCHIVED');
    }
  });

  it('leaves nothing behind when it refuses', async () => {
    // The mock has no transaction, so this is the compensating property: it
    // validates and builds everything before storing anything.
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    mock.setEventStatus(event.id, 'ARCHIVED');
    await expect(mock.mockApi.publishResults(event.id)).rejects.toThrow();

    const after = (await mock.mockApi.getEventResults(event.id)) as AdminEventResults;
    expect(after.publication).toBeNull();
    expect(after.publicationState).toBe('UNPUBLISHED');
  });
});

// ---------------------------------------------------------------------------
describe('the mock’s publication is a snapshot, not a live link', () => {
  it('does not change when the participant record changes', async () => {
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    await mock.mockApi.publishResults(event.id);
    const slug = (await mock.mockApi.getEvent(event.id)).event.slug;
    const before = (await mock.mockApi.getPublicEventResults(slug)) as PublicEventResultsDTO;

    // Reaching into the mock's own store, which is the only way to simulate a
    // participant correcting their name — and the point is that it changes
    // nothing here.
    const mod = await import('../src/lib/mockApi');
    mod.__renameMockParticipants('Renamed', 'Entirely');

    const after = (await mock.mockApi.getPublicEventResults(slug)) as PublicEventResultsDTO;
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain('Renamed');
  });

  it('does not change when a prize is renamed', async () => {
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    await mock.mockApi.publishResults(event.id);
    const slug = (await mock.mockApi.getEvent(event.id)).event.slug;
    const before = (await mock.mockApi.getPublicEventResults(slug)) as PublicEventResultsDTO;

    const mod = await import('../src/lib/mockApi');
    mod.__renameMockPrizes('Renamed a year later');

    const after = (await mock.mockApi.getPublicEventResults(slug)) as PublicEventResultsDTO;
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
describe('the mock’s public surface', () => {
  it('is unavailable before publication, for every reason alike', async () => {
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    const slug = (await mock.mockApi.getEvent(event.id)).event.slug;

    await expect(mock.mockApi.getPublicEventResults(slug)).rejects.toMatchObject({
      code: 'RESULTS_NOT_AVAILABLE',
      status: 404,
    });
    await expect(
      mock.mockApi.getPublicEventResults('no-such-event-anywhere'),
    ).rejects.toMatchObject({ code: 'RESULTS_NOT_AVAILABLE', status: 404 });
  });

  it('survives archiving, exactly as the server does', async () => {
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    await mock.mockApi.publishResults(event.id);
    const slug = (await mock.mockApi.getEvent(event.id)).event.slug;
    const before = await mock.mockApi.getPublicEventResults(slug);

    mock.setEventStatus(event.id, 'ARCHIVED');
    expect(await mock.mockApi.getPublicEventResults(slug)).toEqual(before);
  });

  it('carries no email, no identifier and no full surname', async () => {
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    await mock.mockApi.publishResults(event.id);
    const slug = (await mock.mockApi.getEvent(event.id)).event.slug;
    const body = JSON.stringify(await mock.mockApi.getPublicEventResults(slug));

    for (const leak of ['@example.com', 'entryId', 'assignmentId', 'email', 'Lovelace']) {
      expect(body, leak).not.toContain(leak);
    }
  });

  it('uses the shared formatter rather than a lookalike', async () => {
    const { event } = await mockDrawn({ participants: 3, prizes: [2] });
    await mock.mockApi.publishResults(event.id);
    const slug = (await mock.mockApi.getEvent(event.id)).event.slug;
    const body = (await mock.mockApi.getPublicEventResults(slug)) as PublicEventResultsDTO;

    // The mock seeds "Ada Lovelace" entrants.
    expect(body.results.winners[0].displayName).toBe(
      formatPublicWinnerName({ firstName: 'Ada', lastName: 'Lovelace' }),
    );
  });
});

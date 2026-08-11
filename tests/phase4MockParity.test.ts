// Observable parity between the dev mock and the real backend, for prizes.
//
// The mock does not reproduce D1 and is not meant to. What it MUST reproduce is
// every rule the SPA can observe: the same statuses, the same per-event-state
// permissions, the same revision conflicts, the same limits, the same refusals.
// A mock more permissive than the server teaches a contract that does not exist.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_STATUSES, type EventStatus } from '../shared/eventLifecycle';
import {
  PRIZE_STATUSES,
  PRIZE_TRANSITION_ACTIONS,
  allowedPrizeActions,
  editableFieldsFor,
  eventAllows,
} from '../shared/prizeLifecycle';
import { PRIZES_PER_EVENT_MAX } from '../shared/limits';

const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

async function freshMock(signIn = true) {
  const mod = await import('../src/lib/mockApi');
  if (signIn) await mod.mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  return {
    mockApi: mod.mockApi,
    setEventStatus: mod.__setMockEventStatus,
    setPrizeStatus: mod.__setMockPrizeStatus,
    seedDrawEligibleEntry: mod.__seedMockDrawEligibleEntry,
  };
}

let mock: Awaited<ReturnType<typeof freshMock>>;

async function newEvent(name = 'Prize Parity Event') {
  return mock.mockApi.createEvent({
    name,
    registrationOpensAt: at(1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  });
}

async function eventWithPrize(name = 'Prize Parity Event') {
  const event = await newEvent(name);
  const prize = await mock.mockApi.createEventPrize(event.id, { name: 'A prize', quantity: 2 });
  return { event, prize };
}

beforeEach(async () => {
  vi.resetModules();
  mock = await freshMock();
});

// ---------------------------------------------------------------------------
describe('session and scoping', () => {
  it('every prize call requires a session', async () => {
    const { event, prize } = await eventWithPrize();
    vi.resetModules();
    const anonymous = await freshMock(false);

    await expect(anonymous.mockApi.listEventPrizes(event.id, {})).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      anonymous.mockApi.createEventPrize(event.id, { name: 'X', quantity: 1 }),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      anonymous.mockApi.getEventPrize(event.id, prize.id),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('refuses a prize reached through the wrong event, exactly as the server does', async () => {
    const { prize } = await eventWithPrize('Owner');
    const other = await newEvent('Impostor');

    for (const call of [
      () => mock.mockApi.getEventPrize(other.id, prize.id),
      () => mock.mockApi.updateEventPrize(other.id, prize.id, { expectedRevision: 1, name: 'X' }),
      () => mock.mockApi.deleteEventPrize(other.id, prize.id),
      () => mock.mockApi.transitionEventPrize(other.id, prize.id, 'deactivate'),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'PRIZE_NOT_FOUND' });
    }

    // Untouched: no revision moved, nothing was deleted.
    const still = await mock.mockApi.getEventPrize(prize.eventId, prize.id);
    expect(still.prize.revision).toBe(1);
    expect(still.prize.status).toBe('ACTIVE');
  });

  it('keeps the prizes of another event out of the listing and the summary', async () => {
    const first = await eventWithPrize('First');
    const second = await newEvent('Second');

    const listing = await mock.mockApi.listEventPrizes(second.id, {});
    expect(listing.items).toHaveLength(0);
    expect(listing.summary.totalPrizes).toBe(0);
    expect(listing.summary.totalActiveUnits).toBe(0);

    const own = await mock.mockApi.listEventPrizes(first.event.id, {});
    expect(own.items.map((item) => item.id)).toEqual([first.prize.id]);
  });
});

// ---------------------------------------------------------------------------
describe('create parity', () => {
  it('starts ACTIVE at revision 1, appended to the end', async () => {
    const event = await newEvent();
    const first = await mock.mockApi.createEventPrize(event.id, { name: 'A', quantity: 1 });
    const second = await mock.mockApi.createEventPrize(event.id, { name: 'B', quantity: 1 });

    expect(first.status).toBe('ACTIVE');
    expect(first.revision).toBe(1);
    expect(first.sortOrder).toBe(0);
    expect(first.archivedAt).toBeNull();
    expect(second.sortOrder).toBe(1);
  });

  it('refuses a non-http(s) image url', async () => {
    const event = await newEvent();
    for (const imageUrl of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', '/relative.png']) {
      await expect(
        mock.mockApi.createEventPrize(event.id, { name: 'A', quantity: 1, imageUrl }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    }
  });

  it('enforces the same per-event ceiling', async () => {
    const event = await newEvent();
    for (let i = 0; i < PRIZES_PER_EVENT_MAX; i++) {
      await mock.mockApi.createEventPrize(event.id, { name: `P${i}`, quantity: 1 });
    }
    await expect(
      mock.mockApi.createEventPrize(event.id, { name: 'one too many', quantity: 1 }),
    ).rejects.toMatchObject({ code: 'PRIZE_LIMIT_REACHED' });
  }, 60_000);

  it('counts archived prizes toward the ceiling, as the server does', async () => {
    const event = await newEvent();
    const doomed = await mock.mockApi.createEventPrize(event.id, { name: 'P', quantity: 1 });
    mock.setPrizeStatus(doomed.id, 'ARCHIVED');
    for (let i = 1; i < PRIZES_PER_EVENT_MAX; i++) {
      await mock.mockApi.createEventPrize(event.id, { name: `P${i}`, quantity: 1 });
    }
    await expect(
      mock.mockApi.createEventPrize(event.id, { name: 'over', quantity: 1 }),
    ).rejects.toMatchObject({ code: 'PRIZE_LIMIT_REACHED' });
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('permission parity across every event status', () => {
  it('offers create exactly where the shared table says it may', async () => {
    for (const status of EVENT_STATUSES) {
      vi.resetModules();
      mock = await freshMock();
      const event = await newEvent();
      mock.setEventStatus(event.id, status as EventStatus);

      const attempt = mock.mockApi.createEventPrize(event.id, { name: 'X', quantity: 1 });
      if (eventAllows(status, 'create')) await expect(attempt).resolves.toBeTruthy();
      else await expect(attempt).rejects.toMatchObject({ code: 'PRIZE_EVENT_NOT_EDITABLE' });
    }
  }, 30_000);

  it('offers each status action exactly where the shared table says it may', async () => {
    for (const status of EVENT_STATUSES) {
      for (const action of PRIZE_TRANSITION_ACTIONS) {
        vi.resetModules();
        mock = await freshMock();
        const { event, prize } = await eventWithPrize();
        // `deactivate` and `archive` start from ACTIVE; `activate` needs INACTIVE.
        if (action === 'activate') mock.setPrizeStatus(prize.id, 'INACTIVE');
        mock.setEventStatus(event.id, status as EventStatus);

        const attempt = mock.mockApi.transitionEventPrize(event.id, prize.id, action);
        if (eventAllows(status, action)) await expect(attempt).resolves.toBeTruthy();
        else await expect(attempt).rejects.toMatchObject({ code: 'PRIZE_EVENT_NOT_EDITABLE' });
      }
    }
  }, 60_000);

  it('freezes quantity but not copy while the event is OPEN', async () => {
    const { event, prize } = await eventWithPrize();
    mock.setEventStatus(event.id, 'OPEN');

    const renamed = await mock.mockApi.updateEventPrize(event.id, prize.id, {
      expectedRevision: prize.revision,
      name: 'Renamed while open',
    });
    expect(renamed.name).toBe('Renamed while open');

    await expect(
      mock.mockApi.updateEventPrize(event.id, prize.id, {
        expectedRevision: renamed.revision,
        quantity: 9,
      }),
    ).rejects.toMatchObject({ code: 'PRIZE_CANNOT_BE_EDITED' });
  });

  it('refuses every edit once the event is CLOSED or beyond', async () => {
    for (const status of ['CLOSED', 'DRAW_READY', 'DRAW_COMPLETED', 'ARCHIVED'] as const) {
      vi.resetModules();
      mock = await freshMock();
      const { event, prize } = await eventWithPrize();
      mock.setEventStatus(event.id, status);

      await expect(
        mock.mockApi.updateEventPrize(event.id, prize.id, {
          expectedRevision: prize.revision,
          name: 'Nope',
        }),
      ).rejects.toMatchObject({ code: 'PRIZE_CANNOT_BE_EDITED' });
      await expect(
        mock.mockApi.deleteEventPrize(event.id, prize.id),
      ).rejects.toMatchObject({ code: 'PRIZE_EVENT_NOT_EDITABLE' });
    }
  }, 30_000);

  it('lets a cancelled event only file prizes away', async () => {
    const { event, prize } = await eventWithPrize();
    mock.setEventStatus(event.id, 'CANCELLED');

    await expect(
      mock.mockApi.transitionEventPrize(event.id, prize.id, 'deactivate'),
    ).rejects.toMatchObject({ code: 'PRIZE_EVENT_NOT_EDITABLE' });
    await expect(
      mock.mockApi.reorderEventPrizes(event.id, [
        { prizeId: prize.id, expectedRevision: prize.revision, sortOrder: 0 },
      ]),
    ).rejects.toMatchObject({ code: 'PRIZE_EVENT_NOT_EDITABLE' });

    const archived = await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');
    expect(archived.prize.status).toBe('ARCHIVED');
  });

  it('reports the same allowed actions and editable fields as the shared table', async () => {
    for (const status of EVENT_STATUSES) {
      vi.resetModules();
      mock = await freshMock();
      const { event, prize } = await eventWithPrize();
      mock.setEventStatus(event.id, status as EventStatus);

      const detail = await mock.mockApi.getEventPrize(event.id, prize.id);
      expect(detail.allowedActions).toEqual(allowedPrizeActions(status, 'ACTIVE'));
      expect(detail.editableFields).toEqual([...editableFieldsFor(status, 'ACTIVE')]);
      expect(detail.eventStatus).toBe(status);
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe('status parity', () => {
  it('knows exactly the three statuses', async () => {
    expect([...PRIZE_STATUSES]).toEqual(['ACTIVE', 'INACTIVE', 'ARCHIVED']);
  });

  it('refuses a repeated action rather than bumping the revision', async () => {
    const { event, prize } = await eventWithPrize();
    await expect(
      mock.mockApi.transitionEventPrize(event.id, prize.id, 'activate'),
    ).rejects.toMatchObject({ code: 'PRIZE_INVALID_STATUS' });

    const detail = await mock.mockApi.getEventPrize(event.id, prize.id);
    expect(detail.prize.revision).toBe(1);
    expect(detail.prize.status).toBe('ACTIVE');
  });

  it('never brings an archived prize back', async () => {
    const { event, prize } = await eventWithPrize();
    await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');

    for (const action of PRIZE_TRANSITION_ACTIONS) {
      await expect(
        mock.mockApi.transitionEventPrize(event.id, prize.id, action),
      ).rejects.toMatchObject({ code: 'PRIZE_ALREADY_ARCHIVED' });
    }
    await expect(
      mock.mockApi.updateEventPrize(event.id, prize.id, {
        expectedRevision: 2,
        name: 'edited history',
      }),
    ).rejects.toMatchObject({ code: 'PRIZE_ALREADY_ARCHIVED' });
  });

  it('stamps archivedAt with the status and clears it otherwise', async () => {
    const { event, prize } = await eventWithPrize();
    const deactivated = await mock.mockApi.transitionEventPrize(event.id, prize.id, 'deactivate');
    expect(deactivated.prize.archivedAt).toBeNull();

    const archived = await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');
    expect(archived.prize.status).toBe('ARCHIVED');
    expect(archived.prize.archivedAt).not.toBeNull();
  });

  it('refuses to delete an archived prize — archiving is how it is kept', async () => {
    const { event, prize } = await eventWithPrize();
    await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');
    await expect(mock.mockApi.deleteEventPrize(event.id, prize.id)).rejects.toMatchObject({
      code: 'PRIZE_CANNOT_BE_DELETED',
    });
  });
});

// ---------------------------------------------------------------------------
describe('revision parity', () => {
  it('refuses a stale update, a stale transition and a stale delete', async () => {
    const { event, prize } = await eventWithPrize();
    await mock.mockApi.updateEventPrize(event.id, prize.id, {
      expectedRevision: prize.revision,
      name: 'Moved on',
    });

    await expect(
      mock.mockApi.updateEventPrize(event.id, prize.id, {
        expectedRevision: prize.revision,
        name: 'Stale',
      }),
    ).rejects.toMatchObject({ code: 'PRIZE_REVISION_CONFLICT' });
    await expect(
      mock.mockApi.transitionEventPrize(event.id, prize.id, 'deactivate', prize.revision),
    ).rejects.toMatchObject({ code: 'PRIZE_REVISION_CONFLICT' });
    await expect(
      mock.mockApi.deleteEventPrize(event.id, prize.id, prize.revision),
    ).rejects.toMatchObject({ code: 'PRIZE_REVISION_CONFLICT' });
  });

  it('bumps the revision exactly once per accepted mutation', async () => {
    const { event, prize } = await eventWithPrize();
    const updated = await mock.mockApi.updateEventPrize(event.id, prize.id, {
      expectedRevision: 1,
      name: 'Once',
    });
    expect(updated.revision).toBe(2);
    const moved = await mock.mockApi.transitionEventPrize(event.id, prize.id, 'deactivate', 2);
    expect(moved.prize.revision).toBe(3);
  });

  it('refuses a patch that changes nothing, as the schema does', async () => {
    const { event, prize } = await eventWithPrize();
    await expect(
      mock.mockApi.updateEventPrize(event.id, prize.id, { expectedRevision: prize.revision }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const detail = await mock.mockApi.getEventPrize(event.id, prize.id);
    expect(detail.prize.revision).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('reorder parity', () => {
  async function threePrizes() {
    const event = await newEvent();
    const a = await mock.mockApi.createEventPrize(event.id, { name: 'A', quantity: 1 });
    const b = await mock.mockApi.createEventPrize(event.id, { name: 'B', quantity: 1 });
    const c = await mock.mockApi.createEventPrize(event.id, { name: 'C', quantity: 1 });
    return { event, a, b, c };
  }

  it('applies a complete permutation and bumps every revision once', async () => {
    const { event, a, b, c } = await threePrizes();
    const result = await mock.mockApi.reorderEventPrizes(event.id, [
      { prizeId: c.id, expectedRevision: 1, sortOrder: 0 },
      { prizeId: a.id, expectedRevision: 1, sortOrder: 1 },
      { prizeId: b.id, expectedRevision: 1, sortOrder: 2 },
    ]);

    expect(result.items.map((item) => item.id)).toEqual([c.id, a.id, b.id]);
    expect(result.items.every((item) => item.revision === 2)).toBe(true);
  });

  it('refuses a partial ordering', async () => {
    const { event, a, b } = await threePrizes();
    await expect(
      mock.mockApi.reorderEventPrizes(event.id, [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'PRIZE_ORDER_INVALID' });
  });

  it('refuses a repeated prize and a repeated position', async () => {
    const { event, a, b, c } = await threePrizes();

    await expect(
      mock.mockApi.reorderEventPrizes(event.id, [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: a.id, expectedRevision: 1, sortOrder: 1 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 2 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await expect(
      mock.mockApi.reorderEventPrizes(event.id, [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: c.id, expectedRevision: 1, sortOrder: 1 },
      ]),
    ).rejects.toMatchObject({ code: 'PRIZE_ORDER_INVALID' });
  });

  it('refuses an archived or foreign prize in the payload', async () => {
    const { event, a, b, c } = await threePrizes();
    mock.setPrizeStatus(c.id, 'ARCHIVED');

    await expect(
      mock.mockApi.reorderEventPrizes(event.id, [
        { prizeId: a.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 1 },
        { prizeId: c.id, expectedRevision: 1, sortOrder: 2 },
      ]),
    ).rejects.toMatchObject({ code: 'PRIZE_ORDER_INVALID' });
  });

  it('writes nothing when a single revision is stale', async () => {
    const { event, a, b, c } = await threePrizes();
    await expect(
      mock.mockApi.reorderEventPrizes(event.id, [
        { prizeId: c.id, expectedRevision: 1, sortOrder: 0 },
        { prizeId: a.id, expectedRevision: 99, sortOrder: 1 },
        { prizeId: b.id, expectedRevision: 1, sortOrder: 2 },
      ]),
    ).rejects.toMatchObject({ code: 'PRIZE_REVISION_CONFLICT' });

    const listing = await mock.mockApi.listEventPrizes(event.id, {});
    expect(listing.items.map((item) => item.id)).toEqual([a.id, b.id, c.id]);
    expect(listing.items.every((item) => item.revision === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('summary and listing parity', () => {
  it('summarises the whole event, not the visible page', async () => {
    const event = await newEvent();
    const kept = await mock.mockApi.createEventPrize(event.id, { name: 'Kept', quantity: 3 });
    const off = await mock.mockApi.createEventPrize(event.id, { name: 'Off', quantity: 5 });
    const gone = await mock.mockApi.createEventPrize(event.id, { name: 'Gone', quantity: 7 });
    await mock.mockApi.transitionEventPrize(event.id, off.id, 'deactivate');
    await mock.mockApi.transitionEventPrize(event.id, gone.id, 'archive');

    const page = await mock.mockApi.listEventPrizes(event.id, { page: 1, pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.summary).toEqual({
      totalPrizes: 3,
      activePrizes: 1,
      inactivePrizes: 1,
      archivedPrizes: 1,
      totalActiveUnits: 3,
    });
    expect(page.summary.totalActiveUnits).toBe(kept.quantity);
  });

  it('excludes archived prizes by default and includes them on request', async () => {
    const { event, prize } = await eventWithPrize();
    await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');

    expect((await mock.mockApi.listEventPrizes(event.id, {})).items).toHaveLength(0);
    expect(
      (await mock.mockApi.listEventPrizes(event.id, { archived: 'archived' })).items,
    ).toHaveLength(1);
    expect((await mock.mockApi.listEventPrizes(event.id, { archived: 'all' })).items).toHaveLength(
      1,
    );
  });

  it('treats a LIKE wildcard as literal text', async () => {
    const event = await newEvent();
    await mock.mockApi.createEventPrize(event.id, { name: 'Plain', quantity: 1 });
    await mock.mockApi.createEventPrize(event.id, { name: '100% cotton', quantity: 1 });

    const found = await mock.mockApi.listEventPrizes(event.id, { search: '%' });
    expect(found.items.map((item) => item.name)).toEqual(['100% cotton']);
  });

  it('reports the event status the UI gates its controls on', async () => {
    const { event } = await eventWithPrize();
    mock.setEventStatus(event.id, 'OPEN');
    expect((await mock.mockApi.listEventPrizes(event.id, {})).eventStatus).toBe('OPEN');
  });
});

// ---------------------------------------------------------------------------
describe('integration parity', () => {
  it('blocks deleting an event that still has prizes, archived ones included', async () => {
    const { event, prize } = await eventWithPrize();
    await expect(mock.mockApi.deleteEvent(event.id)).rejects.toMatchObject({
      code: 'EVENT_CANNOT_BE_DELETED',
    });

    await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');
    await expect(mock.mockApi.deleteEvent(event.id)).rejects.toMatchObject({
      code: 'EVENT_CANNOT_BE_DELETED',
    });

    // A prizeless draft is still safely deletable.
    const empty = await newEvent('Nothing attached');
    await expect(mock.mockApi.deleteEvent(empty.id)).resolves.toMatchObject({ ok: true });
  });

  it('stops reporting canDelete once an event holds a prize', async () => {
    const event = await newEvent('Detail');
    expect((await mock.mockApi.getEvent(event.id)).canDelete).toBe(true);

    const prize = await mock.mockApi.createEventPrize(event.id, { name: 'P', quantity: 1 });
    expect((await mock.mockApi.getEvent(event.id)).canDelete).toBe(false);

    // Archiving the prize does not release the event either.
    await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');
    expect((await mock.mockApi.getEvent(event.id)).canDelete).toBe(false);
  });

  it('hands out detached prizes, so a cached copy cannot mutate underfoot', async () => {
    const { event, prize } = await eventWithPrize();
    await mock.mockApi.updateEventPrize(event.id, prize.id, {
      expectedRevision: prize.revision,
      name: 'Changed',
    });

    // The object the caller already held is a snapshot, exactly as a decoded
    // HTTP response would be — so a stale revision stays detectably stale.
    expect(prize.revision).toBe(1);
    expect(prize.name).toBe('A prize');
    await expect(
      mock.mockApi.updateEventPrize(event.id, prize.id, {
        expectedRevision: prize.revision,
        name: 'Stale write',
      }),
    ).rejects.toMatchObject({ code: 'PRIZE_REVISION_CONFLICT' });
  });

  it('requires an active prize before an event may be marked draw-ready', async () => {
    const { event, prize } = await eventWithPrize();
    // Phase 11 added a SECOND precondition — somebody must be eligible to be
    // drawn — so it is satisfied up front and asserted on its own below. This
    // test is about the PRIZE rule.
    mock.seedDrawEligibleEntry(event.id);
    mock.setEventStatus(event.id, 'CLOSED');

    // With one ACTIVE prize it is offered.
    const ready = await mock.mockApi.getEvent(event.id);
    expect(ready.availableActions).toContain('mark-draw-ready');

    // Deactivate the only prize and the precondition disappears.
    mock.setEventStatus(event.id, 'DRAFT');
    await mock.mockApi.transitionEventPrize(event.id, prize.id, 'deactivate');
    mock.setEventStatus(event.id, 'CLOSED');

    const blocked = await mock.mockApi.getEvent(event.id);
    expect(blocked.availableActions).not.toContain('mark-draw-ready');
    expect(
      blocked.blockedActions.find((entry) => entry.action === 'mark-draw-ready')?.missingFields,
    ).toContain('ACTIVE_PRIZE_REQUIRED');

    await expect(
      mock.mockApi.transitionEvent(event.id, 'mark-draw-ready'),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_READY' });
  });

  it('does not accept an archived prize as something to give away', async () => {
    const { event, prize } = await eventWithPrize();
    await mock.mockApi.transitionEventPrize(event.id, prize.id, 'archive');
    mock.setEventStatus(event.id, 'CLOSED');

    await expect(
      mock.mockApi.transitionEvent(event.id, 'mark-draw-ready'),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_READY' });
  });
});

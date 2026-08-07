// Observable parity between the dev mock and the real backend.
//
// The mock does not reproduce D1, and it is not meant to. What it MUST
// reproduce is every rule the SPA can observe: the same states, the same
// transitions, the same frozen fields, the same conflicts and the same refusals.
// A mock that is more permissive than the server teaches a contract that does
// not exist, and the divergence only surfaces in production.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ACTION_TARGET,
  EVENT_STATUSES,
  EVENT_TRANSITION_ACTIONS,
  canTransition,
  EDITABLE_FIELDS_BY_STATUS,
  type EventStatus,
} from '../shared/eventLifecycle';

const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

const DAY = 86_400_000;
const at = (days: number) => new Date(Date.now() + days * DAY).toISOString();

function futureWindow() {
  return {
    registrationOpensAt: at(1),
    registrationClosesAt: at(5),
    startsAt: at(6),
    endsAt: at(7),
  };
}

/** A module instance with a fresh in-memory store, already signed in. */
async function freshMock(signIn = true) {
  // `vi.resetModules()` in beforeEach is what makes each import a new instance;
  // a query-string suffix would make Vite lose the .ts association.
  const mod = await import('../src/lib/mockApi');
  if (signIn) await mod.mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  return { mockApi: mod.mockApi, setStatus: mod.__setMockEventStatus };
}

let mock: Awaited<ReturnType<typeof freshMock>>;

beforeEach(async () => {
  vi.resetModules();
  mock = await freshMock();
});

/**
 * Publishes a minimal form for an event.
 *
 * Since phase 6, `publish` and `open` require one. Built through the mock's own
 * API so the parity suite exercises the same path the builder does.
 */
async function seedPublishedForm(eventId: string): Promise<void> {
  const created = await mock.mockApi.createFormDraft(eventId);
  let draft = created.draft;
  if (!draft) throw new Error('draft missing');

  draft = (
    await mock.mockApi.createFormStep(eventId, {
      expectedRevision: draft.revision,
      title: 'About you',
    })
  ).draft;

  const stepId = draft.steps[0].id;
  for (const field of ['FIRST_NAME', 'LAST_NAME', 'EMAIL'] as const) {
    draft = (
      await mock.mockApi.createFormQuestion(eventId, {
        expectedRevision: draft.revision,
        stepId,
        type: field === 'EMAIL' ? 'EMAIL' : 'SHORT_TEXT',
        systemField: field,
        label: field,
        required: true,
      })
    ).draft;
  }

  await mock.mockApi.publishForm(eventId, draft.revision);
}

describe('session', () => {
  it('every event call requires a session', async () => {
    vi.resetModules();
    const anonymous = await freshMock(false);
    await expect(anonymous.mockApi.listEvents({})).rejects.toMatchObject({ status: 401 });
    await expect(anonymous.mockApi.createEvent({ name: 'X' })).rejects.toMatchObject({
      status: 401,
    });
  });
});

describe('create parity', () => {
  it('starts a draft at revision 1 with the default timezone', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Parity Event' });
    expect(event.status).toBe('DRAFT');
    expect(event.revision).toBe(1);
    expect(event.timezone).toBe('America/New_York');
    expect(event.publishedAt).toBeNull();
  });

  it('auto-suffixes a colliding generated slug', async () => {
    const first = await mock.mockApi.createEvent({ name: 'Same Name' });
    const second = await mock.mockApi.createEvent({ name: 'Same Name' });
    expect(second.slug).not.toBe(first.slug);
  });

  it('refuses an explicit duplicate slug rather than renaming it', async () => {
    await mock.mockApi.createEvent({ name: 'A', slug: 'taken-slug' });
    await expect(
      mock.mockApi.createEvent({ name: 'B', slug: 'taken-slug' }),
    ).rejects.toMatchObject({ code: 'EVENT_SLUG_EXISTS' });
  });

  it('refuses a reserved slug', async () => {
    await expect(
      mock.mockApi.createEvent({ name: 'A', slug: 'manager' }),
    ).rejects.toMatchObject({ code: 'EVENT_SLUG_RESERVED' });
  });

  it('refuses an inverted date range, exactly as the server does', async () => {
    await expect(
      mock.mockApi.createEvent({
        name: 'Bad dates',
        startsAt: at(10),
        endsAt: at(2),
      }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID_DATE_RANGE' });
  });
});

describe('update parity', () => {
  it('enforces the revision', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Rev' });
    await mock.mockApi.updateEvent(event.id, { expectedRevision: 1, name: 'First' });

    await expect(
      mock.mockApi.updateEvent(event.id, { expectedRevision: 1, name: 'Stale' }),
    ).rejects.toMatchObject({ code: 'EVENT_REVISION_CONFLICT' });
  });

  it('freezes the slug once the event leaves DRAFT', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Frozen', ...futureWindow() });
    await seedPublishedForm(event.id);
    const published = await mock.mockApi.transitionEvent(event.id, 'publish');

    await expect(
      mock.mockApi.updateEvent(event.id, {
        expectedRevision: published.event.revision,
        slug: 'new-slug',
      }),
    ).rejects.toMatchObject({ code: 'EVENT_CANNOT_BE_EDITED' });
  });

  it('refuses an inverted range on update', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Dates', ...futureWindow() });
    await expect(
      mock.mockApi.updateEvent(event.id, { expectedRevision: 1, endsAt: at(-1) }),
    ).rejects.toMatchObject({ code: 'EVENT_INVALID_DATE_RANGE' });
  });

  it('refuses a reserved slug on update', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Slugged' });
    await expect(
      mock.mockApi.updateEvent(event.id, { expectedRevision: 1, slug: 'audit' }),
    ).rejects.toMatchObject({ code: 'EVENT_SLUG_RESERVED' });
  });
});

describe('transition parity', () => {
  it.each(
    EVENT_STATUSES.flatMap((from) =>
      EVENT_TRANSITION_ACTIONS.map((action) => [from, action] as const),
    ),
  )('mock agrees with the shared table for %s -> %s', async (from, action) => {
    const event = await mock.mockApi.createEvent({ name: 'Matrix', ...futureWindow() });
    // Since phase 4, `mark-draw-ready` also requires something to give away,
    // and since phase 6 `publish`/`open` require a published form. This matrix
    // is about the LIFECYCLE table, so both preconditions are satisfied up
    // front and asserted on their own elsewhere.
    if (action === 'mark-draw-ready') {
      await mock.mockApi.createEventPrize(event.id, { name: 'Seeded prize', quantity: 1 });
    }
    if (action === 'publish' || action === 'open') {
      await seedPublishedForm(event.id);
    }
    mock.setStatus(event.id, from as EventStatus);

    const allowed = canTransition(from, action);
    if (!allowed) {
      await expect(
        mock.mockApi.transitionEvent(event.id, action),
      ).rejects.toMatchObject({ code: 'EVENT_INVALID_TRANSITION' });
    } else {
      const result = await mock.mockApi.transitionEvent(event.id, action);
      expect(result.event.status).toBe(ACTION_TARGET[action]);
    }
  });

  it('blocks a transition whose configuration is incomplete', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Incomplete' });
    await expect(
      mock.mockApi.transitionEvent(event.id, 'publish'),
    ).rejects.toMatchObject({ code: 'EVENT_REQUIRED_FIELDS_MISSING' });
  });

  it('blocks opening a window that has already passed', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Stale window', ...futureWindow() });
    // Age the window directly, as the server-side test does.
    mock.setStatus(event.id, 'DRAFT', {
      registrationOpensAt: at(-5),
      registrationClosesAt: at(-3),
      startsAt: at(-2),
      endsAt: at(-1),
    });

    await expect(
      mock.mockApi.transitionEvent(event.id, 'open'),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_READY' });
  });

  it('enforces the revision on a transition', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Rev', ...futureWindow() });
    await expect(
      mock.mockApi.transitionEvent(event.id, 'publish', 99),
    ).rejects.toMatchObject({ code: 'EVENT_REVISION_CONFLICT' });
  });

  it('stamps operational timestamps once', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Stamps', ...futureWindow() });
    await seedPublishedForm(event.id);
    const opened = await mock.mockApi.transitionEvent(event.id, 'open');
    expect(opened.event.openedAt).not.toBeNull();

    const detail = await mock.mockApi.getEvent(event.id);
    expect(detail.event.openedAt).toBe(opened.event.openedAt);
  });
});

describe('detail parity', () => {
  it('reports the same editable fields as the shared table', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Fields', ...futureWindow() });
    for (const status of EVENT_STATUSES) {
      mock.setStatus(event.id, status);
      const detail = await mock.mockApi.getEvent(event.id);
      expect(detail.editableFields.sort(), status).toEqual(
        [...EDITABLE_FIELDS_BY_STATUS[status]].sort(),
      );
    }
  });

  it('never offers an action the shared table forbids', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Actions', ...futureWindow() });
    for (const status of EVENT_STATUSES) {
      mock.setStatus(event.id, status);
      const detail = await mock.mockApi.getEvent(event.id);
      for (const action of detail.availableActions) {
        expect(canTransition(status, action), `${status} -> ${action}`).toBe(true);
      }
    }
  });

  it('404s for an unknown id', async () => {
    await expect(mock.mockApi.getEvent('does-not-exist')).rejects.toMatchObject({
      code: 'EVENT_NOT_FOUND',
      status: 404,
    });
  });
});

describe('duplicate and delete parity', () => {
  it('duplicates into a pristine draft without operational history', async () => {
    const event = await mock.mockApi.createEvent({ name: 'Source', ...futureWindow() });
    await seedPublishedForm(event.id);
    await mock.mockApi.transitionEvent(event.id, 'open');

    const copy = await mock.mockApi.duplicateEvent(event.id, {});
    expect(copy.status).toBe('DRAFT');
    expect(copy.revision).toBe(1);
    expect(copy.openedAt).toBeNull();
    expect(copy.id).not.toBe(event.id);
  });

  it('deletes only a pristine draft', async () => {
    const draft = await mock.mockApi.createEvent({ name: 'Deletable' });
    await expect(mock.mockApi.deleteEvent(draft.id, 1)).resolves.toMatchObject({ ok: true });

    const published = await mock.mockApi.createEvent({ name: 'Kept', ...futureWindow() });
    await seedPublishedForm(published.id);
    await mock.mockApi.transitionEvent(published.id, 'publish');
    await expect(mock.mockApi.deleteEvent(published.id)).rejects.toMatchObject({
      code: 'EVENT_CANNOT_BE_DELETED',
    });
  });
});

describe('listing parity', () => {
  it('excludes archived by default and includes them on request', async () => {
    const active = await mock.mockApi.createEvent({ name: 'Active one', slug: 'active-one' });
    const archived = await mock.mockApi.createEvent({ name: 'Archived one', slug: 'archived-one' });
    await mock.mockApi.transitionEvent(archived.id, 'archive', 1);

    const activeOnly = await mock.mockApi.listEvents({ archived: 'active', pageSize: 100 });
    expect(activeOnly.items.map((e) => e.id)).toContain(active.id);
    expect(activeOnly.items.map((e) => e.id)).not.toContain(archived.id);

    // The mock seeds a demo archived event too, so assert membership and that
    // nothing active leaked in — not an exact list.
    const archivedOnly = await mock.mockApi.listEvents({ archived: 'archived', pageSize: 100 });
    expect(archivedOnly.items.map((e) => e.id)).toContain(archived.id);
    expect(archivedOnly.items.map((e) => e.id)).not.toContain(active.id);
    expect(archivedOnly.items.every((e) => e.status === 'ARCHIVED')).toBe(true);

    const all = await mock.mockApi.listEvents({ archived: 'all', pageSize: 100 });
    expect(all.items.length).toBeGreaterThanOrEqual(2);
  });

  it('searches by name and slug and paginates', async () => {
    await mock.mockApi.createEvent({ name: 'Findable Alpha', slug: 'findable-alpha' });
    await mock.mockApi.createEvent({ name: 'Other', slug: 'other-one' });

    const byName = await mock.mockApi.listEvents({ search: 'Findable', pageSize: 100 });
    expect(byName.items.every((e) => /findable/i.test(e.name))).toBe(true);
    expect(byName.total).toBeGreaterThanOrEqual(1);

    const bySlug = await mock.mockApi.listEvents({ search: 'findable-alpha', pageSize: 100 });
    expect(bySlug.total).toBe(1);

    const paged = await mock.mockApi.listEvents({ pageSize: 1, page: 1, archived: 'all' });
    expect(paged.items).toHaveLength(1);
    expect(paged.totalPages).toBeGreaterThanOrEqual(1);
  });
});

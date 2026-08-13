// Frontend behaviour of the event admin section.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { ApiError } from '../src/lib/api';
import { isoToLocalInput, localInputToIso } from '../src/lib/eventDateTime';
import type { Event, EventDetailResponse, EventListResponse } from '../shared/types';

const mocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
  duplicateEvent: vi.fn(),
  transitionEvent: vi.fn(),
  listAuditLogs: vi.fn(),
  me: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { ManagerEventsPage } = await import('../src/routes/ManagerEventsPage');
const { ManagerEventNewPage } = await import('../src/routes/ManagerEventNewPage');
const { ManagerEventDetailPage } = await import('../src/routes/ManagerEventDetailPage');
const { ManagerEventEditPage } = await import('../src/routes/ManagerEventEditPage');
const { ProtectedRoute } = await import('../src/routes/ProtectedRoute');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    id: EVENT_ID,
    slug: 'grand-opening-smoke-shop',
    name: 'Grand Opening Smoke Shop',
    description: null,
    bannerUrl: null,
    locationName: 'Miami',
    timezone: 'America/New_York',
    registrationOpensAt: '2026-06-01T14:00:00.000Z',
    registrationClosesAt: '2026-06-05T14:00:00.000Z',
    startsAt: '2026-06-06T14:00:00.000Z',
    endsAt: '2026-06-07T14:00:00.000Z',
    minimumAge: 21,
    maxEntriesPerIdentity: 1,
    status: 'DRAFT',
    confirmationTitle: null,
    confirmationMessage: null,
    ineligibleTitle: null,
    ineligibleMessage: null,
    revision: 1,
    createdBy: 'admin-1',
    updatedBy: 'admin-1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    publishedAt: null,
    openedAt: null,
    closedAt: null,
    cancelledAt: null,
    archivedAt: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<EventDetailResponse> = {}): EventDetailResponse {
  const event = overrides.event ?? makeEvent();
  return {
    event,
    availableActions: ['publish', 'open', 'cancel', 'archive'],
    blockedActions: [],
    editableFields: ['name', 'slug', 'description', 'minimumAge', 'timezone'],
    canDelete: true,
    actors: {
      createdBy: { id: 'admin-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
      updatedBy: { id: 'admin-1', displayName: 'Ada Lovelace', email: 'ada@example.com' },
    },
    ...overrides,
  };
}

function listResponse(items: Event[], overrides: Partial<EventListResponse> = {}) {
  return {
    items: items.map((event) => ({
      id: event.id,
      slug: event.slug,
      name: event.name,
      status: event.status,
      timezone: event.timezone,
      registrationOpensAt: event.registrationOpensAt,
      startsAt: event.startsAt,
      revision: event.revision,
      updatedAt: event.updatedAt,
      archivedAt: event.archivedAt,
    })),
    page: 1,
    pageSize: 25,
    total: items.length,
    totalPages: 1,
    ...overrides,
  };
}

function renderAt(ui: ReactNode, route: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Scoped to the results table: the filter dropdowns contain status options. */
async function findTable() {
  return within(await screen.findByRole('table'));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('gg.locale', 'en');
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.listAuditLogs.mockResolvedValue({
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
  });
});

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
describe('timezone conversion', () => {
  it('round-trips wall-clock time in the event timezone, not the browser one', () => {
    // 10:00 in New York on a summer date is 14:00 UTC (EDT, UTC-4).
    const iso = localInputToIso('2026-06-01T10:00', 'America/New_York');
    expect(iso).toBe('2026-06-01T14:00:00.000Z');
    expect(isoToLocalInput(iso, 'America/New_York')).toBe('2026-06-01T10:00');
  });

  it('handles a winter date on the other side of DST', () => {
    // 10:00 in January is EST (UTC-5), so 15:00 UTC.
    expect(localInputToIso('2026-01-15T10:00', 'America/New_York')).toBe(
      '2026-01-15T15:00:00.000Z',
    );
  });

  it('gives a different instant for the same wall clock in another zone', () => {
    const ny = localInputToIso('2026-06-01T10:00', 'America/New_York');
    const madrid = localInputToIso('2026-06-01T10:00', 'Europe/Madrid');
    expect(ny).not.toBe(madrid);
  });

  it('rejects malformed input', () => {
    expect(localInputToIso('not-a-date', 'UTC')).toBeNull();
    expect(isoToLocalInput(null, 'UTC')).toBe('');
  });
});

// ---------------------------------------------------------------------------
describe('route protection', () => {
  it('redirects to login without a session', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    renderAt(
      <Routes>
        <Route
          path="/manager/events"
          element={
            <ProtectedRoute>
              <ManagerEventsPage />
            </ProtectedRoute>
          }
        />
        <Route path="/manager/login" element={<div>LOGIN PAGE</div>} />
      </Routes>,
      '/manager/events',
    );
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(mocks.listEvents).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('event list', () => {
  it('shows loading then the table', async () => {
    let release: (value: EventListResponse) => void = () => {};
    mocks.listEvents.mockImplementation(
      () => new Promise<EventListResponse>((resolve) => { release = resolve; }),
    );
    renderAt(<ManagerEventsPage />, '/manager/events');

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    release(listResponse([makeEvent()]));

    const table = await findTable();
    expect(table.getByText('Grand Opening Smoke Shop')).toBeInTheDocument();
    expect(table.getByText('grand-opening-smoke-shop')).toBeInTheDocument();
    expect(table.getByText('Draft')).toBeInTheDocument();
  });

  it('renders empty and error states', async () => {
    // An empty list means two different things. With nothing filtered, the
    // operator has no events at all and the screen offers to create one; the
    // "nothing matches" wording is reserved for a list they narrowed
    // themselves, where it is the accurate explanation.
    mocks.listEvents.mockResolvedValue(listResponse([]));
    const view = renderAt(<ManagerEventsPage />, '/manager/events');
    expect(await screen.findByText(/no events yet/i)).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: /create event/i })) {
      expect(link).toHaveAttribute('href', '/manager/events/new');
    }
    expect(screen.queryByText(/no events match/i)).not.toBeInTheDocument();
    view.unmount();

    mocks.listEvents.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    renderAt(<ManagerEventsPage />, '/manager/events');
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('blames the filters only when a filter is actually narrowing the list', async () => {
    mocks.listEvents.mockResolvedValue(listResponse([]));
    const user = userEvent.setup();
    renderAt(<ManagerEventsPage />, '/manager/events');

    await screen.findByText(/no events yet/i);

    await user.selectOptions(screen.getByLabelText(/status/i), 'ARCHIVED');

    expect(await screen.findByText(/no events match/i)).toBeInTheDocument();
    expect(screen.queryByText(/no events yet/i)).not.toBeInTheDocument();
  });

  it('sends filters and resets to page 1', async () => {
    mocks.listEvents.mockResolvedValue(listResponse([makeEvent()], { total: 60, totalPages: 3 }));
    const user = userEvent.setup();
    renderAt(<ManagerEventsPage />, '/manager/events');

    await findTable();
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(mocks.listEvents).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })),
    );

    await user.selectOptions(screen.getByLabelText(/^status$/i), 'OPEN');
    await waitFor(() =>
      expect(mocks.listEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'OPEN', page: 1 }),
      ),
    );

    await user.selectOptions(screen.getByLabelText(/archived/i), 'archived');
    await waitFor(() =>
      expect(mocks.listEvents).toHaveBeenLastCalledWith(
        expect.objectContaining({ archived: 'archived' }),
      ),
    );
  });

  it('renders a hostile event name as text, never as markup', async () => {
    mocks.listEvents.mockResolvedValue(
      listResponse([makeEvent({ name: '<img src=x onerror=alert(1)>' })]),
    );
    const view = renderAt(<ManagerEventsPage />, '/manager/events');

    await findTable();
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText(/onerror=alert\(1\)/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('create', () => {
  it('requires a name and submits the rest', async () => {
    mocks.createEvent.mockResolvedValue(makeEvent());
    const user = userEvent.setup();
    renderAt(<ManagerEventNewPage />, '/manager/events/new');

    await user.click(screen.getByRole('button', { name: /create draft/i }));
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(mocks.createEvent).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText(/^name$/i), 'My New Event');
    await user.click(screen.getByRole('button', { name: /create draft/i }));

    await waitFor(() =>
      expect(mocks.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'My New Event', timezone: 'America/New_York' }),
      ),
    );
  });

  it('derives the slug from the name while creating', async () => {
    const user = userEvent.setup();
    renderAt(<ManagerEventNewPage />, '/manager/events/new');

    await user.type(screen.getByLabelText(/^name$/i), 'Summer Giveaway 2026');
    await waitFor(() =>
      expect(screen.getByLabelText(/^slug$/i)).toHaveValue('summer-giveaway-2026'),
    );
  });

  it('surfaces a slug conflict from the server', async () => {
    mocks.createEvent.mockRejectedValue(
      new ApiError(409, 'EVENT_SLUG_EXISTS', 'taken'),
    );
    const user = userEvent.setup();
    renderAt(<ManagerEventNewPage />, '/manager/events/new');

    await user.type(screen.getByLabelText(/^name$/i), 'Duplicate');
    await user.click(screen.getByRole('button', { name: /create draft/i }));

    expect(await screen.findByText(/already used by another event/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('detail', () => {
  function renderDetail() {
    return renderAt(
      <Routes>
        <Route path="/manager/events/:eventId" element={<ManagerEventDetailPage />} />
      </Routes>,
      `/manager/events/${EVENT_ID}`,
    );
  }

  it('shows only the permitted actions', async () => {
    mocks.getEvent.mockResolvedValue(
      makeDetail({ availableActions: ['publish', 'archive'], canDelete: false }),
    );
    renderDetail();

    expect(await screen.findByRole('button', { name: /^schedule$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^archive$/i })).toBeInTheDocument();
    // Not offered by the server, so not offered by the UI.
    expect(screen.queryByRole('button', { name: /close registration/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /delete draft/i })).toBeNull();
  });

  it('explains a blocked action', async () => {
    mocks.getEvent.mockResolvedValue(
      makeDetail({
        availableActions: [],
        blockedActions: [{ action: 'publish', missingFields: ['registrationOpensAt'] }],
      }),
    );
    renderDetail();
    expect(await screen.findByText(/registrationOpensAt/)).toBeInTheDocument();
  });

  it('runs a transition with the current revision', async () => {
    mocks.getEvent.mockResolvedValue(makeDetail());
    mocks.transitionEvent.mockResolvedValue({ event: makeEvent({ status: 'SCHEDULED' }) });
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /^schedule$/i }));
    await waitFor(() =>
      expect(mocks.transitionEvent).toHaveBeenCalledWith(EVENT_ID, 'publish', 1),
    );
  });

  it('confirms before a destructive action and aborts on cancel', async () => {
    mocks.getEvent.mockResolvedValue(makeDetail());
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /^archive$/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.transitionEvent).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('reports a revision conflict from a transition', async () => {
    mocks.getEvent.mockResolvedValue(makeDetail());
    mocks.transitionEvent.mockRejectedValue(
      new ApiError(409, 'EVENT_REVISION_CONFLICT', 'changed'),
    );
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /^schedule$/i }));
    expect(await screen.findByText(/changed since you loaded it/i)).toBeInTheDocument();
  });

  it('duplicates through a dialog', async () => {
    mocks.getEvent.mockResolvedValue(makeDetail());
    mocks.duplicateEvent.mockResolvedValue(makeEvent({ id: 'new-id', slug: 'copy' }));
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /^duplicate$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^duplicate$/i }));

    await waitFor(() =>
      expect(mocks.duplicateEvent).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ name: 'Grand Opening Smoke Shop (copy)' }),
      ),
    );
  });

  it('deletes after confirmation', async () => {
    mocks.getEvent.mockResolvedValue(makeDetail());
    mocks.deleteEvent.mockResolvedValue({ ok: true, id: EVENT_ID });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderDetail();

    await user.click(await screen.findByRole('button', { name: /delete draft/i }));
    // The client passes the id and the revision positionally.
    await waitFor(() => expect(mocks.deleteEvent).toHaveBeenCalledWith(EVENT_ID, 1));
    confirmSpy.mockRestore();
  });

  it('shows a 404 for a missing event', async () => {
    mocks.getEvent.mockRejectedValue(new ApiError(404, 'EVENT_NOT_FOUND', 'gone'));
    renderDetail();
    expect(await screen.findByText(/does not exist/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('edit', () => {
  function renderEdit() {
    return renderAt(
      <Routes>
        <Route path="/manager/events/:eventId/edit" element={<ManagerEventEditPage />} />
      </Routes>,
      `/manager/events/${EVENT_ID}/edit`,
    );
  }

  it('sends the revision it loaded with', async () => {
    mocks.getEvent.mockResolvedValue(makeDetail({ event: makeEvent({ revision: 7 }) }));
    mocks.updateEvent.mockResolvedValue(makeEvent({ revision: 8 }));
    const user = userEvent.setup();
    renderEdit();

    const name = await screen.findByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, 'Renamed Event');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mocks.updateEvent).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ name: 'Renamed Event', expectedRevision: 7 }),
      ),
    );
  });

  it('disables fields the state has frozen', async () => {
    mocks.getEvent.mockResolvedValue(
      makeDetail({
        event: makeEvent({ status: 'OPEN' }),
        editableFields: ['name', 'description'],
      }),
    );
    renderEdit();

    await screen.findByLabelText(/^name$/i);
    // The slug is frozen once the event leaves draft.
    expect(screen.getByLabelText(/^slug$/i)).toBeDisabled();
    expect(screen.getByLabelText(/minimum age/i)).toBeDisabled();
    expect(screen.getByLabelText(/^name$/i)).not.toBeDisabled();
  });

  it('offers a reload when the revision conflicts', async () => {
    mocks.getEvent.mockResolvedValue(makeDetail());
    mocks.updateEvent.mockRejectedValue(
      new ApiError(409, 'EVENT_REVISION_CONFLICT', 'changed'),
    );
    const user = userEvent.setup();
    renderEdit();

    const name = await screen.findByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, 'Attempted rename');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByRole('button', { name: /reload event/i })).toBeInTheDocument();
    // The local edit is NOT discarded, so the operator can retry.
    expect(screen.getByLabelText(/^name$/i)).toHaveValue('Attempted rename');
  });

  it('translates to Spanish', async () => {
    localStorage.setItem('gg.locale', 'es');
    mocks.getEvent.mockResolvedValue(makeDetail());
    renderEdit();
    expect(await screen.findByText(/Editar evento/i)).toBeInTheDocument();
  });
});

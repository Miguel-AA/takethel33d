// Frontend behaviour of the prize admin section.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { PRIZES_PER_EVENT_MAX } from '../shared/limits';
import { ApiError } from '../src/lib/api';
import type {
  EventPrize,
  EventPrizeDetailResponse,
  EventPrizeListResponse,
} from '../shared/types';

const mocks = vi.hoisted(() => ({
  listEventPrizes: vi.fn(),
  getEventPrize: vi.fn(),
  createEventPrize: vi.fn(),
  updateEventPrize: vi.fn(),
  deleteEventPrize: vi.fn(),
  transitionEventPrize: vi.fn(),
  reorderEventPrizes: vi.fn(),
  me: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return { ...actual, api: { ...actual.api, ...mocks } };
});

const { ManagerEventPrizesPage } = await import('../src/routes/ManagerEventPrizesPage');
const { ProtectedRoute } = await import('../src/routes/ProtectedRoute');

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const PRIZE_A = '22222222-2222-4222-8222-222222222222';
const PRIZE_B = '33333333-3333-4333-8333-333333333333';

function makePrize(overrides: Partial<EventPrize> = {}): EventPrize {
  return {
    id: PRIZE_A,
    eventId: EVENT_ID,
    name: 'Vape',
    description: 'A nice vape',
    imageUrl: null,
    quantity: 2,
    sortOrder: 0,
    status: 'ACTIVE',
    revision: 1,
    createdBy: 'admin-1',
    updatedBy: 'admin-1',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function listResponse(
  prizes: EventPrize[],
  eventStatus: EventPrizeListResponse['eventStatus'] = 'DRAFT',
): EventPrizeListResponse {
  const active = prizes.filter((p) => p.status === 'ACTIVE');
  return {
    items: prizes.map((p) => ({
      id: p.id,
      name: p.name,
      imageUrl: p.imageUrl,
      quantity: p.quantity,
      sortOrder: p.sortOrder,
      status: p.status,
      revision: p.revision,
      updatedAt: p.updatedAt,
    })),
    page: 1,
    pageSize: 25,
    total: prizes.length,
    totalPages: 1,
    summary: {
      totalPrizes: prizes.length,
      activePrizes: active.length,
      inactivePrizes: prizes.filter((p) => p.status === 'INACTIVE').length,
      archivedPrizes: prizes.filter((p) => p.status === 'ARCHIVED').length,
      totalActiveUnits: active.reduce((sum, p) => sum + p.quantity, 0),
    },
    eventStatus,
  };
}

function detailResponse(prize: EventPrize, eventStatus = 'DRAFT'): EventPrizeDetailResponse {
  return {
    prize,
    allowedActions: prize.status === 'ACTIVE' ? ['deactivate', 'archive'] : ['activate', 'archive'],
    editableFields:
      eventStatus === 'OPEN'
        ? ['name', 'description', 'imageUrl']
        : ['name', 'description', 'imageUrl', 'quantity'],
    canDelete: eventStatus === 'DRAFT',
    eventStatus: eventStatus as EventPrizeDetailResponse['eventStatus'],
  };
}

function renderPage(ui: ReactNode = <ManagerEventPrizesPage />) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[`/manager/events/${EVENT_ID}/prizes`]}>
          <Routes>
            <Route path="/manager/events/:eventId/prizes" element={ui} />
            <Route path="/manager/login" element={<div>LOGIN PAGE</div>} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('gg.locale', 'en');
  for (const fn of Object.values(mocks)) fn.mockReset();
});

afterEach(() => vi.clearAllMocks());

// ---------------------------------------------------------------------------
describe('route protection', () => {
  it('redirects to login without a session', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    renderPage(
      <ProtectedRoute>
        <ManagerEventPrizesPage />
      </ProtectedRoute>,
    );
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(mocks.listEventPrizes).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('listing', () => {
  it('shows loading, then prizes and the summary', async () => {
    let release: (value: EventPrizeListResponse) => void = () => {};
    mocks.listEventPrizes.mockImplementation(
      () => new Promise<EventPrizeListResponse>((resolve) => { release = resolve; }),
    );
    renderPage();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
    release(listResponse([makePrize({ quantity: 2 }), makePrize({ id: PRIZE_B, name: 'Grinder', quantity: 3, sortOrder: 1 })]));

    expect(await screen.findByText('Vape')).toBeInTheDocument();
    expect(screen.getByText('Grinder')).toBeInTheDocument();
    // 2 + 3 active units.
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders empty and error states', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([]));
    const view = renderPage();
    expect(await screen.findByText(/no prizes match/i)).toBeInTheDocument();
    view.unmount();

    mocks.listEventPrizes.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('renders a hostile prize name as text, never as markup', async () => {
    mocks.listEventPrizes.mockResolvedValue(
      listResponse([makePrize({ name: '<img src=x onerror=alert(1)>' })]),
    );
    const view = renderPage();
    await screen.findByText(/onerror=alert\(1\)/);
    expect(view.container.querySelector('img[src="x"]')).toBeNull();
  });

  it('sends filters to the API', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()]));
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('Vape');
    await user.selectOptions(screen.getByLabelText(/^status$/i), 'INACTIVE');
    await waitFor(() =>
      expect(mocks.listEventPrizes).toHaveBeenLastCalledWith(
        EVENT_ID,
        expect.objectContaining({ status: 'INACTIVE', page: 1 }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
describe('event frozen state', () => {
  it('hides mutating controls and explains why when the event is CLOSED', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()], 'CLOSED'));
    renderPage();

    await screen.findByText('Vape');
    expect(screen.getByText(/prizes are frozen/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add prize/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^deactivate$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /move up/i })).toBeNull();
  });

  it('offers only editorial editing while the event is OPEN', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()], 'OPEN'));
    renderPage();

    await screen.findByText('Vape');
    // Editing stays available (a typo fix), but nothing that changes the offer.
    expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add prize/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^archive$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('create', () => {
  it('validates and submits a new prize', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([]));
    mocks.createEventPrize.mockResolvedValue(makePrize());
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add prize/i }));
    const dialog = await screen.findByRole('dialog');

    await user.click(within(dialog).getByRole('button', { name: /add prize/i }));
    await waitFor(() => expect(within(dialog).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(mocks.createEventPrize).not.toHaveBeenCalled();

    await user.type(within(dialog).getByLabelText(/^name$/i), 'Gift Card');
    const quantity = within(dialog).getByLabelText(/^quantity$/i);
    await user.clear(quantity);
    await user.type(quantity, '3');
    await user.click(within(dialog).getByRole('button', { name: /add prize/i }));

    await waitFor(() =>
      expect(mocks.createEventPrize).toHaveBeenCalledWith(
        EVENT_ID,
        expect.objectContaining({ name: 'Gift Card', quantity: 3 }),
      ),
    );
  });

  it('rejects a javascript: image URL before it reaches the API', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add prize/i }));
    const dialog = await screen.findByRole('dialog');

    await user.type(within(dialog).getByLabelText(/^name$/i), 'Evil');
    await user.type(within(dialog).getByLabelText(/image url/i), 'javascript:alert(1)');
    await user.click(within(dialog).getByRole('button', { name: /add prize/i }));

    expect(await within(dialog).findByText(/http or https/i)).toBeInTheDocument();
    expect(mocks.createEventPrize).not.toHaveBeenCalled();
  });

  it('keeps the dialog and its values when the server rejects', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([]));
    mocks.createEventPrize.mockRejectedValue(
      new ApiError(409, 'PRIZE_LIMIT_REACHED', 'limit', { limit: '100' }),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /add prize/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^name$/i), 'Overflow');
    await user.click(within(dialog).getByRole('button', { name: /add prize/i }));

    expect(await within(dialog).findByText(/maximum of 100 prizes/i)).toBeInTheDocument();
    // The typed value is not discarded.
    expect(within(dialog).getByLabelText(/^name$/i)).toHaveValue('Overflow');
  });
});

// ---------------------------------------------------------------------------
describe('status actions and delete', () => {
  it('deactivates with the current revision', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize({ revision: 4 })]));
    mocks.transitionEventPrize.mockResolvedValue({ prize: makePrize({ status: 'INACTIVE' }) });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^deactivate$/i }));
    await waitFor(() =>
      expect(mocks.transitionEventPrize).toHaveBeenCalledWith(
        EVENT_ID,
        PRIZE_A,
        'deactivate',
        4,
      ),
    );
  });

  it('confirms before archiving and aborts on cancel', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()]));
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^archive$/i }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(mocks.transitionEventPrize).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('confirms before deleting and proceeds on accept', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize({ revision: 2 })]));
    mocks.deleteEventPrize.mockResolvedValue({ ok: true, id: PRIZE_A });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() =>
      expect(mocks.deleteEventPrize).toHaveBeenCalledWith(EVENT_ID, PRIZE_A, 2),
    );
    confirmSpy.mockRestore();
  });

  it('surfaces a revision conflict', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()]));
    mocks.transitionEventPrize.mockRejectedValue(
      new ApiError(409, 'PRIZE_REVISION_CONFLICT', 'changed'),
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^deactivate$/i }));
    expect(await screen.findByText(/changed since you loaded it/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('reordering', () => {
  it('moves a prize and only saves when asked', async () => {
    mocks.listEventPrizes.mockResolvedValue(
      listResponse([
        makePrize({ id: PRIZE_A, name: 'First', sortOrder: 0 }),
        makePrize({ id: PRIZE_B, name: 'Second', sortOrder: 1 }),
      ]),
    );
    mocks.reorderEventPrizes.mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('First');
    // Nothing is written on the move itself — a collective change is explicit.
    await user.click(screen.getAllByRole('button', { name: /move down/i })[0]);
    expect(mocks.reorderEventPrizes).not.toHaveBeenCalled();
    expect(await screen.findByText(/not saved yet/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save order/i }));
    await waitFor(() =>
      expect(mocks.reorderEventPrizes).toHaveBeenCalledWith(EVENT_ID, [
        { prizeId: PRIZE_B, expectedRevision: 1, sortOrder: 0 },
        { prizeId: PRIZE_A, expectedRevision: 1, sortOrder: 1 },
      ]),
    );
  });

  it('lets a pending order be discarded', async () => {
    mocks.listEventPrizes.mockResolvedValue(
      listResponse([
        makePrize({ id: PRIZE_A, name: 'First' }),
        makePrize({ id: PRIZE_B, name: 'Second', sortOrder: 1 }),
      ]),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('First');
    await user.click(screen.getAllByRole('button', { name: /move down/i })[0]);
    await user.click(screen.getByRole('button', { name: /discard/i }));

    expect(screen.queryByText(/not saved yet/i)).not.toBeInTheDocument();
    expect(mocks.reorderEventPrizes).not.toHaveBeenCalled();
  });

  it('reports a reorder conflict without losing the draft order', async () => {
    mocks.listEventPrizes.mockResolvedValue(
      listResponse([
        makePrize({ id: PRIZE_A, name: 'First' }),
        makePrize({ id: PRIZE_B, name: 'Second', sortOrder: 1 }),
      ]),
    );
    mocks.reorderEventPrizes.mockRejectedValue(
      new ApiError(409, 'PRIZE_REORDER_CONFLICT', 'stale'),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByText('First');
    await user.click(screen.getAllByRole('button', { name: /move down/i })[0]);
    await user.click(screen.getByRole('button', { name: /save order/i }));

    expect(await screen.findByText(/order changed since you loaded it/i)).toBeInTheDocument();
    // Still pending, so the operator can retry rather than redo the moves.
    expect(screen.getByText(/not saved yet/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
describe('edit dialog', () => {
  it('disables quantity when the event has frozen it', async () => {
    const prize = makePrize();
    mocks.listEventPrizes.mockResolvedValue(listResponse([prize], 'OPEN'));
    mocks.getEventPrize.mockResolvedValue(detailResponse(prize, 'OPEN'));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    const dialog = await screen.findByRole('dialog');

    expect(within(dialog).getByLabelText(/^quantity$/i)).toBeDisabled();
    expect(within(dialog).getByLabelText(/^name$/i)).not.toBeDisabled();
    expect(within(dialog).getByText(/frozen while the event is open/i)).toBeInTheDocument();
  });

  it('submits the revision it loaded with', async () => {
    const prize = makePrize({ revision: 7 });
    mocks.listEventPrizes.mockResolvedValue(listResponse([prize]));
    mocks.getEventPrize.mockResolvedValue(detailResponse(prize));
    mocks.updateEventPrize.mockResolvedValue(makePrize({ revision: 8 }));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: /^edit$/i }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(within(dialog).getByRole('button', { name: /save changes/i }));

    await waitFor(() =>
      expect(mocks.updateEventPrize).toHaveBeenCalledWith(
        EVENT_ID,
        PRIZE_A,
        expect.objectContaining({ name: 'Renamed', expectedRevision: 7 }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Adversarial regressions.
// ---------------------------------------------------------------------------
describe('reordering never offers what it cannot save', () => {
  it('hides the move controls when the live list spans more than one page', async () => {
    const response = listResponse([
      makePrize({ id: PRIZE_A, name: 'First', sortOrder: 0 }),
      makePrize({ id: PRIZE_B, name: 'Second', sortOrder: 1 }),
    ]);
    // The server refuses a partial ordering, so a paginated list must not
    // render controls whose save could only ever fail.
    mocks.listEventPrizes.mockResolvedValue({ ...response, total: 140, totalPages: 2 });
    renderPage();

    await screen.findByText('First');
    expect(screen.queryByRole('button', { name: /move down/i })).not.toBeInTheDocument();
  });

  it('asks for a page large enough to hold every prize an event may have', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()]));
    renderPage();

    await screen.findByText('Vape');
    expect(mocks.listEventPrizes).toHaveBeenCalledWith(
      EVENT_ID,
      expect.objectContaining({ pageSize: PRIZES_PER_EVENT_MAX }),
    );
  });
});

describe('dialog accessibility', () => {
  it('moves focus into the dialog and closes on Escape, returning focus', async () => {
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()]));
    const user = userEvent.setup();
    renderPage();

    const add = await screen.findByRole('button', { name: /add prize/i });
    add.focus();
    await user.click(add);

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.activeElement).toBe(add);
  });
});

// ---------------------------------------------------------------------------
describe('i18n', () => {
  it('translates to Spanish', async () => {
    localStorage.setItem('gg.locale', 'es');
    mocks.listEventPrizes.mockResolvedValue(listResponse([makePrize()]));
    renderPage();
    expect(await screen.findByText('Premios')).toBeInTheDocument();
    // Wait for the list itself before asserting on a row action.
    await screen.findByText('Vape');
    expect(await screen.findByRole('button', { name: /desactivar/i })).toBeInTheDocument();
    expect(screen.getByText('Unidades activas')).toBeInTheDocument();
  });
});

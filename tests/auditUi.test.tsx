// Frontend behaviour of the audit section.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { ApiError } from '../src/lib/api';
import type { AuditListResponse, AuditLog } from '../shared/types';

const mocks = vi.hoisted(() => ({
  listAuditLogs: vi.fn(),
  getAuditLog: vi.fn(),
  me: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      listAuditLogs: mocks.listAuditLogs,
      getAuditLog: mocks.getAuditLog,
      me: mocks.me,
    },
  };
});

const { ManagerAuditPage } = await import('../src/routes/ManagerAuditPage');
const { ProtectedRoute } = await import('../src/routes/ProtectedRoute');

function makeEntry(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    actorAdminId: '22222222-2222-4222-8222-222222222222',
    actorEmail: 'ada@example.com',
    actorDisplayName: 'Ada Lovelace',
    action: 'ADMIN_LOGIN_SUCCEEDED',
    entityType: 'ADMIN_SESSION',
    entityId: '33333333-3333-4333-8333-333333333333',
    eventId: null,
    previousData: null,
    newData: null,
    metadata: { sessionId: 'abc' },
    ipHash: 'f'.repeat(64),
    userAgent: 'vitest',
    requestId: 'req-12345',
    createdAt: '2026-06-01T12:00:00.000Z',
    ...overrides,
  };
}

function listResponse(items: AuditLog[], overrides: Partial<AuditListResponse> = {}) {
  return {
    items,
    page: 1,
    pageSize: 25,
    total: items.length,
    totalPages: 1,
    ...overrides,
  };
}

function renderPage(ui: ReactNode = <ManagerAuditPage />, route = '/manager/audit') {
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

/**
 * Queries scoped to the results table.
 *
 * The filter dropdowns contain an <option> for every action and entity type, so
 * a bare `getByText('ADMIN_LOGIN_SUCCEEDED')` would match the option rather
 * than the row — and would resolve before the data even arrived.
 */
async function findTable() {
  return within(await screen.findByRole('table'));
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('gg.locale', 'en');
  mocks.listAuditLogs.mockReset();
  mocks.getAuditLog.mockReset();
  mocks.me.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('audit route protection', () => {
  it('redirects to login without a session', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    renderPage(
      <Routes>
        <Route
          path="/manager/audit"
          element={
            <ProtectedRoute>
              <ManagerAuditPage />
            </ProtectedRoute>
          }
        />
        <Route path="/manager/login" element={<div>LOGIN PAGE</div>} />
      </Routes>,
    );
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(mocks.listAuditLogs).not.toHaveBeenCalled();
  });
});

describe('ManagerAuditPage', () => {
  it('shows a loading state then the table', async () => {
    let release: (value: AuditListResponse) => void = () => {};
    mocks.listAuditLogs.mockImplementation(
      () => new Promise<AuditListResponse>((resolve) => { release = resolve; }),
    );
    renderPage();

    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    release(listResponse([makeEntry()]));
    const table = await findTable();
    expect(table.getByText('ADMIN_LOGIN_SUCCEEDED')).toBeInTheDocument();
    expect(table.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(table.getByText('req-12345')).toBeInTheDocument();
  });

  it('renders an empty state', async () => {
    mocks.listAuditLogs.mockResolvedValue(listResponse([]));
    renderPage();
    expect(await screen.findByText(/no audit entries/i)).toBeInTheDocument();
  });

  it('renders an error state', async () => {
    mocks.listAuditLogs.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('explains an invalid-filter rejection specifically', async () => {
    mocks.listAuditLogs.mockRejectedValue(
      new ApiError(400, 'INVALID_QUERY', 'bad filters'),
    );
    renderPage();
    expect(await screen.findByText(/filters are not valid/i)).toBeInTheDocument();
  });

  it('shows the system actor for entries with no admin', async () => {
    mocks.listAuditLogs.mockResolvedValue(
      listResponse([
        makeEntry({
          actorAdminId: null,
          actorDisplayName: null,
          actorEmail: null,
          action: 'ADMIN_LOGIN_FAILED',
          entityType: 'SYSTEM',
        }),
      ]),
    );
    renderPage();
    const table = await findTable();
    expect(table.getByText('System')).toBeInTheDocument();
  });

  it('sends the selected filters to the API and resets to page 1', async () => {
    mocks.listAuditLogs.mockResolvedValue(listResponse([makeEntry()], { totalPages: 3, total: 60 }));
    const user = userEvent.setup();
    renderPage();

    await findTable();
    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(mocks.listAuditLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      ),
    );

    await user.selectOptions(screen.getByLabelText(/action/i), 'ADMIN_LOGOUT');

    await waitFor(() =>
      expect(mocks.listAuditLogs).toHaveBeenLastCalledWith(
        // Narrowing the filter must return to the first page, or the view can
        // land on a page the filtered set no longer has.
        expect.objectContaining({ action: 'ADMIN_LOGOUT', page: 1 }),
      ),
    );
  });

  it('paginates forward and back', async () => {
    mocks.listAuditLogs.mockResolvedValue(
      listResponse([makeEntry()], { total: 60, totalPages: 3 }),
    );
    const user = userEvent.setup();
    renderPage();

    await findTable();
    expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /next/i }));
    await waitFor(() =>
      expect(mocks.listAuditLogs).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 2 }),
      ),
    );
  });

  it('opens the detail view for a row', async () => {
    const entry = makeEntry();
    mocks.listAuditLogs.mockResolvedValue(listResponse([entry]));
    mocks.getAuditLog.mockResolvedValue(entry);
    const user = userEvent.setup();
    renderPage();

    await user.click((await findTable()).getByText('ADMIN_LOGIN_SUCCEEDED'));

    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(mocks.getAuditLog).toHaveBeenCalledWith(entry.id));
    expect(within(dialog).getByText('ada@example.com')).toBeInTheDocument();
    expect(within(dialog).getByText(/Metadata/i)).toBeInTheDocument();
  });

  it('reports a missing entry in the detail view', async () => {
    const entry = makeEntry();
    mocks.listAuditLogs.mockResolvedValue(listResponse([entry]));
    mocks.getAuditLog.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'gone'));
    const user = userEvent.setup();
    renderPage();

    await user.click((await findTable()).getByText('ADMIN_LOGIN_SUCCEEDED'));
    expect(await screen.findByText(/does not exist/i)).toBeInTheDocument();
  });

  it('renders redacted metadata as text, never as markup', async () => {
    const entry = makeEntry({
      metadata: { note: '<img src=x onerror=alert(1)>', password: '[REDACTED]' },
    });
    mocks.listAuditLogs.mockResolvedValue(listResponse([entry]));
    mocks.getAuditLog.mockResolvedValue(entry);
    const user = userEvent.setup();
    const view = renderPage();

    await user.click((await findTable()).getByText('ADMIN_LOGIN_SUCCEEDED'));
    await screen.findByRole('dialog');

    // The payload is visible as escaped text and injected no element.
    expect(view.container.querySelector('img')).toBeNull();
    expect(screen.getByText(/onerror=alert\(1\)/)).toBeInTheDocument();
  });

  it('translates to Spanish', async () => {
    localStorage.setItem('gg.locale', 'es');
    mocks.listAuditLogs.mockResolvedValue(listResponse([]));
    renderPage();
    expect(await screen.findByText(/Ningún registro coincide/i)).toBeInTheDocument();
  });
});

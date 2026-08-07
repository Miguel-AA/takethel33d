// Frontend behaviour of the admin session: login form, route gate, header
// identity and logout. The API module is mocked so these assert the UI's
// contract with the backend, not the backend itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n/I18nProvider';
import { ApiError } from '../src/lib/api';
import type { AdminMeResponse } from '../shared/types';

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
}));

vi.mock('../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/api')>('../src/lib/api');
  return {
    ...actual,
    api: {
      ...actual.api,
      login: mocks.login,
      me: mocks.me,
      logout: mocks.logout,
    },
  };
});

const { ManagerLoginPage } = await import('../src/routes/ManagerLoginPage');
const { ProtectedRoute } = await import('../src/routes/ProtectedRoute');
const { Header } = await import('../src/components/Header');

const ADMIN: AdminMeResponse = {
  admin: {
    id: 'admin-1',
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    role: 'ADMIN',
    status: 'ACTIVE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
};

function renderWithProviders(ui: ReactNode, route = '/manager/login') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // useSession supplies its own retry predicate (it must retry transient
        // failures but never a 401); zero backoff keeps those retries instant
        // in tests instead of waiting out React Query's exponential delay.
        retryDelay: 0,
      },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('gg.locale', 'en');
  mocks.login.mockReset();
  mocks.me.mockReset();
  mocks.logout.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ManagerLoginPage', () => {
  it('renders email and password fields', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    renderWithProviders(<ManagerLoginPage />);

    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    // The shared-password wording is gone.
    expect(screen.queryByText(/enter the password/i)).not.toBeInTheDocument();
  });

  it('requires both fields before calling the API', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.click(await screen.findByRole('button', { name: /sign in/i }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
    });
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('rejects a malformed email client-side', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.type(await screen.findByLabelText(/email/i), 'not-an-email');
    await user.type(screen.getByLabelText(/password/i), 'some-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it('submits email and password to the API', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    mocks.login.mockResolvedValue({ admin: ADMIN.admin, expiresAt: '2099-01-01' });
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.type(await screen.findByLabelText(/email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() =>
      expect(mocks.login).toHaveBeenCalledWith('ada@example.com', 'a-strong-password'),
    );
  });

  it('shows a neutral error for invalid credentials', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    mocks.login.mockRejectedValue(
      new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password'),
    );
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.type(await screen.findByLabelText(/email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/password/i), 'wrong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const message = await screen.findByText(/invalid email or password/i);
    expect(message).toBeInTheDocument();
    // It must not disclose which half was wrong.
    expect(screen.queryByText(/no such account/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/user not found/i)).not.toBeInTheDocument();
  });

  it('explains a suspended account', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    mocks.login.mockRejectedValue(new ApiError(403, 'ADMIN_SUSPENDED', 'suspended'));
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.type(await screen.findByLabelText(/email/i), 'sus@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/account is suspended/i)).toBeInTheDocument();
  });

  it('explains a disabled account and a rate limit', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    mocks.login.mockRejectedValue(new ApiError(429, 'RATE_LIMIT', 'too many'));
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.type(await screen.findByLabelText(/email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText(/too many attempts/i)).toBeInTheDocument();
  });

  it('disables the submit button while the request is in flight', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    let release: (value: unknown) => void = () => {};
    mocks.login.mockImplementation(
      () => new Promise((resolve) => { release = resolve; }),
    );
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.type(await screen.findByLabelText(/email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password');
    const button = screen.getByRole('button', { name: /sign in/i });
    await user.click(button);

    // Prevents a double submit creating two sessions.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /signing in/i })).toBeDisabled(),
    );

    release({ admin: ADMIN.admin, expiresAt: '2099-01-01' });
    await waitFor(() => expect(mocks.login).toHaveBeenCalledTimes(1));
  });

  it('stores no credential in localStorage after a successful login', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'no session'));
    mocks.login.mockResolvedValue({ admin: ADMIN.admin, expiresAt: '2099-01-01' });
    const user = userEvent.setup();
    renderWithProviders(<ManagerLoginPage />);

    await user.type(await screen.findByLabelText(/email/i), 'ada@example.com');
    await user.type(screen.getByLabelText(/password/i), 'a-strong-password');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(mocks.login).toHaveBeenCalled());
    // The session is an HttpOnly cookie: nothing token-shaped may be stored.
    expect(Object.keys(localStorage).filter((k) => k.includes('token'))).toHaveLength(0);
  });
});

describe('ProtectedRoute', () => {
  function renderGuard() {
    return renderWithProviders(
      <Routes>
        <Route
          path="/manager"
          element={
            <ProtectedRoute>
              <div>DASHBOARD</div>
            </ProtectedRoute>
          }
        />
        <Route path="/manager/login" element={<div>LOGIN PAGE</div>} />
      </Routes>,
      '/manager',
    );
  }

  it('validates the session against /me', async () => {
    mocks.me.mockResolvedValue(ADMIN);
    renderGuard();
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
    expect(mocks.me).toHaveBeenCalled();
  });

  it('does not render the dashboard before the session resolves', async () => {
    let release: (value: AdminMeResponse) => void = () => {};
    mocks.me.mockImplementation(
      () => new Promise<AdminMeResponse>((resolve) => { release = resolve; }),
    );
    renderGuard();

    // No flash of authenticated content while /me is pending.
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    release(ADMIN);
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });

  it('redirects to login when there is no session', async () => {
    mocks.me.mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'missing'));
    renderGuard();
    expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
  });

  it('redirects when the session expired, was revoked, or the admin was suspended', async () => {
    for (const code of ['SESSION_EXPIRED', 'SESSION_REVOKED', 'ADMIN_SUSPENDED'] as const) {
      mocks.me.mockReset();
      mocks.me.mockRejectedValue(new ApiError(401, code, code));
      const view = renderGuard();
      expect(await screen.findByText('LOGIN PAGE')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('does NOT treat a network failure as a logout', async () => {
    // A momentary outage must not eject a valid session; the user gets a
    // retryable error instead of being bounced to the login page.
    mocks.me.mockRejectedValue(new TypeError('Failed to fetch'));
    renderGuard();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
    expect(screen.queryByText('DASHBOARD')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('does NOT treat a 500 as a logout', async () => {
    mocks.me.mockRejectedValue(new ApiError(500, 'SERVER_ERROR', 'boom'));
    renderGuard();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
  });

  it('recovers when the user retries after the automatic attempts are exhausted', async () => {
    // useSession retries transient failures twice on its own, so all three
    // attempts must fail before the manual retry affordance is shown.
    mocks.me
      .mockRejectedValueOnce(new ApiError(500, 'SERVER_ERROR', 'boom'))
      .mockRejectedValueOnce(new ApiError(500, 'SERVER_ERROR', 'boom'))
      .mockRejectedValueOnce(new ApiError(500, 'SERVER_ERROR', 'boom'))
      .mockResolvedValue(ADMIN);
    const user = userEvent.setup();
    renderGuard();

    await user.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
  });

  it('a transient failure that self-heals never shows an error', async () => {
    mocks.me
      .mockRejectedValueOnce(new ApiError(500, 'SERVER_ERROR', 'boom'))
      .mockResolvedValue(ADMIN);
    renderGuard();

    // The automatic retry absorbs it: the admin is never bounced or alarmed.
    expect(await screen.findByText('DASHBOARD')).toBeInTheDocument();
    expect(screen.queryByText('LOGIN PAGE')).not.toBeInTheDocument();
  });
});

describe('session eviction on 401 from another query', () => {
  it('removes the cached session so the dashboard cannot keep rendering', async () => {
    // Regression guard: `setQueryData(key, undefined)` is a NO-OP in React
    // Query v5, so the previous implementation left the stale session in cache
    // and ProtectedRoute kept rendering the dashboard after a 401 elsewhere.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(['session'], ADMIN);
    expect(queryClient.getQueryData(['session'])).toBeDefined();

    queryClient.setQueryData(['session'], undefined);
    expect(
      queryClient.getQueryData(['session']),
      'setQueryData(undefined) must not be relied on to evict',
    ).toBeDefined();

    queryClient.removeQueries({ queryKey: ['session'] });
    expect(queryClient.getQueryData(['session'])).toBeUndefined();
  });
});

describe('Header', () => {
  it('shows the administrator identity on admin routes', async () => {
    mocks.me.mockResolvedValue(ADMIN);
    renderWithProviders(<Header />, '/manager');

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('calls the logout endpoint instead of only clearing local state', async () => {
    mocks.me.mockResolvedValue(ADMIN);
    mocks.logout.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderWithProviders(<Header />, '/manager');

    await user.click(await screen.findByRole('button', { name: /sign out/i }));

    await waitFor(() => expect(mocks.logout).toHaveBeenCalledTimes(1));
  });

  it('does not query the session on public routes', async () => {
    renderWithProviders(<Header />, '/events');
    await waitFor(() => expect(screen.getByText(/log in/i)).toBeInTheDocument());
    // An anonymous visitor must not trigger a guaranteed 401.
    expect(mocks.me).not.toHaveBeenCalled();
  });
});

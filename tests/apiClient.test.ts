// Exercises the REAL api client against a stubbed fetch.
//
// The component tests mock `src/lib/api` wholesale, so the transport itself —
// credential mode, headers, error mapping — was never executed by anything.
// These tests cover it, because that is where "the session travels in a cookie
// and nothing else" is actually implemented.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

let calls: CapturedCall[] = [];

/** Loads the api module with mock mode forced OFF, so `fetch` is really used. */
async function loadRealApi() {
  vi.resetModules();
  vi.stubEnv('VITE_USE_MOCK_API', 'false');
  vi.stubEnv('VITE_API_BASE_URL', '');
  return import('../src/lib/api');
}

function stubFetch(status: number, body: unknown, ok = status < 400) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      statusText: 'stubbed',
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('transport', () => {
  it('sends cookies with every request and never an Authorization header', async () => {
    const { api } = await loadRealApi();
    stubFetch(200, { admin: { id: '1' } });

    await api.me();

    expect(calls).toHaveLength(1);
    const { init } = calls[0];
    // The session is an HttpOnly cookie: the browser must attach it.
    expect(init.credentials).toBe('same-origin');

    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toMatch(/bearer/i);
  });

  it('never puts a credential in the URL', async () => {
    const { api } = await loadRealApi();
    stubFetch(200, { items: [], total: 0, page: 1, pageSize: 25 });

    await api.listAttendees({ search: 'ana', page: 2, pageSize: 10 });

    expect(calls[0].url).toBe('/api/attendees?search=ana&page=2&pageSize=10');
    expect(calls[0].url).not.toMatch(/token|session|password/i);
  });

  it('targets the documented endpoints and methods', async () => {
    const { api } = await loadRealApi();
    stubFetch(200, {});

    await api.login('a@b.com', 'pw');
    await api.me();
    await api.logout();

    expect(calls[0]).toMatchObject({ url: '/api/manager/login' });
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      email: 'a@b.com',
      password: 'pw',
    });

    expect(calls[1]).toMatchObject({ url: '/api/manager/me' });
    expect(calls[1].init.method).toBe('GET');

    expect(calls[2]).toMatchObject({ url: '/api/manager/logout' });
    expect(calls[2].init.method).toBe('POST');
  });

  it('does not send a body on GET requests', async () => {
    const { api } = await loadRealApi();
    stubFetch(200, {});
    await api.metrics();
    expect(calls[0].init.body).toBeUndefined();
  });
});

describe('error mapping', () => {
  it('turns an error envelope into a typed ApiError', async () => {
    const { api, ApiError } = await loadRealApi();
    stubFetch(401, {
      error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
    });

    const err = await api.login('a@b.com', 'wrong').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid email or password',
    });
  });

  it('preserves field details for validation errors', async () => {
    const { api } = await loadRealApi();
    stubFetch(400, {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed',
        fields: { email: 'invalid' },
      },
    });

    const err = (await api.register({} as never).catch((e: unknown) => e)) as {
      fields?: Record<string, string>;
    };
    expect(err.fields).toEqual({ email: 'invalid' });
  });

  it('falls back to UNAUTHORIZED on a 401 with an unreadable body', async () => {
    const { api } = await loadRealApi();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => {
        throw new Error('not json');
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const err = (await api.me().catch((e: unknown) => e)) as { code: string };
    expect(err.code).toBe('UNAUTHORIZED');
  });

  it('falls back to SERVER_ERROR on a non-401 with an unreadable body', async () => {
    const { api } = await loadRealApi();
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => {
        throw new Error('not json');
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const err = (await api.metrics().catch((e: unknown) => e)) as { code: string };
    expect(err.code).toBe('SERVER_ERROR');
  });
});

describe('audit endpoints', () => {
  it('serialises only the filters that were supplied', async () => {
    const { api } = await loadRealApi();
    stubFetch(200, { items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 });

    await api.listAuditLogs({
      page: 2,
      pageSize: 10,
      action: 'ADMIN_LOGIN_SUCCEEDED',
      entityId: undefined,
      from: '',
    });

    // Empty and undefined filters are omitted rather than sent as blanks.
    expect(calls[0].url).toBe(
      '/api/audit?page=2&pageSize=10&action=ADMIN_LOGIN_SUCCEEDED',
    );
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.credentials).toBe('same-origin');
  });

  it('requests the bare listing when no filters are given', async () => {
    const { api } = await loadRealApi();
    stubFetch(200, { items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 });
    await api.listAuditLogs();
    expect(calls[0].url).toBe('/api/audit');
  });

  it('encodes the id in the detail path', async () => {
    const { api } = await loadRealApi();
    stubFetch(200, { id: 'x' });
    await api.getAuditLog('a b/c');
    expect(calls[0].url).toBe('/api/audit/a%20b%2Fc');
  });

  it('surfaces a typed 404', async () => {
    const { api, ApiError } = await loadRealApi();
    stubFetch(404, { error: { code: 'NOT_FOUND', message: 'Audit log not found' } });

    const err = await api.getAuditLog('missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('captures the request id from the error body', async () => {
    const { api } = await loadRealApi();
    stubFetch(400, {
      error: { code: 'INVALID_QUERY', message: 'bad', requestId: 'req-xyz' },
    });

    const err = (await api.listAuditLogs({ action: 'nope' }).catch((e: unknown) => e)) as {
      requestId?: string;
    };
    expect(err.requestId).toBe('req-xyz');
  });
});

describe('isSessionEnded', () => {
  it('recognises every 401 code that means the session is unusable', async () => {
    const { ApiError, isSessionEnded } = await loadRealApi();
    for (const code of [
      'UNAUTHORIZED',
      'SESSION_INVALID',
      'SESSION_EXPIRED',
      'SESSION_REVOKED',
      'ADMIN_SUSPENDED',
      'ADMIN_DISABLED',
    ] as const) {
      expect(isSessionEnded(new ApiError(401, code, code)), code).toBe(true);
    }
  });

  it('does NOT treat other failures as an ended session', async () => {
    const { ApiError, isSessionEnded } = await loadRealApi();
    // These must never log an administrator out.
    expect(isSessionEnded(new ApiError(500, 'SERVER_ERROR', 'boom'))).toBe(false);
    expect(isSessionEnded(new ApiError(429, 'RATE_LIMIT', 'slow down'))).toBe(false);
    expect(isSessionEnded(new ApiError(404, 'NOT_FOUND', 'missing'))).toBe(false);
    expect(isSessionEnded(new TypeError('Failed to fetch'))).toBe(false);
    expect(isSessionEnded(null)).toBe(false);
    // A 403 is an authorisation answer, not an ended session.
    expect(isSessionEnded(new ApiError(403, 'ADMIN_SUSPENDED', 'suspended'))).toBe(false);
  });
});

describe('mock mode', () => {
  it('routes through the in-memory mock without touching fetch', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_USE_MOCK_API', 'true');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { api } = await import('../src/lib/api');
    const result = await api.login('admin@l33d.test', 'l33d-dev-password');

    expect(result.admin.email).toBe('admin@l33d.test');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

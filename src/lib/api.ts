import type {
  ApiErrorBody,
  ApiErrorCode,
  Attendee,
  AttendeeListResponse,
  CurrentRaffleResponse,
  LoginResponse,
  Metrics,
  RaffleDrawRequest,
  RaffleDrawResponse,
  RegisterRequest,
  RegisterResponse,
} from '@shared/types';
import { getToken } from './auth';
import { mockApi } from './mockApi';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';
const USE_MOCK =
  import.meta.env.VITE_USE_MOCK_API === 'true' ||
  (import.meta.env.DEV &&
    import.meta.env.VITE_USE_MOCK_API !== 'false' &&
    !BASE_URL);

export class ApiError extends Error {
  status: number;
  code: ApiErrorCode;
  fields?: Record<string, string>;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    fields?: Record<string, string>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options.auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let errorBody: ApiErrorBody | null = null;
    try {
      errorBody = (await res.json()) as ApiErrorBody;
    } catch {
      // fallthrough
    }
    const code: ApiErrorCode =
      errorBody?.error?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : 'SERVER_ERROR');
    const message = errorBody?.error?.message ?? res.statusText;
    throw new ApiError(res.status, code, message, errorBody?.error?.fields);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  register(body: RegisterRequest): Promise<RegisterResponse> {
    if (USE_MOCK) return mockApi.register(body);
    return request<RegisterResponse>('POST', '/api/register', { body });
  },

  login(password: string): Promise<LoginResponse> {
    if (USE_MOCK) return mockApi.login(password);
    return request<LoginResponse>('POST', '/api/manager/login', {
      body: { password },
    });
  },

  me(): Promise<{ ok: true }> {
    if (USE_MOCK) return mockApi.me();
    return request<{ ok: true }>('GET', '/api/manager/me', { auth: true });
  },

  listAttendees(params: {
    search?: string;
    page?: number;
    pageSize?: number;
  }): Promise<AttendeeListResponse> {
    const q = new URLSearchParams();
    if (params.search) q.set('search', params.search);
    if (params.page) q.set('page', String(params.page));
    if (params.pageSize) q.set('pageSize', String(params.pageSize));
    const qs = q.toString();
    if (USE_MOCK) return mockApi.listAttendees(params);
    return request<AttendeeListResponse>(
      'GET',
      `/api/attendees${qs ? `?${qs}` : ''}`,
      { auth: true },
    );
  },

  getAttendee(id: string): Promise<Attendee> {
    if (USE_MOCK) return mockApi.getAttendee(id);
    return request<Attendee>('GET', `/api/attendees/${encodeURIComponent(id)}`, {
      auth: true,
    });
  },

  metrics(): Promise<Metrics> {
    if (USE_MOCK) return mockApi.metrics();
    return request<Metrics>('GET', '/api/metrics', { auth: true });
  },

  drawRaffle(body: RaffleDrawRequest): Promise<RaffleDrawResponse> {
    if (USE_MOCK) return mockApi.drawRaffle(body);
    return request<RaffleDrawResponse>('POST', '/api/raffle/draw', {
      auth: true,
      body,
    });
  },

  currentRaffle(): Promise<CurrentRaffleResponse | null> {
    if (USE_MOCK) return mockApi.currentRaffle();
    return request<CurrentRaffleResponse | null>('GET', '/api/raffle/current', {
      auth: true,
    });
  },
};

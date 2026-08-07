import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_EMAIL = 'admin@l33d.test';
const ADMIN_PASSWORD = 'l33d-dev-password';

async function freshMockApi() {
  const mockMod = await import('../src/lib/mockApi');
  const apiMod = await import('../src/lib/api');
  return {
    mockApi: mockMod.mockApi,
    setStatus: mockMod.__setMockAdminStatus,
    ApiError: apiMod.ApiError,
  };
}

/** Signs in as the seeded dev admin. */
async function loginAsAdmin(mockApi: {
  login: (email: string, password: string) => Promise<unknown>;
}) {
  return mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);
}

beforeEach(() => {
  vi.resetModules();
});

const sampleRegister = {
  firstName: 'Carla',
  lastName: 'Pérez',
  email: 'carla@example.com',
  phone: '555-1234',
  highestLevelOfEducation: 'BACHELORS' as const,
  age: 30,
  zip: '33101',
  city: 'Miami',
  housingStatus: 'OWNER' as const,
  ownsVehicle: true,
  isBusinessOwner: false,
};

describe('mockApi', () => {
  it('rejects authenticated calls without a session', async () => {
    const { mockApi, ApiError } = await freshMockApi();
    await expect(mockApi.metrics()).rejects.toBeInstanceOf(ApiError);
  });

  it('logs in with a seeded admin account and unlocks protected calls', async () => {
    const { mockApi } = await freshMockApi();
    const result = await mockApi.login(ADMIN_EMAIL, ADMIN_PASSWORD);

    expect(result.admin.email).toBe(ADMIN_EMAIL);
    expect(result.admin.role).toBe('ADMIN');
    expect(result.admin.status).toBe('ACTIVE');
    expect(result.expiresAt).toEqual(expect.any(String));
    // No credential is handed to the client — the real backend uses a cookie.
    expect(JSON.stringify(result)).not.toContain('password');

    const me = await mockApi.me();
    expect(me.admin.email).toBe(ADMIN_EMAIL);
  });

  it('rejects a bad password and an unknown email identically', async () => {
    const { mockApi } = await freshMockApi();
    const wrongPassword = await mockApi
      .login(ADMIN_EMAIL, 'nope')
      .catch((err: { code: string; status: number }) => err);
    const unknownEmail = await mockApi
      .login('ghost@l33d.test', ADMIN_PASSWORD)
      .catch((err: { code: string; status: number }) => err);

    expect(wrongPassword).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
    expect(unknownEmail).toMatchObject({ code: 'INVALID_CREDENTIALS', status: 401 });
  });

  it('normalizes the email on login', async () => {
    const { mockApi } = await freshMockApi();
    const result = await mockApi.login('  ADMIN@L33D.TEST ', ADMIN_PASSWORD);
    expect(result.admin.email).toBe(ADMIN_EMAIL);
  });

  it('refuses suspended and disabled accounts', async () => {
    const { mockApi } = await freshMockApi();
    await expect(
      mockApi.login('suspended@l33d.test', ADMIN_PASSWORD),
    ).rejects.toMatchObject({ code: 'ADMIN_SUSPENDED', status: 403 });
    await expect(
      mockApi.login('disabled@l33d.test', ADMIN_PASSWORD),
    ).rejects.toMatchObject({ code: 'ADMIN_DISABLED', status: 403 });
  });

  it('rejects /me without a session', async () => {
    const { mockApi } = await freshMockApi();
    await expect(mockApi.me()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
  });

  it('logout really invalidates the session', async () => {
    const { mockApi } = await freshMockApi();
    await loginAsAdmin(mockApi);
    await expect(mockApi.me()).resolves.toBeTruthy();

    await expect(mockApi.logout()).resolves.toEqual({ ok: true });

    await expect(mockApi.me()).rejects.toMatchObject({ status: 401 });
    // Idempotent.
    await expect(mockApi.logout()).resolves.toEqual({ ok: true });
  });

  it('suspending an admin invalidates a live session', async () => {
    const { mockApi, setStatus } = await freshMockApi();
    await loginAsAdmin(mockApi);
    await expect(mockApi.me()).resolves.toBeTruthy();

    setStatus(ADMIN_EMAIL, 'SUSPENDED');

    await expect(mockApi.me()).rejects.toMatchObject({
      code: 'ADMIN_SUSPENDED',
      status: 401,
    });
  });

  it('register assigns an incrementing participant number and rejects duplicates', async () => {
    const { mockApi } = await freshMockApi();
    const first = await mockApi.register(sampleRegister);
    expect(first.participantNumber).toBeGreaterThan(0);
    const second = await mockApi.register({ ...sampleRegister, email: 'other@example.com' });
    expect(second.participantNumber).toBe(first.participantNumber + 1);

    await expect(mockApi.register(sampleRegister)).rejects.toMatchObject({
      code: 'EMAIL_EXISTS',
      status: 409,
    });
  });

  it('metrics reflect new registrations', async () => {
    const { mockApi } = await freshMockApi();
    await loginAsAdmin(mockApi);
    const before = await mockApi.metrics();
    await mockApi.register({ ...sampleRegister, email: 'unique1@example.com' });
    const after = await mockApi.metrics();
    expect(after.total).toBe(before.total + 1);
  });

  it('metrics housing breakdown plus unknown sums to the total', async () => {
    const { mockApi } = await freshMockApi();
    await loginAsAdmin(mockApi);
    const m = await mockApi.metrics();
    expect(m.byHousingStatus.OWNER + m.byHousingStatus.RENTER + m.byHousingStatus.unknown)
      .toBe(m.total);
  });

  it('drawRaffle manual mode finds participant by number', async () => {
    const { mockApi } = await freshMockApi();
    await loginAsAdmin(mockApi);
    const reg = await mockApi.register({ ...sampleRegister, email: 'winner@example.com' });
    const result = await mockApi.drawRaffle({
      mode: 'manual',
      participantNumber: reg.participantNumber,
    });
    expect(result.winner.email).toBe('winner@example.com');
    expect(result.winner.firstName).toBe('Carla');
    expect(result.emailSent).toBe(true);
  });

  it('drawRaffle manual mode 404s on a missing number when the store has attendees', async () => {
    const { mockApi } = await freshMockApi();
    await loginAsAdmin(mockApi);
    await mockApi.listAttendees({});
    await expect(
      mockApi.drawRaffle({ mode: 'manual', participantNumber: 99999 }),
    ).rejects.toMatchObject({ code: 'WINNER_NOT_FOUND', status: 404 });
  });

  it('drawRaffle returns NO_ATTENDEES when the store is empty', async () => {
    const { mockApi } = await freshMockApi();
    await loginAsAdmin(mockApi);
    await expect(mockApi.drawRaffle({ mode: 'random' })).rejects.toMatchObject({
      code: 'NO_ATTENDEES',
      status: 400,
    });
  });

  it('listAttendees filters by participant number string', async () => {
    const { mockApi } = await freshMockApi();
    await loginAsAdmin(mockApi);
    const reg = await mockApi.register({ ...sampleRegister, email: 'searchme@example.com' });
    const padded = reg.participantNumber.toString().padStart(3, '0');
    const result = await mockApi.listAttendees({ search: padded });
    expect(result.items.some((a) => a.participantNumber === reg.participantNumber)).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

async function freshMockApi() {
  const mockMod = await import('../src/lib/mockApi');
  const apiMod = await import('../src/lib/api');
  return { mockApi: mockMod.mockApi, ApiError: apiMod.ApiError };
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

  it('logs in with the seeded password and unlocks protected calls', async () => {
    const { mockApi } = await freshMockApi();
    const { token } = await mockApi.login('admin');
    expect(token).toBeTruthy();
    await expect(mockApi.me()).resolves.toEqual({ ok: true });
  });

  it('rejects login with a bad password', async () => {
    const { mockApi } = await freshMockApi();
    await expect(mockApi.login('wrong')).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
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
    await mockApi.login('admin');
    const before = await mockApi.metrics();
    await mockApi.register({ ...sampleRegister, email: 'unique1@example.com' });
    const after = await mockApi.metrics();
    expect(after.total).toBe(before.total + 1);
  });

  it('metrics housing breakdown plus unknown sums to the total', async () => {
    const { mockApi } = await freshMockApi();
    await mockApi.login('admin');
    const m = await mockApi.metrics();
    expect(m.byHousingStatus.OWNER + m.byHousingStatus.RENTER + m.byHousingStatus.unknown)
      .toBe(m.total);
  });

  it('drawRaffle manual mode finds participant by number', async () => {
    const { mockApi } = await freshMockApi();
    await mockApi.login('admin');
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
    await mockApi.login('admin');
    await mockApi.listAttendees({});
    await expect(
      mockApi.drawRaffle({ mode: 'manual', participantNumber: 99999 }),
    ).rejects.toMatchObject({ code: 'WINNER_NOT_FOUND', status: 404 });
  });

  it('drawRaffle returns NO_ATTENDEES when the store is empty', async () => {
    const { mockApi } = await freshMockApi();
    await mockApi.login('admin');
    await expect(mockApi.drawRaffle({ mode: 'random' })).rejects.toMatchObject({
      code: 'NO_ATTENDEES',
      status: 400,
    });
  });

  it('listAttendees filters by participant number string', async () => {
    const { mockApi } = await freshMockApi();
    await mockApi.login('admin');
    const reg = await mockApi.register({ ...sampleRegister, email: 'searchme@example.com' });
    const padded = reg.participantNumber.toString().padStart(3, '0');
    const result = await mockApi.listAttendees({ search: padded });
    expect(result.items.some((a) => a.participantNumber === reg.participantNumber)).toBe(true);
  });
});

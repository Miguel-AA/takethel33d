import { describe, expect, it } from 'vitest';
import { rowToAttendee, rowToAttendeeIso, sqliteToIso } from '../functions/_shared/db';

describe('rowToAttendee', () => {
  it('maps snake_case rows to camelCase Attendee', () => {
    const row = {
      id: 'a',
      participant_number: 3,
      first_name: 'Ana',
      last_name: 'López',
      email: 'x@x.com',
      phone: '1',
      highest_level_of_education: 'BACHELORS' as const,
      age: 34,
      zip: '33101',
      city: 'Miami',
      housing_status: 'OWNER' as const,
      owns_vehicle: 1,
      is_business_owner: 0,
      created_at: '2026-01-01 10:00:00',
    };
    const out = rowToAttendee(row);
    expect(out.participantNumber).toBe(3);
    expect(out.firstName).toBe('Ana');
    expect(out.lastName).toBe('López');
    expect(out.housingStatus).toBe('OWNER');
    expect(out.ownsVehicle).toBe(true);
    expect(out.isBusinessOwner).toBe(false);
    expect(out.createdAt).toBe('2026-01-01 10:00:00');
  });

  it('maps null survey columns to undefined (legacy rows read cleanly)', () => {
    const row = {
      id: 'a',
      participant_number: 3,
      first_name: 'X',
      last_name: '',
      email: 'x@x.com',
      phone: '1',
      highest_level_of_education: null,
      age: null,
      zip: null,
      city: null,
      housing_status: null,
      owns_vehicle: null,
      is_business_owner: null,
      created_at: '2026-01-01 10:00:00',
    };
    const out = rowToAttendee(row);
    expect(out.age).toBeUndefined();
    expect(out.ownsVehicle).toBeUndefined();
    expect(out.housingStatus).toBeUndefined();
  });

  it('rowToAttendeeIso normalizes naive timestamps to ISO UTC', () => {
    const row = {
      id: 'a',
      participant_number: 3,
      first_name: 'X',
      last_name: 'Y',
      email: 'x@x.com',
      phone: '1',
      highest_level_of_education: 'HIGH_SCHOOL' as const,
      age: 20,
      zip: '00001',
      city: 'Z',
      housing_status: 'RENTER' as const,
      owns_vehicle: 0,
      is_business_owner: 1,
      created_at: '2026-01-01 10:00:00',
    };
    const out = rowToAttendeeIso(row);
    expect(out.createdAt).toBe('2026-01-01T10:00:00Z');
  });

  it('sqliteToIso leaves already-ISO values alone', () => {
    expect(sqliteToIso('2026-01-01T10:00:00Z')).toBe('2026-01-01T10:00:00Z');
  });
});

// Auth helpers moved to tests/auth.test.ts (shared primitives) and
// tests/cookies.test.ts (session transport) when bearer tokens were replaced
// by HttpOnly cookies.

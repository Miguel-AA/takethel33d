import { describe, expect, it } from 'vitest';
import { rowToAttendee, rowToAttendeeIso, sqliteToIso } from '../functions/_shared/db';
import { extractBearerToken, timingSafeEqual } from '../functions/_shared/auth';

describe('rowToAttendee', () => {
  it('maps snake_case rows to camelCase Attendee', () => {
    const row = {
      id: 'a',
      participant_number: 3,
      nombre: 'X',
      email: 'x@x.com',
      telefono: '1',
      insurance_type: 'AUTO' as const,
      created_at: '2026-01-01 10:00:00',
    };
    const out = rowToAttendee(row);
    expect(out.participantNumber).toBe(3);
    expect(out.insuranceType).toBe('AUTO');
    expect(out.createdAt).toBe('2026-01-01 10:00:00');
  });

  it('rowToAttendeeIso normalizes naive timestamps to ISO UTC', () => {
    const row = {
      id: 'a',
      participant_number: 3,
      nombre: 'X',
      email: 'x@x.com',
      telefono: '1',
      insurance_type: 'HOUSE' as const,
      created_at: '2026-01-01 10:00:00',
    };
    const out = rowToAttendeeIso(row);
    expect(out.createdAt).toBe('2026-01-01T10:00:00Z');
  });

  it('sqliteToIso leaves already-ISO values alone', () => {
    expect(sqliteToIso('2026-01-01T10:00:00Z')).toBe('2026-01-01T10:00:00Z');
  });
});

describe('auth helpers', () => {
  it('timingSafeEqual returns true for equal strings, false otherwise', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('extractBearerToken parses Authorization header', () => {
    const req = new Request('http://localhost/', {
      headers: { Authorization: 'Bearer my-token' },
    });
    expect(extractBearerToken(req)).toBe('my-token');

    const reqNo = new Request('http://localhost/');
    expect(extractBearerToken(reqNo)).toBeNull();

    const reqWrong = new Request('http://localhost/', {
      headers: { Authorization: 'Basic abc' },
    });
    expect(extractBearerToken(reqWrong)).toBeNull();
  });
});

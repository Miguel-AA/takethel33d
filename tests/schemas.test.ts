import { describe, expect, it } from 'vitest';
import {
  loginSchema,
  raffleDrawSchema,
  registerSchema,
} from '../shared/schemas';

const validRegister = {
  nombre: 'Ana López',
  email: 'ANA@example.com',
  telefono: '+1 555 123 4567',
  insuranceType: 'AUTO',
};

describe('registerSchema', () => {
  it('accepts a valid payload and normalizes email to lowercase', () => {
    const parsed = registerSchema.parse(validRegister);
    expect(parsed.email).toBe('ana@example.com');
    expect(parsed.insuranceType).toBe('AUTO');
  });

  it('rejects malformed emails', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, email: 'not-an-email' }),
    ).toThrow();
  });

  it('rejects phone numbers with letters', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, telefono: 'abc-123' }),
    ).toThrow();
  });

  it('rejects unknown insurance types', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, insuranceType: 'TRAVEL' }),
    ).toThrow();
  });

  it('accepts HOUSE, AUTO and LIFE', () => {
    for (const t of ['HOUSE', 'AUTO', 'LIFE'] as const) {
      const parsed = registerSchema.parse({ ...validRegister, insuranceType: t });
      expect(parsed.insuranceType).toBe(t);
    }
  });

  it('rejects names that are too short', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, nombre: 'A' }),
    ).toThrow();
  });
});

describe('loginSchema', () => {
  it('requires a non-empty password', () => {
    expect(loginSchema.parse({ password: 'hunter2' }).password).toBe('hunter2');
    expect(() => loginSchema.parse({ password: '' })).toThrow();
  });
});

describe('raffleDrawSchema', () => {
  it('accepts random mode', () => {
    expect(raffleDrawSchema.parse({ mode: 'random' })).toEqual({ mode: 'random' });
  });
  it('accepts manual mode with a positive integer', () => {
    expect(raffleDrawSchema.parse({ mode: 'manual', participantNumber: 7 })).toEqual({
      mode: 'manual',
      participantNumber: 7,
    });
  });
  it('coerces string participantNumber to a number', () => {
    expect(raffleDrawSchema.parse({ mode: 'manual', participantNumber: '42' })).toEqual({
      mode: 'manual',
      participantNumber: 42,
    });
  });
  it('rejects manual mode with zero or negative number', () => {
    expect(() =>
      raffleDrawSchema.parse({ mode: 'manual', participantNumber: 0 }),
    ).toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import {
  ADMIN_PASSWORD_MIN_LENGTH,
  adminBootstrapSchema,
  adminLoginSchema,
  normalizeEmail,
  raffleDrawSchema,
  registerSchema,
} from '../shared/schemas';

const validRegister = {
  firstName: 'Ana',
  lastName: 'López',
  email: 'ANA@example.com',
  phone: '+1 555 123 4567',
  highestLevelOfEducation: 'BACHELORS',
  age: 34,
  zip: '33101',
  city: 'Miami',
  housingStatus: 'OWNER',
  ownsVehicle: true,
  isBusinessOwner: false,
};

describe('registerSchema', () => {
  it('accepts a valid payload and normalizes email to lowercase', () => {
    const parsed = registerSchema.parse(validRegister);
    expect(parsed.email).toBe('ana@example.com');
    expect(parsed.firstName).toBe('Ana');
    expect(parsed.housingStatus).toBe('OWNER');
  });

  it('rejects malformed emails', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, email: 'not-an-email' }),
    ).toThrow();
  });

  it('rejects phone numbers with letters', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, phone: 'abc-123' }),
    ).toThrow();
  });

  it('rejects an invalid zip', () => {
    expect(() => registerSchema.parse({ ...validRegister, zip: '12' })).toThrow();
    expect(registerSchema.parse({ ...validRegister, zip: '33101-1234' }).zip).toBe('33101-1234');
  });

  it('rejects unknown education levels', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, highestLevelOfEducation: 'PHD' }),
    ).toThrow();
  });

  it('rejects unknown housing status', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, housingStatus: 'SQUATTER' }),
    ).toThrow();
  });

  it('coerces age strings to numbers and enforces bounds', () => {
    expect(registerSchema.parse({ ...validRegister, age: '40' }).age).toBe(40);
    expect(() => registerSchema.parse({ ...validRegister, age: 5 })).toThrow();
  });

  it('accepts booleans as real booleans or "true"/"false" strings', () => {
    expect(registerSchema.parse({ ...validRegister, ownsVehicle: false }).ownsVehicle).toBe(false);
    expect(registerSchema.parse({ ...validRegister, ownsVehicle: 'true' }).ownsVehicle).toBe(true);
    expect(registerSchema.parse({ ...validRegister, isBusinessOwner: 'false' }).isBusinessOwner).toBe(false);
  });

  it('treats city as optional', () => {
    const { city: _omit, ...withoutCity } = validRegister;
    void _omit;
    expect(() => registerSchema.parse(withoutCity)).not.toThrow();
  });

  it('requires the yes/no questions (undefined is not silently false)', () => {
    const { ownsVehicle: _o, ...noVehicle } = validRegister;
    void _o;
    expect(() => registerSchema.parse(noVehicle)).toThrow();
    const { isBusinessOwner: _b, ...noBiz } = validRegister;
    void _b;
    expect(() => registerSchema.parse(noBiz)).toThrow();
  });

  it('rejects an empty first name', () => {
    expect(() =>
      registerSchema.parse({ ...validRegister, firstName: '' }),
    ).toThrow();
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Ada@Example.COM ')).toBe('ada@example.com');
    expect(normalizeEmail('already@lower.com')).toBe('already@lower.com');
  });
});

describe('adminLoginSchema', () => {
  it('accepts an email and password, normalizing the email', () => {
    const parsed = adminLoginSchema.parse({
      email: '  Ada@Example.COM ',
      password: 'hunter2',
    });
    expect(parsed.email).toBe('ada@example.com');
    expect(parsed.password).toBe('hunter2');
  });

  it('requires a valid email', () => {
    expect(() =>
      adminLoginSchema.parse({ email: 'not-an-email', password: 'x' }),
    ).toThrow();
    expect(() => adminLoginSchema.parse({ email: '', password: 'x' })).toThrow();
  });

  it('requires a non-empty password', () => {
    expect(() =>
      adminLoginSchema.parse({ email: 'a@b.com', password: '' }),
    ).toThrow();
  });

  it('does NOT impose a minimum length on login', () => {
    // Length policy belongs on account creation; an existing account must stay
    // able to sign in if the policy is tightened later.
    expect(
      adminLoginSchema.parse({ email: 'a@b.com', password: 'short' }).password,
    ).toBe('short');
  });

  it('strips unknown fields (no mass assignment)', () => {
    const parsed = adminLoginSchema.parse({
      email: 'a@b.com',
      password: 'x',
      role: 'ADMIN',
      status: 'ACTIVE',
    } as Record<string, unknown>);
    expect(parsed).toEqual({ email: 'a@b.com', password: 'x' });
  });
});

describe('adminBootstrapSchema', () => {
  const valid = {
    email: 'ada@example.com',
    displayName: 'Ada Lovelace',
    password: 'a-strong-password',
  };

  it('accepts a valid admin', () => {
    expect(adminBootstrapSchema.parse(valid).displayName).toBe('Ada Lovelace');
  });

  it('enforces the minimum password length', () => {
    expect(ADMIN_PASSWORD_MIN_LENGTH).toBe(12);
    expect(() =>
      adminBootstrapSchema.parse({ ...valid, password: 'a'.repeat(11) }),
    ).toThrow();
    expect(
      adminBootstrapSchema.parse({ ...valid, password: 'a'.repeat(12) }).password,
    ).toHaveLength(12);
  });

  it('requires a non-empty display name', () => {
    expect(() => adminBootstrapSchema.parse({ ...valid, displayName: '  ' })).toThrow();
  });

  it('requires a valid email', () => {
    expect(() => adminBootstrapSchema.parse({ ...valid, email: 'nope' })).toThrow();
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

import { describe, expect, it } from 'vitest';
import {
  isAllowedFormId,
  JotformParseError,
  parseJotformPayload,
} from '../functions/_shared/jotform';

function makePayload(opts: {
  submissionID?: string;
  formID?: string;
  raw?: Record<string, unknown> | string | null;
}): FormData {
  const fd = new FormData();
  if (opts.submissionID !== undefined) fd.set('submissionID', opts.submissionID);
  if (opts.formID !== undefined) fd.set('formID', opts.formID);
  if (opts.raw !== undefined && opts.raw !== null) {
    fd.set(
      'rawRequest',
      typeof opts.raw === 'string' ? opts.raw : JSON.stringify(opts.raw),
    );
  }
  return fd;
}

const validRaw = {
  q3_name: 'Ana López',
  q4_email: 'ANA@example.com',
  q5_number: '+1 555 0000',
  q6_whatTypeOfInsuranceAreYouInterestedIn: 'Auto',
};

describe('parseJotformPayload', () => {
  it('parses a well-formed insurance submission', () => {
    const fd = makePayload({
      submissionID: '12345',
      formID: '261465857224059',
      raw: validRaw,
    });
    const out = parseJotformPayload(fd);
    expect(out.submissionId).toBe('12345');
    expect(out.formId).toBe('261465857224059');
    expect(out.data.email).toBe('ana@example.com');
    expect(out.data.insuranceType).toBe('AUTO');
    expect(out.data.nombre).toBe('Ana López');
    expect(out.data.telefono).toBe('+1 555 0000');
  });

  it('maps House / Auto / Life to schema enums', () => {
    for (const [label, expected] of [
      ['House', 'HOUSE'],
      ['Auto', 'AUTO'],
      ['Life', 'LIFE'],
      ['Casa', 'HOUSE'],
      ['Vida', 'LIFE'],
    ] as const) {
      const fd = makePayload({
        submissionID: '1',
        formID: '2',
        raw: { ...validRaw, q6_whatTypeOfInsuranceAreYouInterestedIn: label },
      });
      const out = parseJotformPayload(fd);
      expect(out.data.insuranceType).toBe(expected);
    }
  });

  it('honors a compound Phone field shape (object with full)', () => {
    const fd = makePayload({
      submissionID: '1',
      formID: '2',
      raw: { ...validRaw, q5_number: { full: '+1 555 1234' } },
    });
    const out = parseJotformPayload(fd);
    expect(out.data.telefono).toBe('+1 555 1234');
  });

  it('honors compound name field (first/last)', () => {
    const fd = makePayload({
      submissionID: '1',
      formID: '2',
      raw: { ...validRaw, q3_name: { first: 'Ana', last: 'López' } },
    });
    const out = parseJotformPayload(fd);
    expect(out.data.nombre).toBe('Ana López');
  });

  it('throws MISSING_SUBMISSION_ID when submissionID is absent', () => {
    const fd = makePayload({ formID: '2', raw: validRaw });
    expect(() => parseJotformPayload(fd)).toThrowError(JotformParseError);
  });

  it('throws BAD_RAW_REQUEST when rawRequest is not JSON', () => {
    const fd = makePayload({
      submissionID: '1',
      formID: '2',
      raw: 'not-json{{',
    });
    try {
      parseJotformPayload(fd);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JotformParseError);
      expect((err as JotformParseError).code).toBe('BAD_RAW_REQUEST');
    }
  });

  it('throws VALIDATION when a required field is missing', () => {
    const { q4_email: _omit, ...withoutEmail } = validRaw;
    void _omit;
    const fd = makePayload({
      submissionID: '1',
      formID: '2',
      raw: withoutEmail,
    });
    try {
      parseJotformPayload(fd);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JotformParseError);
      expect((err as JotformParseError).code).toBe('VALIDATION');
    }
  });

  it('throws VALIDATION when insurance type is unrecognized', () => {
    const fd = makePayload({
      submissionID: '1',
      formID: '2',
      raw: { ...validRaw, q6_whatTypeOfInsuranceAreYouInterestedIn: 'Travel' },
    });
    try {
      parseJotformPayload(fd);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(JotformParseError);
      expect((err as JotformParseError).code).toBe('VALIDATION');
    }
  });

  it('accepts field alias fallback (q5_phoneNumber instead of q5_number)', () => {
    const { q5_number: _drop, ...rest } = validRaw;
    void _drop;
    const fd = makePayload({
      submissionID: '1',
      formID: '2',
      raw: { ...rest, q5_phoneNumber: '+1 555 9999' },
    });
    const out = parseJotformPayload(fd);
    expect(out.data.telefono).toBe('+1 555 9999');
  });
});

describe('isAllowedFormId', () => {
  it('returns true when CSV is empty and requireConfigured is not set', () => {
    expect(isAllowedFormId('any', '')).toBe(true);
    expect(isAllowedFormId('any', undefined)).toBe(true);
  });
  it('returns false when CSV is empty and requireConfigured is true', () => {
    expect(isAllowedFormId('any', '', { requireConfigured: true })).toBe(false);
  });
  it('matches case-sensitive IDs in CSV', () => {
    expect(isAllowedFormId('abc', 'abc,def')).toBe(true);
    expect(isAllowedFormId('def', ' abc , def ')).toBe(true);
    expect(isAllowedFormId('ghi', 'abc,def')).toBe(false);
  });
});

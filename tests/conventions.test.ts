// @vitest-environment node
//
// Data conventions: instants, civil dates, timezones, ids, JSON and redaction.

import { describe, expect, it } from 'vitest';
import {
  assertCivilDate,
  assertIsoTimestamp,
  civilDateInTimeZone,
  compareCivilDates,
  isCivilDate,
  isIsoTimestamp,
  isoFromNow,
  normalizeStoredTimestamp,
  nowIso,
  parseStoredTimestamp,
} from '../functions/_shared/time';
import {
  DEFAULT_TIMEZONE,
  assertTimeZone,
  isValidTimeZone,
  offsetMinutesAt,
} from '../functions/_shared/timezone';
import { asUuid, isUuid, newId } from '../functions/_shared/ids';
import { parseJson, parseJsonOrNull, serializeJson } from '../functions/_shared/json';
import { REDACTED, maskEmail, redact, redactObject } from '../functions/_shared/redact';

describe('instants', () => {
  it('nowIso produces the canonical stored format', () => {
    const value = nowIso();
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(value).toHaveLength(24);
    expect(isIsoTimestamp(value)).toBe(true);
  });

  it('is fixed-width, so string order equals chronological order', () => {
    const earlier = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const later = new Date('2026-06-01T12:30:00.500Z').toISOString();
    expect(earlier < later).toBe(true);
    expect([later, earlier].sort()[0]).toBe(earlier);
  });

  it('isoFromNow offsets correctly', () => {
    const future = isoFromNow(60_000);
    expect(Date.parse(future) - Date.now()).toBeGreaterThan(50_000);
    expect(isIsoTimestamp(future)).toBe(true);
  });

  it('rejects non-canonical timestamps', () => {
    for (const bad of [
      '2026-01-01 10:00:00',
      '2026-01-01T10:00:00Z',
      '2026-01-01T10:00:00+02:00',
      '2026-01-01',
      '',
      'not-a-date',
      null,
      12345,
    ]) {
      expect(isIsoTimestamp(bad), String(bad)).toBe(false);
    }
  });

  it('assertIsoTimestamp throws on a naive SQLite value', () => {
    expect(() => assertIsoTimestamp('2026-01-01 10:00:00')).toThrow(/ISO-8601/);
    expect(assertIsoTimestamp('2026-01-01T10:00:00.000Z')).toBe(
      '2026-01-01T10:00:00.000Z',
    );
  });

  it('parseStoredTimestamp still reads legacy naive rows as UTC', () => {
    // Pre-0005 tables were written by datetime('now'): no T, no zone marker.
    expect(parseStoredTimestamp('2026-01-01 10:00:00')).toBe(
      Date.parse('2026-01-01T10:00:00Z'),
    );
    expect(parseStoredTimestamp('2026-01-01T10:00:00.000Z')).toBe(
      Date.parse('2026-01-01T10:00:00.000Z'),
    );
    expect(parseStoredTimestamp(null)).toBeNull();
    expect(parseStoredTimestamp('')).toBeNull();
    expect(parseStoredTimestamp('garbage')).toBeNull();
  });

  it('normalizeStoredTimestamp upgrades a legacy value to canonical form', () => {
    expect(normalizeStoredTimestamp('2026-01-01 10:00:00')).toBe(
      '2026-01-01T10:00:00.000Z',
    );
    expect(normalizeStoredTimestamp('nope')).toBeNull();
  });
});

describe('civil dates', () => {
  it('accepts real calendar days', () => {
    for (const value of ['2026-01-01', '2024-02-29', '1999-12-31', '2000-02-29']) {
      expect(isCivilDate(value), value).toBe(true);
    }
  });

  it('rejects dates that pass a regex but do not exist', () => {
    for (const value of [
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-01-32',
      '2026-01-00',
    ]) {
      expect(isCivilDate(value), value).toBe(false);
    }
  });

  it('rejects malformed shapes and non-strings', () => {
    for (const value of ['2026-1-1', '26-01-01', '2026/01/01', '', null, 20260101]) {
      expect(isCivilDate(value), String(value)).toBe(false);
    }
  });

  it('accepts a future date (a birth date may legitimately be validated later)', () => {
    expect(isCivilDate('2999-12-31')).toBe(true);
  });

  it('compares without dragging in a timezone', () => {
    expect(compareCivilDates('2026-01-01', '2026-01-02')).toBeLessThan(0);
    expect(compareCivilDates('2026-01-02', '2026-01-01')).toBeGreaterThan(0);
    expect(compareCivilDates('2026-01-01', '2026-01-01')).toBe(0);
  });

  it('assertCivilDate throws on an impossible date', () => {
    expect(() => assertCivilDate('2026-02-30')).toThrow(/calendar date/);
  });

  it('civilDateInTimeZone answers "what day is it there"', () => {
    // 03:30 UTC on the 2nd is still the 1st in New York.
    const instant = new Date('2026-01-02T03:30:00.000Z');
    expect(civilDateInTimeZone(instant, 'UTC')).toBe('2026-01-02');
    expect(civilDateInTimeZone(instant, 'America/New_York')).toBe('2026-01-01');
  });
});

describe('timezones', () => {
  it('defaults to the operating timezone', () => {
    expect(DEFAULT_TIMEZONE).toBe('America/New_York');
    expect(isValidTimeZone(DEFAULT_TIMEZONE)).toBe(true);
  });

  it('accepts valid IANA identifiers', () => {
    for (const zone of ['UTC', 'Europe/Madrid', 'America/Los_Angeles', 'Asia/Tokyo']) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
  });

  it('rejects invalid identifiers', () => {
    for (const zone of ['', 'Not/AZone', 'EST5EDT-nope', 'x'.repeat(100), null, 42]) {
      expect(isValidTimeZone(zone), String(zone)).toBe(false);
    }
    expect(() => assertTimeZone('Mars/Olympus')).toThrow(/IANA/);
  });

  it('computes a DST-aware offset at the given instant', () => {
    // New York is UTC-5 in January and UTC-4 in July.
    expect(offsetMinutesAt(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(offsetMinutesAt(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
  });
});

describe('ids', () => {
  it('newId produces unique UUID v4 values', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(isUuid(id)).toBe(true);
  });

  it('rejects non-UUID values', () => {
    for (const value of [
      '',
      'abc',
      '123e4567-e89b-12d3-a456-426614174000', // version 1
      '../../etc/passwd',
      "' OR 1=1--",
      null,
      42,
    ]) {
      expect(isUuid(value), String(value)).toBe(false);
      expect(asUuid(value)).toBeNull();
    }
  });

  it('asUuid normalizes case', () => {
    const id = newId().toUpperCase();
    expect(asUuid(id)).toBe(id.toLowerCase());
  });
});

describe('JSON storage', () => {
  it('serializes plain values', () => {
    for (const value of [null, 1, 'text', true, [1, 2], { a: { b: [1, 'x'] } }]) {
      const result = serializeJson(value);
      expect(result.ok, JSON.stringify(value)).toBe(true);
    }
  });

  it('refuses values JSON cannot represent losslessly', () => {
    for (const value of [
      undefined,
      () => 1,
      Symbol('x'),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      10n,
      new Map(),
      new Set(),
      new Date(),
      { nested: undefined },
      [() => 1],
    ]) {
      const result = serializeJson(value);
      expect(result.ok, String(String(value))).toBe(false);
    }
  });

  it('refuses a circular structure instead of throwing', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    const result = serializeJson(circular);
    expect(result).toEqual({ ok: false, reason: 'not_serializable' });
  });

  it('refuses oversized payloads', () => {
    const huge = { blob: 'x'.repeat(70_000) };
    expect(serializeJson(huge)).toEqual({ ok: false, reason: 'too_large' });
    expect(serializeJson({ small: 'ok' }, 4).ok).toBe(false);
  });

  it('parses valid stored JSON', () => {
    const result = parseJson('{"a":1,"b":[true,null]}');
    expect(result).toEqual({ ok: true, value: { a: 1, b: [true, null] } });
  });

  it('rejects corrupt, empty and truncated columns', () => {
    for (const raw of ['', '{', '{"a":', 'undefined', null, undefined]) {
      const result = parseJson(raw);
      expect(result.ok, String(raw)).toBe(false);
    }
  });

  it('strips prototype pollution payloads', () => {
    const hostile = '{"__proto__":{"polluted":true},"safe":1}';
    const result = parseJson(hostile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({ safe: 1 });
    // The global prototype must be untouched.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(result.value, '__proto__')).toBe(false);
  });

  it('strips nested constructor/prototype keys', () => {
    const hostile = '{"a":{"constructor":{"x":1},"prototype":{"y":2},"keep":3}}';
    const result = parseJson(hostile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ a: { keep: 3 } });
  });

  it('parseJsonOrNull degrades gracefully', () => {
    expect(parseJsonOrNull('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonOrNull('{broken')).toBeNull();
    expect(parseJsonOrNull(null)).toBeNull();
  });
});

describe('redaction', () => {
  it('redacts sensitive keys case-insensitively', () => {
    const input = {
      password: 'hunter2',
      Password: 'hunter2',
      passwordHash: 'pbkdf2...',
      password_hash: 'pbkdf2...',
      token: 'abc',
      token_hash: 'def',
      cookie: 'session=x',
      Authorization: 'Bearer x',
      api_key: 'k',
      secret: 's',
      keep: 'visible',
    };
    const output = redact(input) as Record<string, unknown>;

    for (const key of Object.keys(input)) {
      if (key === 'keep') continue;
      expect(output[key], key).toBe(REDACTED);
    }
    expect(output.keep).toBe('visible');
  });

  it('redacts recursively through nested objects and arrays', () => {
    const input = {
      users: [
        { name: 'ada', password: 'x' },
        { name: 'bob', nested: { deep: { token: 'y' } } },
      ],
    };
    const output = JSON.stringify(redact(input));
    expect(output).not.toContain('"x"');
    expect(output).not.toContain('"y"');
    expect(output).toContain('ada');
    expect(output).toContain(REDACTED);
  });

  it('removes raw IP keys but keeps the hash', () => {
    const output = redact({
      ip: '203.0.113.7',
      ip_address: '203.0.113.7',
      clientIp: '203.0.113.7',
      ip_hash: 'a'.repeat(64),
    }) as Record<string, unknown>;

    expect(output.ip).toBe(REDACTED);
    expect(output.ip_address).toBe(REDACTED);
    expect(output.clientIp).toBe(REDACTED);
    // The hash is the safe representation and must survive.
    expect(output.ip_hash).toBe('a'.repeat(64));
  });

  it('drops prototype pollution keys rather than redacting them', () => {
    const parsed = JSON.parse('{"__proto__":{"bad":1},"ok":2}');
    const output = redact(parsed) as Record<string, unknown>;
    expect(output.ok).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(false);
  });

  it('bounds recursion depth', () => {
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let i = 0; i < 40; i++) deep = { child: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).toContain(REDACTED);
  });

  it('produces values that are always serializable', () => {
    const output = redact({ fn: () => 1, sym: Symbol('s'), when: new Date(), n: NaN });
    expect(serializeJson(output).ok).toBe(true);
  });

  it('redactObject rejects non-objects', () => {
    expect(redactObject(null)).toBeNull();
    expect(redactObject('text')).toBeNull();
    expect(redactObject([1, 2])).toBeNull();
    expect(redactObject({ a: 1 })).toEqual({ a: 1 });
  });

  it('maskEmail keeps the domain but not the local part', () => {
    expect(maskEmail('ada@example.com')).toBe('a***@example.com');
    expect(maskEmail('  Bob.Smith@Corp.IO ')).toBe('B***@Corp.IO');
    expect(maskEmail('not-an-email')).toBe(REDACTED);
    expect(maskEmail('@nolocal.com')).toBe(REDACTED);
  });
});

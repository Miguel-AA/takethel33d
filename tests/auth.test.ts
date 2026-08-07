import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearLegacyToken, hasLegacyToken } from '../src/lib/auth';
import { SESSION_TTL_MS, parseIso, timingSafeEqual } from '../functions/_shared/auth';
import { timingSafeEqualBytes } from '../functions/_shared/password';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('legacy token cleanup', () => {
  it('removes the bearer token the old implementation stored', () => {
    localStorage.setItem('gg.token', 'stale-token');
    localStorage.setItem('gg.token.expiresAt', new Date().toISOString());
    expect(hasLegacyToken()).toBe(true);

    clearLegacyToken();

    expect(hasLegacyToken()).toBe(false);
    expect(localStorage.getItem('gg.token')).toBeNull();
    expect(localStorage.getItem('gg.token.expiresAt')).toBeNull();
  });

  it('is a no-op when nothing is stored', () => {
    expect(() => clearLegacyToken()).not.toThrow();
    expect(hasLegacyToken()).toBe(false);
  });

  it('leaves unrelated keys alone', () => {
    localStorage.setItem('gg.locale', 'es');
    clearLegacyToken();
    expect(localStorage.getItem('gg.locale')).toBe('es');
  });

  it('no session credential is readable from the client', () => {
    // The session lives in an HttpOnly cookie: after cleanup there must be no
    // token-shaped value the page can read.
    clearLegacyToken();
    const keys = Object.keys(localStorage);
    expect(keys.filter((k) => k.includes('token'))).toHaveLength(0);
  });
});

describe('auth primitives', () => {
  it('exposes a single 12-hour session TTL', () => {
    expect(SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });

  it('timingSafeEqual compares strings correctly', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('timingSafeEqualBytes compares byte arrays correctly', () => {
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqualBytes(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqualBytes(new Uint8Array([1]), new Uint8Array([1, 2]))).toBe(false);
  });

  it('parseIso reads both ISO and legacy naive-UTC timestamps', () => {
    expect(parseIso('2026-01-01T10:00:00.000Z')).toBe(Date.parse('2026-01-01T10:00:00.000Z'));
    // Rows written by the older `datetime('now')` default carry no zone marker
    // and must still be read as UTC.
    expect(parseIso('2026-01-01 10:00:00')).toBe(Date.parse('2026-01-01T10:00:00Z'));
    expect(parseIso(null)).toBeNull();
    expect(parseIso('')).toBeNull();
    expect(parseIso('not-a-date')).toBeNull();
  });
});

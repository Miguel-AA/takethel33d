// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  HOST_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  buildClearedSessionCookies,
  buildSessionCookie,
  isSecureRequest,
  readCookie,
  readSessionCookie,
} from '../functions/_shared/cookies';

function withCookieHeader(value: string): Request {
  return new Request('https://example.com/', { headers: { Cookie: value } });
}

describe('cookie transport', () => {
  it('reads the session cookie', () => {
    expect(readSessionCookie(withCookieHeader(`${SESSION_COOKIE_NAME}=abc123`))).toBe(
      'abc123',
    );
  });

  it('finds the cookie among others, in any position', () => {
    expect(
      readSessionCookie(
        withCookieHeader(`other=1; ${SESSION_COOKIE_NAME}=wanted; last=2`),
      ),
    ).toBe('wanted');
    expect(
      readSessionCookie(withCookieHeader(`a=1; b=2; ${SESSION_COOKIE_NAME}=tail`)),
    ).toBe('tail');
  });

  it('returns null when absent, empty or malformed', () => {
    expect(readSessionCookie(new Request('https://example.com/'))).toBeNull();
    expect(readSessionCookie(withCookieHeader('other=1'))).toBeNull();
    expect(readSessionCookie(withCookieHeader(`${SESSION_COOKIE_NAME}=`))).toBeNull();
    expect(readSessionCookie(withCookieHeader('novalue'))).toBeNull();
  });

  it('does not match a cookie whose name merely contains the session name', () => {
    expect(
      readSessionCookie(withCookieHeader(`x_${SESSION_COOKIE_NAME}=nope`)),
    ).toBeNull();
  });

  it('percent-decodes values', () => {
    expect(readCookie(withCookieHeader('k=a%2Bb'), 'k')).toBe('a+b');
  });

  it('builds a hardened, __Host- prefixed cookie over HTTPS', () => {
    const cookie = buildSessionCookie('token-value', true);
    expect(cookie).toContain(`${HOST_SESSION_COOKIE_NAME}=token-value`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
    // __Host- is only honoured without a Domain attribute.
    expect(cookie).not.toContain('Domain=');
    // 12h TTL, expressed in seconds.
    expect(cookie).toContain('Max-Age=43200');
  });

  it('omits Secure and the __Host- prefix when not on HTTPS', () => {
    const cookie = buildSessionCookie('t', false);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=t`);
    expect(cookie).not.toContain('__Host-');
    expect(cookie).not.toContain('Secure');
  });

  it('clears both cookie names with Max-Age=0', () => {
    const cleared = buildClearedSessionCookies(true);
    expect(cleared).toHaveLength(2);
    const joined = cleared.join(' | ');
    expect(joined).toContain(`${HOST_SESSION_COOKIE_NAME}=;`);
    expect(joined).toContain(`${SESSION_COOKIE_NAME}=;`);
    for (const cookie of cleared) {
      expect(cookie).toContain('Max-Age=0');
      expect(cookie).toContain('HttpOnly');
    }
    // The __Host- variant must always carry Secure, even when clearing.
    expect(cleared[0]).toContain('Secure');
  });

  it('round-trips a token that needs encoding', () => {
    const token = 'a+b/c=d';
    const cookie = buildSessionCookie(token, true);
    const value = new RegExp(`${HOST_SESSION_COOKIE_NAME}=([^;]*)`).exec(cookie)?.[1] ?? '';
    expect(
      readSessionCookie(withCookieHeader(`${HOST_SESSION_COOKIE_NAME}=${value}`)),
    ).toBe(token);
  });

  it('detects HTTPS vs HTTP', () => {
    expect(isSecureRequest(new Request('https://example.com/'))).toBe(true);
    expect(isSecureRequest(new Request('http://localhost:8788/'))).toBe(false);
  });
});

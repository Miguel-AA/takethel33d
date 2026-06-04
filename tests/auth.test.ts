import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearToken, getToken, isAuthenticated, setToken } from '../src/lib/auth';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('auth token storage', () => {
  it('stores and retrieves a token', () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    setToken('abc123', expiresAt);
    expect(getToken()).toBe('abc123');
    expect(isAuthenticated()).toBe(true);
  });

  it('clears expired tokens on read', () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    setToken('stale', expired);
    expect(getToken()).toBeNull();
    expect(localStorage.getItem('gg.token')).toBeNull();
  });

  it('clearToken removes the token', () => {
    setToken('x', new Date(Date.now() + 60_000).toISOString());
    clearToken();
    expect(getToken()).toBeNull();
    expect(isAuthenticated()).toBe(false);
  });
});

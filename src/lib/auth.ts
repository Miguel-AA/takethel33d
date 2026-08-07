// Client-side session helpers.
//
// The admin session now lives in an HttpOnly cookie, which JavaScript cannot
// read by design. There is therefore NO client-side "do I have a token?" check
// any more: the only way to know whether a session is valid is to ask the
// server (`GET /api/manager/me`, see `useSession`).
//
// What remains here is the cleanup of the credentials the previous
// implementation left in localStorage.

const LEGACY_TOKEN_KEY = 'gg.token';
const LEGACY_TOKEN_EXPIRY_KEY = 'gg.token.expiresAt';

/**
 * Removes the bearer token stored by the pre-cookie implementation.
 *
 * Those tokens are already useless — migration 0005 dropped `manager_sessions`,
 * so nothing can validate them — but leaving a credential-shaped value in
 * localStorage is exactly the exposure the cookie migration set out to remove.
 * Called once on app start.
 */
export function clearLegacyToken(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_EXPIRY_KEY);
  } catch {
    // Storage can be unavailable (private mode, disabled cookies). Nothing
    // depends on this succeeding.
  }
}

/** True when a legacy token is still present. Exposed for tests. */
export function hasLegacyToken(): boolean {
  try {
    return localStorage.getItem(LEGACY_TOKEN_KEY) !== null;
  } catch {
    return false;
  }
}

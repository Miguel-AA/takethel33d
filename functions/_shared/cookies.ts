// Session cookie transport.
//
// The session token travels in an HttpOnly cookie, NOT in a JS-readable store.
// Consequences, by design:
//   * `document.cookie` cannot read it, so an XSS payload cannot exfiltrate the
//     session the way it could with `localStorage`.
//   * The SPA never sees the token. "Am I logged in?" is answered exclusively
//     by `GET /api/manager/me`.
//
// Cookie name: over HTTPS the `__Host-` prefix is used. Browsers only accept a
// `__Host-` cookie when it is `Secure`, `Path=/` and carries NO `Domain`, and
// crucially they refuse to let a SIBLING SUBDOMAIN set one. That closes
// "cookie tossing" session fixation, where evil.example.com writes a cookie for
// .example.com and the app silently adopts the attacker's session. `__Host-`
// requires `Secure`, which browsers reject over plain HTTP, so local
// development (`wrangler pages dev` on http://localhost) falls back to the
// unprefixed name.
//
// CSRF: the cookie is `SameSite=Lax`, so browsers withhold it from cross-site
// POST/PUT/DELETE requests — which covers every state-changing admin endpoint.
// Top-level GET navigations still send it, which is harmless because no GET
// endpoint mutates state. State-changing endpoints additionally require a JSON
// content type (see `requireJsonRequest`), which a cross-origin HTML form
// cannot produce.

import { SESSION_TTL_SECONDS } from './auth';

export const SESSION_COOKIE_NAME = 'l33d_admin_session';
export const HOST_SESSION_COOKIE_NAME = `__Host-${SESSION_COOKIE_NAME}`;

/** Every value present for `name` in the request's Cookie header. */
function readCookieValues(request: Request, name: string): string[] {
  const header = request.headers.get('Cookie');
  if (!header) return [];

  const values: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    const raw = part.slice(separator + 1).trim();
    if (raw.length === 0) continue;
    try {
      values.push(decodeURIComponent(raw));
    } catch {
      values.push(raw);
    }
  }
  return values;
}

/**
 * Reads a single cookie value.
 *
 * Returns null when the name appears MORE THAN ONCE. Two values for one name
 * means something other than this app wrote one of them (different Domain or
 * Path scope), and silently picking either could hand the user an attacker's
 * session. Refusing is the safe failure mode: the request is simply
 * unauthenticated.
 */
export function readCookie(request: Request, name: string): string | null {
  const values = readCookieValues(request, name);
  if (values.length !== 1) return null;
  return values[0];
}

/**
 * Resolves the session token, preferring the `__Host-` cookie.
 *
 * If a `__Host-` cookie is present but unusable (duplicated), the unprefixed
 * name is NOT consulted — otherwise an attacker could force a downgrade to the
 * spoofable name simply by injecting a duplicate.
 */
export function readSessionCookie(request: Request): string | null {
  const hostScoped = readCookieValues(request, HOST_SESSION_COOKIE_NAME);
  if (hostScoped.length > 0) {
    return hostScoped.length === 1 ? hostScoped[0] : null;
  }
  return readCookie(request, SESSION_COOKIE_NAME);
}

/**
 * `Secure` is only set on HTTPS. `wrangler pages dev` serves plain HTTP on
 * localhost, and browsers drop `Secure` cookies over HTTP — omitting it there
 * is what keeps local development working. Every deployed environment is HTTPS.
 */
export function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

/** Cookie name appropriate for the transport in use. */
export function sessionCookieNameFor(secure: boolean): string {
  return secure ? HOST_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
}

function serialize(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = [
    `${name}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  // A `__Host-` cookie is invalid without Secure, so it always carries it.
  if (secure || name.startsWith('__Host-')) attributes.push('Secure');
  return attributes.join('; ');
}

/** Set-Cookie value that installs a session token. */
export function buildSessionCookie(token: string, secure: boolean): string {
  return serialize(
    sessionCookieNameFor(secure),
    encodeURIComponent(token),
    SESSION_TTL_SECONDS,
    secure,
  );
}

/**
 * Set-Cookie values that remove the session.
 *
 * BOTH names are cleared: a client may hold the unprefixed cookie from an
 * earlier deploy or from local development, and leaving it behind would keep a
 * revoked-looking credential in the jar.
 */
export function buildClearedSessionCookies(secure: boolean): string[] {
  return [
    serialize(HOST_SESSION_COOKIE_NAME, '', 0, true),
    serialize(SESSION_COOKIE_NAME, '', 0, secure),
  ];
}

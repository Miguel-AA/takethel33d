// Route matching for the authentication middleware.
//
// The guard MUST NOT assume the router and the guard normalise a URL the same
// way. If the router resolves `/api/%61ttendees` or `//api/attendees` to the
// attendees function while the guard compares the raw path, the request slips
// past authentication entirely. So the guard normalises the path itself and
// matches on the result.

/** Protected route roots, already normalised (lowercase, no trailing slash). */
export const PROTECTED_ROUTES = [
  '/api/manager/me',
  '/api/manager/logout',
  '/api/attendees',
  '/api/metrics',
  '/api/raffle',
  // The audit trail is administrator-only; there is no public read path.
  '/api/audit',
  // Event administration. NOTE: this protects the API namespace only — the
  // legacy public page at `/events` (lead capture) is a SPA route, not an API
  // path, and is unaffected.
  '/api/events',
];

/**
 * Canonicalises a pathname for comparison:
 *   1. percent-decoding (repeated, to defeat double-encoding),
 *   2. `.`/`..` segment resolution,
 *   3. collapsing of duplicate slashes,
 *   4. removal of any trailing slash,
 *   5. lowercasing.
 *
 * Normalising toward MORE matches is the safe direction: an over-matched path
 * yields 401 instead of 404, while an under-matched one yields unauthenticated
 * access.
 */
export function normalizePathname(rawPathname: string): string {
  let decoded = rawPathname;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      break; // malformed escape: keep what we have rather than throwing
    }
    if (next === decoded) break;
    decoded = next;
  }

  // Backslashes are treated as separators by some proxies and filesystems.
  const unified = decoded.replace(/\\/g, '/');

  const resolved: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return `/${resolved.join('/')}`.toLowerCase();
}

/** True when the (normalised) path belongs to a protected route. */
export function isProtectedPath(rawPathname: string): boolean {
  const path = normalizePathname(rawPathname);
  return PROTECTED_ROUTES.some(
    (route) => path === route || path.startsWith(`${route}/`),
  );
}

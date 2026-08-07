// Slug rules for public event addresses.
//
// SHARED so the create form can preview exactly the slug the server will store,
// and so the reserved-name list has ONE definition. A list duplicated between
// UI and backend is a list that drifts, and the drift shows up as an event
// whose public URL shadows `/manager` or `/api`.

/** Lowercase ASCII letters, digits and single hyphens; no leading/trailing hyphen. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A single character is a valid address. A longer minimum would reject a
 * legitimate short name — an event called "Q1" has to be able to generate a
 * slug rather than failing with "invalid slug". Reserved words, not length,
 * are the real hazard, and those are checked separately.
 */
export const SLUG_MIN_LENGTH = 1;
export const SLUG_MAX_LENGTH = 80;

/**
 * Slugs an event may never take.
 *
 * These are application routes (or route prefixes). An event reachable at
 * `/api` or `/manager` would shadow real functionality, and one at `..` or
 * `admin` invites confusion at best. The check is by exact match after
 * normalisation — the pattern above already rules out `../../admin`, since
 * dots and slashes are not valid slug characters at all.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'api',
  'manager',
  'admin',
  'events',
  'event',
  'login',
  'logout',
  'audit',
  'confirmacion',
  'confirmation',
  'landing',
  'register',
  'attendees',
  'metrics',
  'raffle',
  'new',
  'edit',
  'about-us',
  'benefits',
  'contact',
  'how-it-works',
  'industries',
  'pricing',
]);

/**
 * Derives a slug candidate from free text.
 *
 * Accents are folded to ASCII first (`Ñandú` -> `nandu`) so a Spanish event
 * name yields a usable address instead of collapsing to hyphens.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFD')
    // Strip combining marks left behind by the decomposition.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    // Slicing can leave a trailing hyphen behind.
    .replace(/-+$/g, '');
}

export function isValidSlug(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= SLUG_MIN_LENGTH &&
    value.length <= SLUG_MAX_LENGTH &&
    SLUG_PATTERN.test(value)
  );
}

export function isReservedSlug(value: string): boolean {
  return RESERVED_SLUGS.has(value.toLowerCase());
}

export type SlugCheck =
  | { ok: true; slug: string }
  | { ok: false; reason: 'invalid' | 'reserved' };

/** Validates a slug for storage. */
export function checkSlug(value: unknown): SlugCheck {
  if (!isValidSlug(value)) return { ok: false, reason: 'invalid' };
  if (isReservedSlug(value)) return { ok: false, reason: 'reserved' };
  return { ok: true, slug: value };
}

/**
 * Appends a numeric suffix to produce a distinct candidate.
 *
 * Used when a generated slug collides: `summer-giveaway` -> `summer-giveaway-2`.
 * An explicitly supplied slug is never silently altered — that returns a typed
 * conflict instead, because the address is the operator's decision.
 */
export function withSuffix(slug: string, attempt: number): string {
  const suffix = `-${attempt}`;
  const room = SLUG_MAX_LENGTH - suffix.length;
  return `${slug.slice(0, room).replace(/-+$/g, '')}${suffix}`;
}

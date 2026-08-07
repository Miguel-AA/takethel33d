// Identifier convention: UUID v4, canonical hyphenated lowercase form.
//
// Centralised so `crypto.randomUUID()` is not sprinkled across every service,
// and so validation of an incoming id has exactly one definition.
//
// Legacy identifiers are NOT migrated; `attendees.id` already holds UUIDs
// generated the same way.

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Generates a new identifier for any new row. */
export function newId(): string {
  return crypto.randomUUID();
}

/** True when the value is a canonical UUID v4. */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * Narrows an untrusted identifier, returning null when it is not a UUID.
 *
 * Filters and path parameters use this so a hostile id is rejected before it
 * ever reaches a query, rather than being bound as a harmless-but-pointless
 * string.
 */
export function asUuid(value: unknown): string | null {
  return isUuid(value) ? value.toLowerCase() : null;
}

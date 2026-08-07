// Central redaction policy for anything written to the audit log or the logger.
//
// The design rule: a caller must NOT have to remember to strip secrets. Every
// value bound for durable storage passes through here, so forgetting is not a
// failure mode. A snapshot of an admin row, for instance, naturally carries
// `password_hash`; redaction is what keeps that out of a table administrators
// can read through the API.

import type { JsonValue } from './json';

export const REDACTED = '[REDACTED]';

/**
 * Key fragments that mark a value as sensitive. Matching is case-insensitive
 * and by SUBSTRING, so `passwordHash`, `password_hash`, `PASSWORD` and
 * `newPassword` are all caught by the single entry `password`.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  'password',
  'token',
  'secret',
  'cookie',
  'authorization',
  'authheader',
  'apikey',
  'credential',
  'privatekey',
  'salt',
  'signature',
];

/**
 * Keys redacted only on an EXACT match.
 *
 * These names are ambiguous: `session` may well hold the credential itself, but
 * `sessionId` is an opaque row identifier that the audit trail needs in order
 * to point at a specific session — redacting it would destroy legitimate
 * evidence. Likewise `ip` is the raw address while `ip_hash` is the safe
 * representation that must survive.
 */
const EXACT_SENSITIVE_KEYS = new Set([
  'session',
  'auth',
  'ip',
  'ipaddress',
  'clientip',
  'remoteaddr',
  'remoteaddress',
]);

/** Depth ceiling: a deeply nested payload must not blow the stack. */
const MAX_DEPTH = 12;

/**
 * Collapses a key to letters and digits before matching.
 *
 * Without this, `api_key` and `apiKey` would be caught while `x-api-key` and
 * `API KEY` slipped through, purely because of the separator used.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (EXACT_SENSITIVE_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Reads an object's own enumerable properties without letting a hostile or
 * broken getter abort the walk.
 *
 * `Object.entries` invokes every getter; one that throws would propagate and
 * lose the ENTIRE audit entry. `Object.keys` does not invoke them, so each
 * value is fetched individually and a failure degrades to a marker.
 */
function safeEntries(value: object): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return entries;
  }

  for (const key of keys) {
    try {
      entries.push([key, (value as Record<string, unknown>)[key]]);
    } catch {
      entries.push([key, UNREADABLE]);
    }
  }
  return entries;
}

/** Marker for a property whose getter threw. */
export const UNREADABLE = '[UNREADABLE]';

/**
 * Recursively replaces sensitive values with `[REDACTED]`.
 *
 * Walks objects AND arrays — a secret hiding at `users[3].password` is just as
 * damaging as one at the top level. Non-JSON values are dropped rather than
 * coerced, so nothing unrepresentable slips into storage.
 */
export function redact(value: unknown, depth = 0): JsonValue {
  if (depth > MAX_DEPTH) return REDACTED;

  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return value.toString();
    case 'undefined':
    case 'function':
    case 'symbol':
      return null;
    default:
      break;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of safeEntries(value)) {
      // Pollution vectors are dropped outright, not redacted.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      output[key] = isSensitiveKey(key) ? REDACTED : redact(entry, depth + 1);
    }
    return output;
  }

  return null;
}

/**
 * Redacts a value that must end up as a JSON object (or null).
 * Anything else — a bare string, an array — is rejected as metadata.
 */
export function redactObject(
  value: unknown,
): Record<string, JsonValue> | null {
  if (value === null || value === undefined) return null;
  const redacted = redact(value);
  if (typeof redacted !== 'object' || redacted === null || Array.isArray(redacted)) {
    return null;
  }
  return redacted as Record<string, JsonValue>;
}

/**
 * Masks an email for storage: `ada@example.com` -> `a***@example.com`.
 *
 * Used on the failed-login path, where the address is attacker-supplied and
 * may not belong to any account. Keeping the domain preserves the operational
 * signal ("someone is spraying our corporate domain") while the local part
 * stays unusable for harvesting.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return REDACTED;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const head = local.slice(0, 1);
  return `${head}***@${domain}`;
}

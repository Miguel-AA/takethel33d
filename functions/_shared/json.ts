// Safe handling of JSON that is persisted in D1.
//
// D1 has no JSON column type, so structured values are stored as TEXT. That
// makes every read a parse of untrusted-by-default input: the row may have been
// written by an older version, truncated, or hand-edited. Nothing in the
// codebase may call `JSON.parse()` on a stored column directly — it goes
// through `parseJson`, which validates shape and strips pollution vectors.

import { JSON_COLUMN_MAX_BYTES } from '../../shared/limits';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];

/** Keys that must never survive a parse — they are prototype-pollution vectors. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type JsonFailureReason =
  | 'not_serializable'
  | 'too_large'
  | 'invalid_json'
  | 'forbidden_key'
  | 'not_an_object';

export type SerializeResult =
  | { ok: true; json: string }
  | { ok: false; reason: JsonFailureReason };

export type ParseResult<T = JsonValue> =
  | { ok: true; value: T }
  | { ok: false; reason: JsonFailureReason };

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * True for values JSON can represent losslessly.
 *
 * `undefined`, functions and symbols are silently DROPPED by
 * `JSON.stringify` (or turn into `null` inside arrays), and `NaN`/`Infinity`
 * become `null`. Detecting them up front means a caller learns their payload
 * was unrepresentable instead of quietly persisting a hole.
 */
/**
 * Depth ceiling for the serializability walk.
 *
 * Without it, a payload nested thousands of levels deep overflows the stack
 * before any size check can reject it — the recursion itself is the attack.
 */
const MAX_SERIALIZE_DEPTH = 64;

function isSerializable(value: unknown, seen: Set<object>, depth = 0): boolean {
  if (depth > MAX_SERIALIZE_DEPTH) return false;
  if (value === null) return true;

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true;
    case 'number':
      return Number.isFinite(value);
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      return false;
    case 'object':
      break;
    default:
      return false;
  }

  const asObject = value as object;
  if (seen.has(asObject)) return false; // circular
  seen.add(asObject);

  try {
    if (Array.isArray(value)) {
      return value.every((entry) => isSerializable(entry, seen, depth + 1));
    }
    // Dates, Maps, Sets and class instances are not plain JSON data; requiring
    // a plain object keeps stored shapes predictable.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;

    return Object.entries(value as Record<string, unknown>).every(
      ([key, entry]) => !FORBIDDEN_KEYS.has(key) && isSerializable(entry, seen, depth + 1),
    );
  } catch {
    // A throwing getter makes the value unrepresentable, not fatal.
    return false;
  } finally {
    seen.delete(asObject);
  }
}

/** Serializes a value for storage, refusing anything unrepresentable or oversized. */
export function serializeJson(
  value: unknown,
  maxBytes = JSON_COLUMN_MAX_BYTES,
): SerializeResult {
  if (!isSerializable(value, new Set())) {
    return { ok: false, reason: 'not_serializable' };
  }

  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return { ok: false, reason: 'not_serializable' };
  }
  if (typeof json !== 'string') return { ok: false, reason: 'not_serializable' };
  if (byteLength(json) > maxBytes) return { ok: false, reason: 'too_large' };

  return { ok: true, json };
}

/**
 * Reviver that drops pollution keys.
 *
 * Returning `undefined` from a reviver removes the property, so a payload
 * carrying `__proto__` cannot reach the resulting object graph at all.
 */
function safeReviver(key: string, value: unknown): unknown {
  if (FORBIDDEN_KEYS.has(key)) return undefined;
  return value;
}

/**
 * Parses a stored JSON column.
 *
 * `validate` is an optional narrowing predicate — repositories pass one so a
 * column that no longer matches its expected shape is reported as invalid
 * rather than flowing onward as `any`.
 */
export function parseJson<T = JsonValue>(
  raw: string | null | undefined,
  options: {
    maxBytes?: number;
    validate?: (value: JsonValue) => value is Extract<T, JsonValue>;
  } = {},
): ParseResult<T> {
  if (raw === null || raw === undefined || raw === '') {
    return { ok: false, reason: 'invalid_json' };
  }
  if (byteLength(raw) > (options.maxBytes ?? JSON_COLUMN_MAX_BYTES)) {
    return { ok: false, reason: 'too_large' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, safeReviver);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  // A top-level `{"__proto__": ...}` is stripped by the reviver, but assert the
  // result is genuinely prototype-clean before handing it out.
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.getPrototypeOf(parsed) !== Object.prototype
  ) {
    return { ok: false, reason: 'forbidden_key' };
  }

  const value = parsed as JsonValue;
  if (options.validate && !options.validate(value)) {
    return { ok: false, reason: 'not_an_object' };
  }

  return { ok: true, value: value as T };
}

/** Convenience guard for columns that must hold a JSON object. */
export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a stored column, returning null instead of an error.
 *
 * Used when a corrupt column must degrade gracefully (an audit row still
 * renders, just without its metadata) rather than failing the whole request.
 */
export function parseJsonOrNull(raw: string | null | undefined): JsonValue | null {
  const result = parseJson(raw);
  return result.ok ? result.value : null;
}

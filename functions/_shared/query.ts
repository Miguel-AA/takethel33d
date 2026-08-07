// Shared parsing of URL query parameters.
//
// Centralised so every listing endpoint bounds pagination the same way and so
// no endpoint can be talked into sorting by an arbitrary column — the sort key
// is always chosen from an allowlist, never interpolated from user input.

import { asUuid } from './ids';
import { isCivilDate, isIsoTimestamp } from './time';
import {
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PAGE_SIZE_MIN,
  SEARCH_MAX_LENGTH,
} from '../../shared/limits';

export interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

/**
 * Parses `page` / `pageSize`, clamping both.
 *
 * Clamping rather than rejecting keeps a mistyped URL usable, while the hard
 * `PAGE_SIZE_MAX` stops `?pageSize=1000000` from turning a listing endpoint
 * into a denial-of-service lever.
 */
export function parsePagination(
  params: URLSearchParams,
  defaultPageSize = PAGE_SIZE_DEFAULT,
): Pagination {
  const rawPage = Number(params.get('page') ?? '1');
  const page =
    Number.isFinite(rawPage) && rawPage >= 1 ? Math.floor(rawPage) : 1;

  const rawSize = Number(params.get('pageSize') ?? String(defaultPageSize));
  const pageSize = Number.isFinite(rawSize)
    ? Math.min(PAGE_SIZE_MAX, Math.max(PAGE_SIZE_MIN, Math.floor(rawSize)))
    : defaultPageSize;

  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Trimmed, length-bounded free-text search, or null when absent/empty. */
export function parseSearch(params: URLSearchParams, key = 'search'): string | null {
  const raw = params.get(key);
  if (raw === null) return null;
  const trimmed = raw.trim().slice(0, SEARCH_MAX_LENGTH);
  return trimmed.length === 0 ? null : trimmed;
}

/** A UUID filter, or null when absent. Returns `invalid` when malformed. */
export function parseUuidParam(
  params: URLSearchParams,
  key: string,
): { ok: true; value: string | null } | { ok: false } {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return { ok: true, value: null };
  const uuid = asUuid(raw.trim());
  return uuid ? { ok: true, value: uuid } : { ok: false };
}

/** A value constrained to an allowlist. */
export function parseEnumParam<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: readonly T[],
): { ok: true; value: T | null } | { ok: false } {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return { ok: true, value: null };
  const candidate = raw.trim() as T;
  return allowed.includes(candidate) ? { ok: true, value: candidate } : { ok: false };
}

/**
 * A date-range bound.
 *
 * Accepts either a full ISO instant or a civil date. A civil date is widened to
 * cover the whole day — `from=2026-01-01` means "from the start of that day",
 * `to=2026-01-01` means "through the end of it" — which is what a person
 * filling in a date filter means.
 */
export function parseDateBound(
  params: URLSearchParams,
  key: string,
  edge: 'start' | 'end',
): { ok: true; value: string | null } | { ok: false } {
  const raw = params.get(key);
  if (raw === null || raw.trim() === '') return { ok: true, value: null };

  const trimmed = raw.trim();
  if (isIsoTimestamp(trimmed)) return { ok: true, value: trimmed };
  if (isCivilDate(trimmed)) {
    return {
      ok: true,
      value: edge === 'start' ? `${trimmed}T00:00:00.000Z` : `${trimmed}T23:59:59.999Z`,
    };
  }
  return { ok: false };
}

/**
 * Resolves a sort key against an allowlist and returns the literal SQL
 * fragment mapped to it.
 *
 * Callers never interpolate a client string into SQL: they look one up here,
 * and an unknown key falls back to the default.
 */
export function parseSortKey<T extends string>(
  params: URLSearchParams,
  allowed: Record<T, string>,
  fallback: T,
  key = 'sort',
): { sortKey: T; column: string } {
  const raw = (params.get(key) ?? '').trim() as T;
  const chosen = Object.prototype.hasOwnProperty.call(allowed, raw) ? raw : fallback;
  return { sortKey: chosen, column: allowed[chosen] };
}

/** `asc` / `desc`, defaulting to descending (newest first). */
export function parseSortDirection(
  params: URLSearchParams,
  key = 'direction',
): 'ASC' | 'DESC' {
  return (params.get(key) ?? '').trim().toLowerCase() === 'asc' ? 'ASC' : 'DESC';
}

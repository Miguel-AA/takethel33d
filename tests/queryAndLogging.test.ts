// @vitest-environment node
//
// Shared query parsing and the structured logger.

import { afterEach, describe, expect, it } from 'vitest';
import {
  parseDateBound,
  parseEnumParam,
  parsePagination,
  parseSearch,
  parseSortDirection,
  parseSortKey,
  parseUuidParam,
} from '../functions/_shared/query';
import { describeError, logger, setLogSink } from '../functions/_shared/logger';
import { newId } from '../functions/_shared/ids';

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

afterEach(() => {
  setLogSink(null);
});

describe('parsePagination', () => {
  it('applies defaults', () => {
    expect(parsePagination(params(''))).toEqual({ page: 1, pageSize: 25, offset: 0 });
  });

  it('computes the offset', () => {
    expect(parsePagination(params('page=3&pageSize=10'))).toEqual({
      page: 3,
      pageSize: 10,
      offset: 20,
    });
  });

  it('clamps an abusive pageSize instead of trusting it', () => {
    expect(parsePagination(params('pageSize=1000000')).pageSize).toBe(200);
    expect(parsePagination(params('pageSize=0')).pageSize).toBe(1);
    expect(parsePagination(params('pageSize=-5')).pageSize).toBe(1);
  });

  it('falls back for nonsense values', () => {
    for (const query of ['page=abc', 'page=-1', 'page=0', 'page=NaN']) {
      expect(parsePagination(params(query)).page, query).toBe(1);
    }
    expect(parsePagination(params('pageSize=abc')).pageSize).toBe(25);
  });

  it('floors fractional input', () => {
    expect(parsePagination(params('page=2.9&pageSize=10.7'))).toMatchObject({
      page: 2,
      pageSize: 10,
    });
  });
});

describe('parseSearch', () => {
  it('trims and bounds', () => {
    expect(parseSearch(params('search=  ada  '))).toBe('ada');
    expect(parseSearch(params(`search=${'x'.repeat(500)}`))).toHaveLength(120);
  });

  it('returns null when absent or blank', () => {
    expect(parseSearch(params(''))).toBeNull();
    expect(parseSearch(params('search='))).toBeNull();
    expect(parseSearch(params('search=   '))).toBeNull();
  });
});

describe('parseUuidParam', () => {
  it('accepts a UUID and reports absence as null', () => {
    const id = newId();
    expect(parseUuidParam(params(`actorAdminId=${id}`), 'actorAdminId')).toEqual({
      ok: true,
      value: id,
    });
    expect(parseUuidParam(params(''), 'actorAdminId')).toEqual({ ok: true, value: null });
  });

  it('rejects anything that is not a UUID', () => {
    for (const value of ['abc', "1' OR '1'='1", '../../etc', '12345']) {
      expect(parseUuidParam(params(`id=${encodeURIComponent(value)}`), 'id').ok).toBe(false);
    }
  });
});

describe('parseEnumParam', () => {
  const allowed = ['A', 'B'] as const;

  it('accepts allowlisted values', () => {
    expect(parseEnumParam(params('k=A'), 'k', allowed)).toEqual({ ok: true, value: 'A' });
    expect(parseEnumParam(params(''), 'k', allowed)).toEqual({ ok: true, value: null });
  });

  it('rejects anything outside the allowlist', () => {
    expect(parseEnumParam(params('k=C'), 'k', allowed).ok).toBe(false);
    expect(parseEnumParam(params('k=a'), 'k', allowed).ok).toBe(false);
  });
});

describe('parseDateBound', () => {
  it('widens a civil date to cover the whole day', () => {
    expect(parseDateBound(params('from=2026-06-01'), 'from', 'start')).toEqual({
      ok: true,
      value: '2026-06-01T00:00:00.000Z',
    });
    expect(parseDateBound(params('to=2026-06-01'), 'to', 'end')).toEqual({
      ok: true,
      value: '2026-06-01T23:59:59.999Z',
    });
  });

  it('accepts a full ISO instant unchanged', () => {
    expect(parseDateBound(params('from=2026-06-01T10:30:00.000Z'), 'from', 'start')).toEqual({
      ok: true,
      value: '2026-06-01T10:30:00.000Z',
    });
  });

  it('rejects impossible and malformed dates', () => {
    for (const value of ['2026-02-30', '13/01/2026', 'yesterday', '2026-06-01T10:00:00Z']) {
      expect(
        parseDateBound(params(`from=${encodeURIComponent(value)}`), 'from', 'start').ok,
        value,
      ).toBe(false);
    }
  });

  it('treats absence as no bound', () => {
    expect(parseDateBound(params(''), 'from', 'start')).toEqual({ ok: true, value: null });
  });
});

describe('sorting', () => {
  const allowed = { newest: 'created_at', name: 'display_name' } as const;

  it('resolves an allowlisted key to its column', () => {
    expect(parseSortKey(params('sort=name'), allowed, 'newest')).toEqual({
      sortKey: 'name',
      column: 'display_name',
    });
  });

  it('never lets a client name an arbitrary column', () => {
    for (const value of ['password_hash', 'token_hash', '1; DROP TABLE x', '__proto__']) {
      const result = parseSortKey(
        params(`sort=${encodeURIComponent(value)}`),
        allowed,
        'newest',
      );
      // Anything unknown collapses to the default, so no client string can
      // reach SQL.
      expect(result.column, value).toBe('created_at');
    }
  });

  it('defaults to descending', () => {
    expect(parseSortDirection(params(''))).toBe('DESC');
    expect(parseSortDirection(params('direction=asc'))).toBe('ASC');
    expect(parseSortDirection(params('direction=ASC'))).toBe('ASC');
    expect(parseSortDirection(params('direction=sideways'))).toBe('DESC');
  });
});

describe('logger', () => {
  function capture(): string[] {
    const lines: string[] = [];
    setLogSink((_level, line) => lines.push(line));
    return lines;
  }

  it('emits structured JSON with level, time and message', () => {
    const lines = capture();
    logger.info('something happened', { requestId: 'req-1', action: 'TEST' });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('something happened');
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.action).toBe('TEST');
    expect(parsed.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('routes each level', () => {
    const lines = capture();
    logger.info('a');
    logger.warn('b');
    logger.error('c');
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level)).toEqual([
      'info',
      'warn',
      'error',
    ]);
  });

  it('redacts secrets in fields', () => {
    const lines = capture();
    logger.error('failure', {
      requestId: 'r',
      password: 'hunter2',
      // Distinctive values: a short one like "tok" would also appear inside
      // the surviving KEY name "token" and make the assertion meaningless.
      token: 'tok-secret-value',
      nested: { cookie: 'cookie-secret-value' },
      keep: 'visible',
    });

    expect(lines[0]).not.toContain('hunter2');
    expect(lines[0]).not.toContain('tok-secret-value');
    expect(lines[0]).not.toContain('cookie-secret-value');
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[0]).toContain('visible');
  });

  it('strips newlines so a message cannot forge a second entry', () => {
    const lines = capture();
    logger.warn('line one\n{"level":"error","message":"forged"}');

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as { message: string };
    expect(parsed.message).not.toContain('\n');
    expect(parsed.message).toContain('forged'); // present, but inert as text
  });

  it('truncates an overlong message', () => {
    const lines = capture();
    logger.info('x'.repeat(2000));
    expect((JSON.parse(lines[0]) as { message: string }).message).toHaveLength(500);
  });

  it('survives an unserializable field', () => {
    const lines = capture();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logger.error('bad', { circular })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });

  it('ignores non-object field payloads', () => {
    const lines = capture();
    logger.info('msg', 'not-an-object' as unknown as Record<string, unknown>);
    expect(() => JSON.parse(lines[0])).not.toThrow();
  });
});

describe('describeError', () => {
  it('summarises an Error without a stack trace', () => {
    const described = describeError(new TypeError('bad thing\nsecond line'));
    expect(described.errorName).toBe('TypeError');
    expect(described.errorMessage).toBe('bad thing second line');
    expect(JSON.stringify(described)).not.toContain('at ');
  });

  it('handles a non-Error throw', () => {
    expect(describeError('plain string')).toEqual({
      errorName: 'UnknownError',
      errorMessage: 'plain string',
    });
  });

  it('truncates a huge message', () => {
    expect(describeError(new Error('x'.repeat(1000))).errorMessage).toHaveLength(300);
  });
});

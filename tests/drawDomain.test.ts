// @vitest-environment node
//
// The arithmetic and the vocabulary of a draw, with no database in sight.
//
// These functions decide how many people can win, which prizes are on offer and
// what a candidate set serialises to. They are pure, so they are tested pure —
// and the properties below are the ones the backend, the mock and the
// confirmation dialog all rely on agreeing about.

import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_SET_HASH_VERSION,
  DRAW_ALGORITHM_VERSION,
  DRAW_FAILURE_CODES,
  EVENT_STATUS_ALLOWING_DRAW,
  canonicalCandidateSet,
  countPrizeUnits,
  eventAllowsDraw,
  expandPrizeUnits,
  hashCandidateSet,
  isDrawEligible,
  plannedWinnerCount,
  type ExpandablePrize,
} from '../shared/drawLifecycle';
import { EVENT_STATUSES } from '../shared/eventLifecycle';
import { EVENT_ENTRY_STATUSES } from '../shared/entryLifecycle';

const prize = (overrides: Partial<ExpandablePrize> = {}): ExpandablePrize => ({
  id: 'p1',
  name: 'Vape',
  description: null,
  quantity: 1,
  sortOrder: 0,
  status: 'ACTIVE',
  ...overrides,
});

// ---------------------------------------------------------------------------
describe('the state a draw may run from', () => {
  it('is DRAW_READY and nothing else', () => {
    const allowed = EVENT_STATUSES.filter(eventAllowsDraw);
    expect(allowed).toEqual(['DRAW_READY']);
    expect(EVENT_STATUS_ALLOWING_DRAW).toBe('DRAW_READY');
  });

  it('refuses CLOSED, which is the tempting mistake', () => {
    // `mark-draw-ready` is the operator's explicit declaration that the
    // population and the prizes are settled. Drawing from CLOSED would make
    // that declaration decorative.
    expect(eventAllowsDraw('CLOSED')).toBe(false);
  });

  it('refuses DRAW_COMPLETED, which is what a draw produces', () => {
    expect(eventAllowsDraw('DRAW_COMPLETED')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('who is in the running', () => {
  it('requires BOTH the status and the historical verdict', () => {
    expect(isDrawEligible({ status: 'ELIGIBLE', overallEligible: true })).toBe(true);
    // Disqualified after qualifying: the verdict still says yes, the
    // disposition says no, and the disposition wins.
    expect(isDrawEligible({ status: 'DISQUALIFIED', overallEligible: true })).toBe(false);
    // A corrupted row claiming ELIGIBLE without the verdict is not admitted on
    // the strength of its status alone.
    expect(isDrawEligible({ status: 'ELIGIBLE', overallEligible: false })).toBe(false);
    expect(isDrawEligible({ status: 'ELIGIBLE', overallEligible: null })).toBe(false);
  });

  it('admits exactly one of the entry statuses', () => {
    const admitted = EVENT_ENTRY_STATUSES.filter((status) =>
      isDrawEligible({ status, overallEligible: true }),
    );
    expect(admitted).toEqual(['ELIGIBLE']);
  });
});

// ---------------------------------------------------------------------------
describe('expanding prizes into units', () => {
  it('makes one unit per quantity, numbered from 1', () => {
    const units = expandPrizeUnits([prize({ quantity: 3 })]);
    expect(units.map((u) => u.unitIndex)).toEqual([1, 2, 3]);
    expect(new Set(units.map((u) => u.prizeId))).toEqual(new Set(['p1']));
  });

  it('takes ACTIVE prizes only', () => {
    const units = expandPrizeUnits([
      prize({ id: 'a', status: 'ACTIVE' }),
      prize({ id: 'b', status: 'INACTIVE' }),
      prize({ id: 'c', status: 'ARCHIVED' }),
    ]);
    // INACTIVE is an operator still deciding; ARCHIVED is one they withdrew.
    // Awarding either would give away something nobody meant to give.
    expect(units.map((u) => u.prizeId)).toEqual(['a']);
  });

  it('drops a prize with no units rather than emitting a phantom one', () => {
    expect(expandPrizeUnits([prize({ quantity: 0 })])).toEqual([]);
  });

  it('orders by sortOrder, then id, then unit index — deterministically', () => {
    const units = expandPrizeUnits([
      prize({ id: 'z', sortOrder: 1, quantity: 2 }),
      prize({ id: 'b', sortOrder: 0 }),
      prize({ id: 'a', sortOrder: 0 }),
    ]);
    expect(units.map((u) => `${u.prizeId}#${u.unitIndex}`)).toEqual([
      'a#1',
      'b#1',
      'z#1',
      'z#2',
    ]);
  });

  it('gives the same answer whatever order the rows arrive in', () => {
    // The database's natural row order is an implementation detail. A draw
    // whose unit list depended on it would have a second, unexamined source of
    // chance in it.
    const rows = [
      prize({ id: 'a', sortOrder: 0 }),
      prize({ id: 'b', sortOrder: 1 }),
      prize({ id: 'c', sortOrder: 2 }),
    ];
    const forwards = expandPrizeUnits(rows);
    const backwards = expandPrizeUnits([...rows].reverse());
    expect(backwards).toEqual(forwards);
  });

  it('does not mutate what it was given', () => {
    const rows = [prize({ id: 'z', sortOrder: 1 }), prize({ id: 'a', sortOrder: 0 })];
    const before = rows.map((p) => p.id);
    expandPrizeUnits(rows);
    expect(rows.map((p) => p.id)).toEqual(before);
  });

  it('snapshots the name and description as they are NOW', () => {
    const live = prize({ name: 'Original', description: 'As advertised' });
    const [unit] = expandPrizeUnits([live]);
    live.name = 'Renamed later';
    // The unit carries what the prize was called at expansion time. Renaming it
    // afterwards must not rewrite what somebody was told they had won.
    expect(unit.nameSnapshot).toBe('Original');
    expect(unit.descriptionSnapshot).toBe('As advertised');
  });
});

// ---------------------------------------------------------------------------
describe('how many winners there are', () => {
  it('is the smaller of the two populations', () => {
    expect(plannedWinnerCount(10, 3)).toBe(3);
    expect(plannedWinnerCount(3, 10)).toBe(3);
    expect(plannedWinnerCount(4, 4)).toBe(4);
  });

  it('never invents a winner and never gives anyone two prizes', () => {
    for (let candidates = 0; candidates <= 12; candidates++) {
      for (let units = 0; units <= 12; units++) {
        const winners = plannedWinnerCount(candidates, units);
        expect(winners).toBeLessThanOrEqual(candidates);
        expect(winners).toBeLessThanOrEqual(units);
      }
    }
  });

  it('is zero when either side is empty', () => {
    expect(plannedWinnerCount(0, 5)).toBe(0);
    expect(plannedWinnerCount(5, 0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('the canonical candidate set', () => {
  it('sorts, so the order rows arrived in cannot change the digest', () => {
    expect(canonicalCandidateSet(['c', 'a', 'b'])).toBe(
      canonicalCandidateSet(['a', 'b', 'c']),
    );
  });

  it('carries a version tag as its first member', () => {
    // The tag is the first element of a JSON array, not a line prefix: the
    // serialization stopped being newline-delimited in v2, because a newline
    // inside an identifier made two different populations look identical.
    expect(JSON.parse(canonicalCandidateSet(['a']))[0]).toBe(CANDIDATE_SET_HASH_VERSION);
  });

  it('does not mutate the list it was given', () => {
    const ids = ['c', 'a', 'b'];
    canonicalCandidateSet(ids);
    expect(ids).toEqual(['c', 'a', 'b']);
  });

  it('distinguishes different populations', () => {
    expect(canonicalCandidateSet(['a', 'b'])).not.toBe(canonicalCandidateSet(['a', 'c']));
    // A subset is not the same set, however similar.
    expect(canonicalCandidateSet(['a', 'b'])).not.toBe(canonicalCandidateSet(['a']));
  });

  it('hashes to a stable 64-character lowercase hex digest', async () => {
    const digest = await hashCandidateSet(['b', 'a']);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashCandidateSet(['a', 'b'])).toBe(digest);
  });

  it('produces a digest that carries no identifier verbatim', async () => {
    // The hash is evidence of WHICH population was consumed. It must not be a
    // copy of it.
    const digest = await hashCandidateSet(['4f0e2c1a-dead-beef-cafe-000000000001']);
    expect(digest).not.toContain('4f0e2c1a');
  });
});

// ---------------------------------------------------------------------------
describe('the vocabulary', () => {
  it('names the algorithm, so an old draw cannot be reinterpreted', () => {
    expect(DRAW_ALGORITHM_VERSION).toBe('CRYPTO_FISHER_YATES_V1');
  });

  it('has no duplicate failure codes', () => {
    expect(new Set(DRAW_FAILURE_CODES).size).toBe(DRAW_FAILURE_CODES.length);
  });
});

// ---------------------------------------------------------------------------
// Validation regressions
// ---------------------------------------------------------------------------
describe('the canonical serialization is unambiguous', () => {
  it('cannot be made to collide by a separator inside an identifier', async () => {
    // The v1 format joined identifiers with newlines, so these two DIFFERENT
    // populations both became "v1\na\nb\nc" — one hash for two sets, in the
    // one value that exists to say which set was consumed.
    const a = ['a\nb', 'c'];
    const b = ['a', 'b\nc'];

    expect(canonicalCandidateSet(a)).not.toBe(canonicalCandidateSet(b));
    expect(await hashCandidateSet(a)).not.toBe(await hashCandidateSet(b));
  });

  it('survives quotes, backslashes and unicode in an identifier', async () => {
    for (const [x, y] of [
      [['a"b', 'c'], ['a', 'b"c']],
      [['a\\b', 'c'], ['a', 'b\\c']],
      [['á', 'b'], ['a', 'b']],
      [['', 'ab'], ['a', 'b']],
    ]) {
      expect(canonicalCandidateSet(x)).not.toBe(canonicalCandidateSet(y));
      expect(await hashCandidateSet(x)).not.toBe(await hashCandidateSet(y));
    }
  });

  it('is still order-independent and still version-tagged', () => {
    expect(canonicalCandidateSet(['c', 'a', 'b'])).toBe(
      canonicalCandidateSet(['a', 'b', 'c']),
    );
    expect(canonicalCandidateSet(['a'])).toContain(CANDIDATE_SET_HASH_VERSION);
  });
});

// ---------------------------------------------------------------------------
describe('bounded unit expansion', () => {
  it('returns a PREFIX of the full expansion, never a different set', () => {
    const prizes = [
      { id: 'b', name: 'B', description: null, quantity: 3, sortOrder: 1, status: 'ACTIVE' },
      { id: 'a', name: 'A', description: null, quantity: 3, sortOrder: 0, status: 'ACTIVE' },
    ];
    const full = expandPrizeUnits(prizes);
    for (let limit = 0; limit <= full.length + 2; limit++) {
      expect(expandPrizeUnits(prizes, limit)).toEqual(full.slice(0, limit));
    }
  });

  it('counts the whole offering without building it', () => {
    const prizes = Array.from({ length: 100 }, (_, i) => ({
      id: `p${i}`,
      name: 'A',
      description: null,
      quantity: 1000,
      sortOrder: i,
      status: 'ACTIVE',
    }));
    expect(countPrizeUnits(prizes)).toBe(100_000);
    // ...and the bounded expansion allocates only what was asked for.
    expect(expandPrizeUnits(prizes, 3)).toHaveLength(3);
  });

  it('counts only what is on offer', () => {
    const prizes = [
      { id: 'a', name: 'A', description: null, quantity: 5, sortOrder: 0, status: 'ACTIVE' },
      { id: 'b', name: 'B', description: null, quantity: 5, sortOrder: 1, status: 'INACTIVE' },
      { id: 'c', name: 'C', description: null, quantity: 5, sortOrder: 2, status: 'ARCHIVED' },
    ];
    expect(countPrizeUnits(prizes)).toBe(5);
    expect(countPrizeUnits(prizes)).toBe(expandPrizeUnits(prizes).length);
  });
});

// @vitest-environment node
//
// The randomness that decides who wins.
//
// This is the file that has to be convincing. Everything else in the draw is
// bookkeeping; this is the part where an unfair implementation would still pass
// a naive test, still produce plausible-looking output, and still quietly
// favour whoever happens to sort first.
//
// So the tests here are statistical as well as structural: they measure the
// distribution over enough samples that a biased implementation fails, and they
// are calibrated loosely enough that a correct one does not fail by chance.

import { describe, expect, it } from 'vitest';
import {
  CryptoRandomSource,
  DeterministicRandomSource,
  secureShuffle,
} from '../shared/secureRandom';

// ---------------------------------------------------------------------------
describe('randomInt bounds', () => {
  const random = new CryptoRandomSource();

  it('stays inside [0, n)', () => {
    for (const n of [1, 2, 3, 7, 16, 17, 1000]) {
      for (let i = 0; i < 200; i++) {
        const value = random.randomInt(n);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThan(n);
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });

  it('answers 0 for a single-element range without asking the generator', () => {
    expect(random.randomInt(1)).toBe(0);
  });

  it('refuses a bound that is not a positive integer', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => random.randomInt(bad)).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
describe('randomInt is unbiased', () => {
  /**
   * A chi-square-ish check, stated as a bound on relative deviation.
   *
   * 3 does not divide 2^32, so `value % 3` on raw 32-bit output favours the
   * first `2^32 mod 3` residues. That bias is far too small to see in 60,000
   * samples — which is exactly why this test does NOT claim to detect it.
   *
   * What it does detect is the failure modes that are actually plausible in
   * code: an off-by-one that makes the top value unreachable, a bound applied
   * as `<= n`, a rejection loop that retries into a skewed sub-range, or a
   * source that is not random at all. Those are gross, and this catches them.
   */
  const SAMPLES = 60_000;

  it.each([2, 3, 5, 7, 10])('spreads evenly over %i buckets', (n) => {
    const random = new CryptoRandomSource();
    const counts = new Array<number>(n).fill(0);
    for (let i = 0; i < SAMPLES; i++) counts[random.randomInt(n)] += 1;

    const expected = SAMPLES / n;
    for (const [bucket, count] of counts.entries()) {
      // Every bucket must be reachable at all...
      expect(count, `bucket ${bucket} was never chosen`).toBeGreaterThan(0);
      // ...and within 10% of its share. A uniform generator's deviation over
      // 60k samples is well under 2%; anything structurally skewed is well over.
      expect(
        Math.abs(count - expected) / expected,
        `bucket ${bucket} deviated too far`,
      ).toBeLessThan(0.1);
    }
  });

  it('reaches both ends of the range, not merely the middle', () => {
    const random = new CryptoRandomSource();
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) seen.add(random.randomInt(10));
    expect(seen.has(0)).toBe(true);
    expect(seen.has(9)).toBe(true);
    expect(seen.size).toBe(10);
  });

  it('DISCARDS a value that falls in the unfair tail and draws again', () => {
    // The one property the statistical tests above cannot see.
    //
    // 2^32 does not divide evenly into n buckets unless n is a power of two, so
    // taking a raw remainder hands the first `2^32 mod n` candidates one extra
    // chance each. For n = 3 that bias is about one part in 1.4 billion —
    // real, and far below what any feasible number of samples could detect.
    //
    // So it is tested STRUCTURALLY instead: the generator is scripted to return
    // a value inside the rejection zone, and the source must ask for another
    // one rather than use it. A `% n` implementation consumes exactly one value
    // and returns the biased answer; this asserts both halves.
    const n = 3;
    const limit = Math.floor(0x1_0000_0000 / n) * n; // 4294967295
    // The tail is [limit, 2^32), which for n = 3 is the single value `limit`.
    // `limit + 1` would be 2^32 and wrap to 0 in a Uint32Array — an "impossible
    // to reject" value that would make this test pass against any
    // implementation.
    const rejected = limit;
    const accepted = 7; // 7 % 3 === 1

    const scripted = [rejected, accepted];
    let consumed = 0;

    const original = crypto.getRandomValues;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (crypto as any).getRandomValues = (buffer: Uint32Array) => {
      buffer[0] = scripted[Math.min(consumed, scripted.length - 1)];
      consumed += 1;
      return buffer;
    };

    try {
      const value = new CryptoRandomSource().randomInt(n);
      expect(consumed, 'the tail value must be discarded, not used').toBe(2);
      expect(value).toBe(accepted % n);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (crypto as any).getRandomValues = original;
    }
  });

  it('accepts a value below the limit without asking again', () => {
    // The complement: rejection must be rare, not routine. A source that
    // discarded everything would still be uniform and would also be broken.
    let consumed = 0;
    const original = crypto.getRandomValues;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (crypto as any).getRandomValues = (buffer: Uint32Array) => {
      buffer[0] = 10;
      consumed += 1;
      return buffer;
    };

    try {
      expect(new CryptoRandomSource().randomInt(3)).toBe(1);
      expect(consumed).toBe(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (crypto as any).getRandomValues = original;
    }
  });

  it('does not repeat a fixed sequence between instances', () => {
    // A source seeded from a constant would produce identical runs. Two fresh
    // instances producing the same 32 values has probability ~10^-32.
    const a = new CryptoRandomSource();
    const b = new CryptoRandomSource();
    const runA = Array.from({ length: 32 }, () => a.randomInt(1000));
    const runB = Array.from({ length: 32 }, () => b.randomInt(1000));
    expect(runA).not.toEqual(runB);
  });
});

// ---------------------------------------------------------------------------
describe('secureShuffle', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('returns a permutation — nothing added, nothing lost', () => {
    const random = new CryptoRandomSource();
    for (let i = 0; i < 200; i++) {
      const shuffled = secureShuffle(items, random);
      expect(shuffled).toHaveLength(items.length);
      expect([...shuffled].sort()).toEqual([...items].sort());
    }
  });

  it('does not mutate the input', () => {
    const original = [...items];
    secureShuffle(items, new CryptoRandomSource());
    expect(items).toEqual(original);
    // The candidate list is also what the hash was computed from, so a shuffle
    // that reordered it in place would change what the draw claims to have
    // consumed.
  });

  it('handles the degenerate sizes', () => {
    const random = new CryptoRandomSource();
    expect(secureShuffle([], random)).toEqual([]);
    expect(secureShuffle(['only'], random)).toEqual(['only']);
  });

  it('actually reorders', () => {
    const random = new CryptoRandomSource();
    const many = Array.from({ length: 50 }, (_, i) => i);
    const shuffled = secureShuffle(many, random);
    // Identity has probability 1/50!, so seeing it means the shuffle is a no-op.
    expect(shuffled).not.toEqual(many);
  });

  it('gives every element a fair chance at every position', () => {
    // The property that matters: over many shuffles, element `i` should land in
    // position `j` about 1/n of the time, for EVERY pair. A shuffle that walked
    // the array with a fixed bound — the classic `randomInt(n)` instead of
    // `randomInt(i + 1)` mistake — produces a measurably non-uniform table here.
    const n = 5;
    const runs = 30_000;
    const random = new CryptoRandomSource();
    const table = Array.from({ length: n }, () => new Array<number>(n).fill(0));

    for (let run = 0; run < runs; run++) {
      const shuffled = secureShuffle([0, 1, 2, 3, 4], random);
      shuffled.forEach((value, position) => {
        table[value][position] += 1;
      });
    }

    const expected = runs / n;
    for (let value = 0; value < n; value++) {
      for (let position = 0; position < n; position++) {
        expect(
          Math.abs(table[value][position] - expected) / expected,
          `element ${value} at position ${position}`,
        ).toBeLessThan(0.1);
      }
    }
  });

  it('consumes exactly n-1 random values', () => {
    // Fisher-Yates walks from the end down to index 1. One draw fewer would
    // leave an element unplaced; one more would be a second pass over
    // already-placed elements.
    const random = new DeterministicRandomSource([0]);
    secureShuffle(['a', 'b', 'c', 'd'], random);
    expect(random.consumed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('the deterministic source is a test double, not a shortcut', () => {
  it('reproduces the same shuffle for the same script', () => {
    const first = secureShuffle(['a', 'b', 'c'], new DeterministicRandomSource([0, 1]));
    const second = secureShuffle(['a', 'b', 'c'], new DeterministicRandomSource([0, 1]));
    expect(first).toEqual(second);
  });

  it('wraps an out-of-range script value instead of corrupting the array', () => {
    // A scripted value beyond the bound would otherwise produce an
    // out-of-bounds swap and a shuffle containing `undefined`.
    const shuffled = secureShuffle(
      ['a', 'b', 'c'],
      new DeterministicRandomSource([99, -7]),
    );
    expect([...shuffled].sort()).toEqual(['a', 'b', 'c']);
  });

  it('enforces the same bounds contract as the real source', () => {
    expect(() => new DeterministicRandomSource([0]).randomInt(0)).toThrow(RangeError);
  });
});

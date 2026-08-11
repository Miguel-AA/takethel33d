// Randomness for the draw.
//
// This file decides who wins. Everything in it is written for one property:
// every candidate has the same chance, and nobody — including whoever runs the
// draw — can influence or predict which one it is.
//
// THREE THINGS THAT WOULD QUIETLY BREAK THAT, and are therefore ruled out here
// rather than left to reviewer vigilance:
//
//   1. `Math.random()`. It is a fast PRNG seeded from a value an attacker can
//      often infer, and its output is predictable from a handful of previous
//      draws. It is fine for a loading animation and disqualifying for choosing
//      who receives something of value.
//
//   2. `random % n`. Unless `n` divides the generator's range exactly, the low
//      residues occur more often — with 2^32 and n = 3, the first candidate is
//      favoured. The bias is small, real, and entirely avoidable.
//
//   3. `array.sort(() => Math.random() - 0.5)`. It is not a shuffle. The
//      comparator is inconsistent, so the result depends on the sort
//      implementation and is measurably far from uniform.
//
// The source is an INTERFACE so tests can be deterministic without production
// ever being. There is no seed parameter anywhere a request can reach: a caller
// who could choose the seed could choose the winners.
//
// WHY THIS IS IN `shared/` AND NOT IN `functions/_shared/`. The dev mock has to
// shuffle too, and a second implementation of "pick a uniform index" is exactly
// the kind of near-duplicate that agrees for months and then quietly does not.
// The same reasoning put the non-signature half of the form token here in phase
// 9. Nothing in this file is a secret or a server capability: it is arithmetic
// over `crypto.getRandomValues`, which every runtime already exposes.
//
// `DeterministicRandomSource` therefore CAN reach a browser bundle, and that is
// harmless for the reason that matters: selecting it requires constructing the
// draw service with it, which happens in exactly one place per runtime and
// never from a request. Being reachable is not the same as being reachable BY
// AN ATTACKER.

/**
 * Where randomness comes from.
 *
 * Narrow on purpose — one method, one obligation. A wider interface would
 * invite an implementation that satisfies the type while being unfit for this.
 */
export interface SecureRandomSource {
  /** A uniformly distributed integer in `[0, maxExclusive)`. */
  randomInt(maxExclusive: number): number;
}

const UINT32_RANGE = 0x1_0000_0000;

/**
 * The production source: the platform CSPRNG, debiased.
 *
 * `crypto.getRandomValues` is available in Workers, in Node and in browsers,
 * and is the same primitive the session tokens and the form-token nonce already
 * use.
 */
export class CryptoRandomSource implements SecureRandomSource {
  private readonly buffer = new Uint32Array(1);

  /** One uniform 32-bit value. */
  private nextUint32(): number {
    crypto.getRandomValues(this.buffer);
    return this.buffer[0];
  }

  /**
   * REJECTION SAMPLING, and this is the whole reason the method exists rather
   * than callers writing `% n` themselves.
   *
   * 2^32 values do not divide evenly into `n` buckets unless `n` is a power of
   * two. Taking the remainder therefore hands the first `2^32 mod n` candidates
   * one extra chance each. The fix is to discard the values in that unfair tail
   * and draw again: `limit` is the largest exact multiple of `n` below 2^32, so
   * every accepted value maps to exactly one bucket and every bucket has
   * exactly the same number of accepted values.
   *
   * The loop is unbounded in principle and negligible in practice: it rejects
   * with probability under `n / 2^32`, so for any candidate count this system
   * can hold, a second iteration is already vanishingly unlikely. Bounding it
   * with a fallback would reintroduce the bias it exists to remove.
   */
  randomInt(maxExclusive: number): number {
    assertPositiveInteger(maxExclusive);
    // A single-element range has one answer, and asking the generator for it
    // would only consume entropy to be told what is already known.
    if (maxExclusive === 1) return 0;

    const limit = Math.floor(UINT32_RANGE / maxExclusive) * maxExclusive;

    let value = this.nextUint32();
    while (value >= limit) value = this.nextUint32();

    return value % maxExclusive;
  }
}

/**
 * A source that yields a scripted sequence.
 *
 * FOR TESTS ONLY. The draw service takes its source as a constructor
 * dependency that no request, header or body can influence, so this cannot be
 * selected at runtime — the only way to get a scripted draw is to build the
 * service with one, which only a test does.
 *
 * It reproduces the real contract, including the bounds check, so a test that
 * passes against it is testing the same guarantees.
 */
export class DeterministicRandomSource implements SecureRandomSource {
  private index = 0;

  constructor(private readonly values: readonly number[]) {}

  randomInt(maxExclusive: number): number {
    assertPositiveInteger(maxExclusive);
    if (maxExclusive === 1) return 0;

    const value = this.values[this.index % this.values.length];
    this.index += 1;
    // Wrapped rather than trusted: a scripted value out of range would silently
    // produce an out-of-bounds swap and a corrupted shuffle.
    return ((value % maxExclusive) + maxExclusive) % maxExclusive;
  }

  /** How many values have been consumed. Lets a test assert the shuffle ran. */
  get consumed(): number {
    return this.index;
  }
}

function assertPositiveInteger(maxExclusive: number): void {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
    throw new RangeError(`randomInt requires a positive integer bound: ${maxExclusive}`);
  }
}

/**
 * Fisher–Yates, over a COPY.
 *
 * Walking downward and swapping element `i` with a uniformly chosen element in
 * `[0, i]` is what makes every one of the `n!` orderings equally likely. The
 * bound is `i + 1` and not `i` or `n`: excluding `i` itself would make "stays
 * put" impossible and bias the result, and allowing indices above `i` would
 * revisit already-placed elements and do the same.
 *
 * The input is copied rather than shuffled in place, so a caller cannot be
 * surprised by its candidate list being reordered underneath it — the list is
 * also what the candidate hash was computed from.
 */
export function secureShuffle<T>(items: readonly T[], random: SecureRandomSource): T[] {
  const shuffled = [...items];

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = random.randomInt(i + 1);
    const swap = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = swap;
  }

  return shuffled;
}

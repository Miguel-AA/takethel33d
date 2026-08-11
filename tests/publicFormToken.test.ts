// @vitest-environment node
//
// The form-session token.
//
// Every test here is an attempt to make the verifier accept something it should
// not. Passing means these particular forgeries fail — not that the token is
// unforgeable.

import { describe, expect, it } from 'vitest';
import {
  PublicFormTokenService,
  fromBase64Url,
  toBase64Url,
} from '../functions/_shared/publicFormToken';
import {
  PUBLIC_FORM_TOKEN_MAX_BYTES,
  PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS,
  PUBLIC_FORM_TOKEN_TTL_SECONDS,
} from '../shared/limits';

const SECRET = 'test-only-form-token-secret-do-not-use-in-production';
const OTHER_SECRET = 'a-different-test-only-secret-value-entirely';
const EVENT = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-03-01T12:00:00.000Z');

const service = () => new PublicFormTokenService(SECRET);

/** Rebuilds a token with a different payload but the ORIGINAL signature. */
function withPayload(token: string, mutate: (payload: Record<string, unknown>) => void): string {
  const [prefix, encodedPayload, mac] = token.split('.');
  const decoded = fromBase64Url(encodedPayload);
  if (!decoded) throw new Error('unreachable');
  const payload = JSON.parse(new TextDecoder().decode(decoded)) as Record<string, unknown>;
  mutate(payload);
  const rebuilt = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${prefix}.${rebuilt}.${mac}`;
}

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 62, 63, 127, 128, 255]);
    const decoded = fromBase64Url(toBase64Url(bytes));
    expect(decoded && [...decoded]).toEqual([...bytes]);
  });

  it('emits no padding and none of the base64 characters that need escaping', () => {
    const encoded = toBase64Url(new Uint8Array([251, 255, 190]));
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
  });

  it('refuses anything outside the base64url alphabet', () => {
    // `atob` is lax about these in several runtimes. Accepting them would let
    // two different strings decode to the same bytes, which is a signature
    // bypass rather than a cosmetic problem.
    for (const bad of ['', 'a b', 'a+b', 'a/b', 'a=b', 'á', 'a\nb']) {
      expect(fromBase64Url(bad), bad).toBeNull();
    }
  });
});

describe('issuing', () => {
  it('produces the documented three-segment shape', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    expect(token).not.toBeNull();
    const segments = token!.split('.');
    expect(segments).toHaveLength(3);
    expect(segments[0]).toBe('v1');
  });

  it('carries no personal data — only ids, a time and a nonce', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(token!.split('.')[1])!),
    );
    expect(Object.keys(payload).sort()).toEqual(['e', 'i', 'n', 'v']);
  });

  it('declares no algorithm, so a caller can never choose one', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(token!.split('.')[1])!),
    );
    expect(payload.alg).toBeUndefined();
  });

  it('two tokens for the same pair differ', async () => {
    const a = await service().issue(EVENT, VERSION, NOW);
    const b = await service().issue(EVENT, VERSION, NOW);
    expect(a).not.toBe(b);
  });

  it('stays well inside the size cap', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    expect(new TextEncoder().encode(token!).length).toBeLessThan(
      PUBLIC_FORM_TOKEN_MAX_BYTES,
    );
  });
});

describe('verifying', () => {
  it('accepts a token it just issued and returns its claims', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const result = await service().verify(token!, EVENT, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.claims.eventId).toBe(EVENT);
    expect(result.claims.versionId).toBe(VERSION);
  });

  it('refuses a token whose payload was edited, signature untouched', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    // Swapping the VERSION is the attack that matters: it would bind a
    // submission to a form the participant never saw.
    const forged = withPayload(token!, (payload) => {
      payload.v = '33333333-3333-4333-8333-333333333333';
    });

    const result = await service().verify(forged, EVENT, NOW);
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses a token whose event was swapped', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const forged = withPayload(token!, (payload) => {
      payload.e = '44444444-4444-4444-8444-444444444444';
    });
    const result = await service().verify(forged, EVENT, NOW);
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses a tampered MAC', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const [prefix, payload, mac] = token!.split('.');
    // The FIRST character, which carries all six of its bits. See the test
    // below for why the last one does not.
    const flipped = (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1);

    const result = await service().verify(`${prefix}.${payload}.${flipped}`, EVENT, NOW);
    expect(result.ok).toBe(false);
  });

  it('refuses a MAC tampered at ANY significant position', async () => {
    // Exhaustive over the positions that carry full bits, so a verifier that
    // only compared a prefix or a suffix of the digest would fail here.
    const token = await service().issue(EVENT, VERSION, NOW);
    const [prefix, payload, mac] = token!.split('.');

    for (let i = 0; i < mac.length - 1; i++) {
      const flipped =
        mac.slice(0, i) + (mac[i] === 'A' ? 'B' : 'A') + mac.slice(i + 1);
      if (flipped === mac) continue;
      const result = await service().verify(`${prefix}.${payload}.${flipped}`, EVENT, NOW);
      expect(result.ok, `position ${i}`).toBe(false);
    }
  });

  it('treats trailing-bit variants of a MAC as the SAME signature', async () => {
    // A 43-character base64url string encodes 32 bytes: 258 bits of alphabet
    // for 256 bits of data. The final character's low 2 bits are therefore
    // padding that the decoder discards, so 'A', 'B', 'C' and 'D' in the last
    // position all decode to the same byte.
    //
    // This is recorded because it looks like a hole and is not one. Verification
    // compares BYTES, so a re-encoded token is the same signature rather than a
    // second valid one — an attacker who can produce these variants already
    // holds a valid token, and gains nothing by rewriting its last character.
    //
    // It is recorded for a second reason: a test that mutated the last character
    // to "tamper" with a MAC silently did nothing about one time in sixteen, and
    // two suites asserted a refusal that never came.
    const token = await service().issue(EVENT, VERSION, NOW);
    const [prefix, payload, mac] = token!.split('.');

    const last = mac.at(-1)!;
    const group = ['A', 'B', 'C', 'D'];
    const index = group.indexOf(last);
    // Only meaningful when the MAC happens to end in that group; when it does
    // not, the equivalent variant is a different character entirely and the
    // arithmetic below would be guesswork.
    if (index === -1) return;

    for (const variant of group) {
      const rewritten = `${prefix}.${payload}.${mac.slice(0, -1)}${variant}`;
      const result = await service().verify(rewritten, EVENT, NOW);
      expect(result.ok, `last character ${variant}`).toBe(true);
    }
  });

  it('refuses a genuine token signed with a different secret', async () => {
    const token = await new PublicFormTokenService(OTHER_SECRET).issue(EVENT, VERSION, NOW);
    const result = await service().verify(token!, EVENT, NOW);
    expect(result).toEqual({ ok: false, reason: 'BAD_SIGNATURE' });
  });

  it('refuses an unknown prefix without attempting a signature', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const [, payload, mac] = token!.split('.');
    const result = await service().verify(`v2.${payload}.${mac}`, EVENT, NOW);
    expect(result).toEqual({ ok: false, reason: 'UNSUPPORTED_VERSION' });
  });

  it('refuses malformed shapes', async () => {
    for (const bad of ['', 'v1', 'v1.abc', 'v1.a.b.c', '...']) {
      const result = await service().verify(bad, EVENT, NOW);
      expect(result.ok, bad).toBe(false);
    }
  });

  it('refuses an oversized token BEFORE decoding it', async () => {
    const huge = `v1.${'A'.repeat(PUBLIC_FORM_TOKEN_MAX_BYTES + 10)}.AAAA`;
    const result = await service().verify(huge, EVENT, NOW);
    expect(result).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });

  it('measures the cap in BYTES, not characters', async () => {
    // Multi-byte characters would sneak past a `.length` check.
    const multibyte = `v1.${'é'.repeat(PUBLIC_FORM_TOKEN_MAX_BYTES - 10)}.AAAA`;
    expect(multibyte.length).toBeLessThan(PUBLIC_FORM_TOKEN_MAX_BYTES);
    const result = await service().verify(multibyte, EVENT, NOW);
    expect(result).toEqual({ ok: false, reason: 'TOO_LARGE' });
  });
});

describe('time', () => {
  it('accepts a token one second inside its life', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const at = NOW + (PUBLIC_FORM_TOKEN_TTL_SECONDS - 1) * 1000;
    expect((await service().verify(token!, EVENT, at)).ok).toBe(true);
  });

  it('refuses a token one second past it', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const at = NOW + (PUBLIC_FORM_TOKEN_TTL_SECONDS + 1) * 1000;
    expect(await service().verify(token!, EVENT, at)).toEqual({
      ok: false,
      reason: 'EXPIRED',
    });
  });

  it('tolerates a clock 59 seconds behind the issuer', async () => {
    // Edge machines disagree slightly. Without the allowance a visitor would be
    // refused the instant they submitted a form they had just been served.
    const token = await service().issue(EVENT, VERSION, NOW);
    const at = NOW - (PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS - 1) * 1000;
    expect((await service().verify(token!, EVENT, at)).ok).toBe(true);
  });

  it('refuses a token issued 61 seconds in the future', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const at = NOW - (PUBLIC_FORM_TOKEN_MAX_FUTURE_SKEW_SECONDS + 1) * 1000;
    expect(await service().verify(token!, EVENT, at)).toEqual({
      ok: false,
      reason: 'ISSUED_IN_FUTURE',
    });
  });

  it('cannot have its life extended by backdating issuedAt', async () => {
    // Editing `i` invalidates the signature, so the TTL cannot be stretched.
    const token = await service().issue(EVENT, VERSION, NOW);
    const forged = withPayload(token!, (payload) => {
      payload.i = Math.floor(NOW / 1000) + PUBLIC_FORM_TOKEN_TTL_SECONDS;
    });
    expect((await service().verify(forged, EVENT, NOW)).ok).toBe(false);
  });
});

describe('event binding', () => {
  it('refuses a valid token presented on another event', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const elsewhere = '55555555-5555-4555-8555-555555555555';
    expect(await service().verify(token!, elsewhere, NOW)).toEqual({
      ok: false,
      reason: 'EVENT_MISMATCH',
    });
  });
});

describe('missing secret', () => {
  it('reports unavailable rather than issuing anything', async () => {
    for (const absent of [undefined, null, '', '   ']) {
      const bare = new PublicFormTokenService(absent);
      expect(bare.available, String(absent)).toBe(false);
      expect(await bare.issue(EVENT, VERSION, NOW)).toBeNull();
    }
  });

  it('verifies nothing — there is no fallback secret', async () => {
    const token = await service().issue(EVENT, VERSION, NOW);
    const bare = new PublicFormTokenService(undefined);
    expect(await bare.verify(token!, EVENT, NOW)).toEqual({
      ok: false,
      reason: 'SECRET_MISSING',
    });
  });

  it('treats an empty secret as absent rather than signing with it', async () => {
    // An empty key produces perfectly valid HMACs that anybody can reproduce —
    // a silent downgrade to no security at all.
    const empty = new PublicFormTokenService('');
    expect(empty.available).toBe(false);
  });
});

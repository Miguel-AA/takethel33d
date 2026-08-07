// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  generateSessionToken,
  hashOpaqueValue,
  hashToken,
} from '../functions/_shared/tokens';

describe('session tokens', () => {
  it('generates unique, high-entropy, cookie-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateSessionToken()));
    expect(tokens.size).toBe(200);

    for (const token of tokens) {
      // base64url of 32 bytes, unpadded.
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });

  it('hashes deterministically', async () => {
    const token = generateSessionToken();
    expect(await hashToken(token)).toBe(await hashToken(token));
  });

  it('produces a different hash for a different token', async () => {
    expect(await hashToken('token-a')).not.toBe(await hashToken('token-b'));
  });

  it('a tampered token produces a different hash', async () => {
    const token = generateSessionToken();
    const hash = await hashToken(token);

    const flipped = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
    expect(await hashToken(flipped)).not.toBe(hash);
    expect(await hashToken(`${token}x`)).not.toBe(hash);
    expect(await hashToken(token.slice(0, -1))).not.toBe(hash);
  });

  it('emits a 64-character lowercase hex SHA-256 digest', async () => {
    expect(await hashToken('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known SHA-256 vector for "abc"', async () => {
    expect(await hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('the hash is not reversible to the token', async () => {
    const token = generateSessionToken();
    const hash = await hashToken(token);
    expect(hash).not.toContain(token);
    expect(token).not.toContain(hash);
  });

  it('hashOpaqueValue hides raw values such as IP addresses', async () => {
    const hashed = await hashOpaqueValue('203.0.113.7');
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashed).not.toContain('203.0.113.7');
  });
});

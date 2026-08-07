// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  DUMMY_PASSWORD_HASH,
  PBKDF2_ALGORITHM,
  hashPassword,
  verifyPassword,
} from '../functions/_shared/password';

describe('password hashing', () => {
  it('produces a different hash each time thanks to a random salt', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);

    // ...yet both verify: the salt is embedded, not a second secret.
    expect(await verifyPassword('correct horse battery staple', a)).toBe(true);
    expect(await verifyPassword('correct horse battery staple', b)).toBe(true);
  });

  it('encodes algorithm, iterations, salt and digest', async () => {
    const hash = await hashPassword('a-very-long-password');
    const parts = hash.split('$');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe(PBKDF2_ALGORITHM);
    expect(Number(parts[1])).toBeGreaterThanOrEqual(100_000);
    expect(parts[2].length).toBeGreaterThan(0);
    expect(parts[3].length).toBeGreaterThan(0);
  });

  it('never stores the password itself', async () => {
    const password = 'super-secret-passphrase';
    const hash = await hashPassword(password);
    expect(hash).not.toContain(password);
  });

  it('accepts the correct password', async () => {
    const hash = await hashPassword('right-password-123');
    expect(await verifyPassword('right-password-123', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('right-password-123');
    expect(await verifyPassword('wrong-password-123', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
    expect(await verifyPassword('right-password-124', hash)).toBe(false);
  });

  it('is case sensitive and whitespace sensitive', async () => {
    const hash = await hashPassword('CaseSensitive Pass');
    expect(await verifyPassword('casesensitive pass', hash)).toBe(false);
    expect(await verifyPassword('CaseSensitive Pass ', hash)).toBe(false);
  });

  it('handles malformed stored hashes without throwing', async () => {
    const malformed = [
      '',
      'not-a-hash',
      'pbkdf2-sha256$100000$onlythree',
      'pbkdf2-sha256$100000$!!!notbase64!!!$also-bad',
      'pbkdf2-sha256$abc$c2FsdA==$aGFzaA==',
      'pbkdf2-sha256$-1$c2FsdA==$aGFzaA==',
      'bcrypt$100000$c2FsdA==$aGFzaA==',
      '$$$',
    ];
    for (const stored of malformed) {
      await expect(verifyPassword('anything', stored)).resolves.toBe(false);
    }
  });

  it('tolerates a non-string stored value', async () => {
    // A corrupt/NULL column must degrade to "wrong password", not a crash.
    await expect(
      verifyPassword('x', null as unknown as string),
    ).resolves.toBe(false);
    await expect(
      verifyPassword('x', undefined as unknown as string),
    ).resolves.toBe(false);
  });

  it('verifies a hash stored with a lower iteration count', async () => {
    // The cost factor lives inside the stored value, so raising it later must
    // not invalidate hashes written under the old one. Build a 1,000-iteration
    // hash by hand and check the verifier honours it.
    const password = 'legacy-cost-factor';
    const salt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(password),
      'PBKDF2',
      false,
      ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 1000, hash: 'SHA-256' },
      keyMaterial,
      256,
    );
    const b64 = (bytes: Uint8Array) =>
      Buffer.from(bytes).toString('base64');
    const stored = `${PBKDF2_ALGORITHM}$1000$${b64(salt)}$${b64(new Uint8Array(bits))}`;

    expect(await verifyPassword(password, stored)).toBe(true);
    expect(await verifyPassword('wrong', stored)).toBe(false);
  });

  it('DUMMY_PASSWORD_HASH is well-formed but matches nothing', async () => {
    expect(DUMMY_PASSWORD_HASH.split('$')).toHaveLength(4);
    expect(await verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('admin', DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

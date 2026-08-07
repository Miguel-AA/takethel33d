// Password hashing for administrative accounts.
//
// Algorithm: PBKDF2-HMAC-SHA256 via Web Crypto (`crypto.subtle`).
//
// Why PBKDF2 and not bcrypt/scrypt/argon2: Cloudflare Workers expose Web Crypto
// natively, so PBKDF2 needs ZERO dependencies and no WASM bundle. bcrypt and
// argon2 bindings are native or WASM modules that either do not run on Workers
// or add a large bundle. PBKDF2 with a high iteration count is an accepted
// password KDF (NIST SP 800-132) and is the pragmatic choice for this runtime.
//
// The iteration count is stored INSIDE the encoded hash, so it can be raised
// later without invalidating existing hashes: verification always uses the
// count that produced the stored hash.
//
// Encoded form (single string, stored in `admin_users.password_hash`):
//   pbkdf2-sha256$<iterations>$<base64(salt)>$<base64(derivedKey)>
//
// This module has NO imports on purpose. Besides being the right shape for a
// crypto primitive, it lets `scripts/bootstrap-admin.ts` run under plain
// `node` (whose ESM resolver requires explicit file extensions) while the
// Workers bundler consumes the same file unchanged.

export const PBKDF2_ALGORITHM = 'pbkdf2-sha256';

/** Constant-time byte comparison. Local so this module stays dependency-free. */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a[i] ^ b[i];
  }
  return mismatch === 0;
}

/**
 * Cost factor. Tuned for the Workers CPU budget: PBKDF2-SHA256 at 100k
 * iterations costs roughly 50-100ms of CPU, which is acceptable on a login
 * (an infrequent, human-initiated request) but would exceed the 10ms CPU
 * ceiling of the Cloudflare free plan. See README "Notas de operación".
 */
export const PBKDF2_ITERATIONS = 100_000;

const SALT_BYTES = 16;
const DERIVED_KEY_BITS = 256;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_KEY_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Hashes a password with a fresh random salt. Two calls with the same password
 * always produce different encoded hashes.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_ALGORITHM}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(derived)}`;
}

/**
 * Verifies a password against an encoded hash.
 *
 * Returns `false` — never throws — for malformed, truncated, unknown-algorithm
 * or corrupt stored values, so a damaged row degrades to "wrong password"
 * instead of surfacing a 500 that would leak the storage format.
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    if (typeof storedHash !== 'string' || storedHash.length === 0) return false;

    const parts = storedHash.split('$');
    if (parts.length !== 4) return false;

    const [algorithm, iterationsRaw, saltB64, hashB64] = parts;
    if (algorithm !== PBKDF2_ALGORITHM) return false;

    const iterations = Number(iterationsRaw);
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 10_000_000) {
      return false;
    }

    const salt = fromBase64(saltB64);
    const expected = fromBase64(hashB64);
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await deriveKey(password, salt, iterations);
    return timingSafeEqualBytes(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A syntactically valid encoded hash that matches no password. Used to spend
 * the same CPU on a login for an unknown email as for a known one, so response
 * timing does not disclose whether an account exists.
 */
export const DUMMY_PASSWORD_HASH = `${PBKDF2_ALGORITHM}$${PBKDF2_ITERATIONS}$${toBase64(
  new Uint8Array(SALT_BYTES),
)}$${toBase64(new Uint8Array(DERIVED_KEY_BITS / 8))}`;

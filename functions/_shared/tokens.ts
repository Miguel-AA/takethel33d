// Session-token generation and hashing.
//
// A session token is 256 bits of CSPRNG output. Because it is already
// high-entropy (unlike a password, which is low-entropy and needs a slow KDF),
// the correct digest here is a plain, fast, deterministic cryptographic hash:
// SHA-256. A slow KDF would add cost to EVERY authenticated request while
// buying nothing — there is no dictionary to attack.
//
// D1 only ever stores the hash. The plaintext token exists in exactly two
// places: the Set-Cookie header of the login response, and the client's cookie
// jar. A database leak therefore does not yield usable sessions.

const TOKEN_BYTES = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generates a new 256-bit session token, encoded base64url (cookie-safe). */
export function generateSessionToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

/** Deterministic SHA-256 of a token, lowercase hex. This is what D1 stores. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Hashes a value that we do not want to store in the clear (currently the
 * client IP used for rate limiting). Same primitive as `hashToken`; kept under
 * a separate name so intent is visible at the call site.
 */
export async function hashOpaqueValue(value: string): Promise<string> {
  return hashToken(value);
}

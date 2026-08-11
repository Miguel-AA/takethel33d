// The form-session token: the half that needs the secret.
//
// WHAT IT IS FOR, precisely: a participant is shown ONE version of a form, and
// the submission that comes back must be judged against THAT version — not
// against whatever the event happens to serve when the POST lands. Between the
// GET and the POST an administrator may publish a new version; without this
// token the answers would be validated against questions the person was never
// asked.
//
// WHAT IT IS NOT: authentication. It authorises nothing and identifies nobody.
// It carries no personal data and confers no privilege. Possessing one means
// exactly "the server rendered this version of this form, recently" — which is
// why every check that matters (is the event open? has this identity already
// entered? is this person eligible?) is still performed on the way in.
//
// WHY SIGNED RATHER THAN OPAQUE-AND-STORED: a stored session would need a
// table, a write on every page view and a sweeper. An HMAC over a tiny payload
// needs none of that and is verifiable by any isolate without a round trip. The
// cost is that it cannot be revoked individually — acceptable, because its
// lifetime is two hours and it grants nothing.
//
// EVERYTHING EXCEPT THE SIGNATURE lives in `shared/publicFormToken.ts`, so the
// dev mock enforces byte-identical rules without pretending to do cryptography.

import {
  PUBLIC_FORM_TOKEN_MAX_BYTES,
  PUBLIC_FORM_TOKEN_NONCE_BYTES,
} from '../../shared/limits';
import {
  TOKEN_PREFIX,
  checkTokenClaims,
  decodeTokenPayload,
  encodeTokenPayload,
  fromBase64Url,
  splitToken,
  toBase64Url,
  type FormTokenFailure,
} from '../../shared/publicFormToken';

// Re-exported so server-side callers have one import for the whole concept.
export {
  TOKEN_PREFIX,
  checkTokenClaims,
  decodeTokenPayload,
  fromBase64Url,
  splitToken,
  toBase64Url,
};
export type { FormTokenFailure };

export interface FormTokenClaims {
  eventId: string;
  versionId: string;
  issuedAtSeconds: number;
}

export type FormTokenResult =
  | { ok: true; claims: FormTokenClaims }
  | { ok: false; reason: FormTokenFailure };

const encoder = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/**
 * The service that mints and checks tokens.
 *
 * The secret is supplied at construction and may be absent — Cloudflare gives a
 * handler whatever bindings the environment actually has, and a missing one is
 * a deployment fact, not a programming error. `available` lets a caller answer
 * "can this event be served at all?" without attempting a signature.
 */
export class PublicFormTokenService {
  private readonly secret: string | null;

  constructor(secret: string | null | undefined) {
    // An empty or whitespace-only binding is treated as absent. A secret of ""
    // would otherwise produce perfectly valid signatures that anybody could
    // reproduce — a silent downgrade to no security at all.
    const trimmed = typeof secret === 'string' ? secret.trim() : '';
    this.secret = trimmed.length > 0 ? trimmed : null;
  }

  /** Whether this deployment can issue or verify anything. */
  get available(): boolean {
    return this.secret !== null;
  }

  /**
   * Mints a token binding one event to one version.
   *
   * `nowMs` is injected so the issuing endpoint can use the same instant it
   * used to decide the event's public status — a token whose `issuedAt` came
   * from a second clock read could be marginally in the past of the status it
   * accompanies.
   */
  async issue(
    eventId: string,
    versionId: string,
    nowMs: number,
  ): Promise<string | null> {
    if (this.secret === null) return null;

    const encodedPayload = encodeTokenPayload({
      e: eventId,
      v: versionId,
      i: Math.floor(nowMs / 1000),
      n: toBase64Url(
        crypto.getRandomValues(new Uint8Array(PUBLIC_FORM_TOKEN_NONCE_BYTES)),
      ),
    });

    const key = await importKey(this.secret);
    const mac = await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${TOKEN_PREFIX}.${encodedPayload}`),
    );

    return `${TOKEN_PREFIX}.${encodedPayload}.${toBase64Url(new Uint8Array(mac))}`;
  }

  /**
   * Verifies a token and returns its claims.
   *
   * THE ORDER IS THE POINT. Each step is the cheapest check that can still
   * refuse the input, so a hostile caller cannot make the server do expensive
   * work by sending rubbish:
   *
   *   1. secret present      — nothing is verifiable without it
   *   2. size                — BEFORE any parsing or allocation
   *   3. shape and prefix    — three segments, `v1`
   *   4. SIGNATURE           — before the payload is trusted for anything
   *   5. payload well formed — only now is it safe to read
   *   6. expiry / future skew / event binding
   *
   * Step 4 precedes step 5 deliberately: reading an unverified payload and
   * acting on its contents — even to decide whether to reject it — is how
   * parsers become attack surface.
   *
   * The VERSION binding is not checked here. This function proves the claims
   * are ours; proving that the named version exists and belongs to the named
   * event requires the database, and that check lives in the service that has
   * one. Both must happen, and neither substitutes for the other.
   */
  async verify(
    token: string,
    expectedEventId: string,
    nowMs: number,
  ): Promise<FormTokenResult> {
    if (this.secret === null) return { ok: false, reason: 'SECRET_MISSING' };

    if (encoder.encode(token).length > PUBLIC_FORM_TOKEN_MAX_BYTES) {
      return { ok: false, reason: 'TOO_LARGE' };
    }

    const parts = splitToken(token);
    if (!parts) return { ok: false, reason: 'MALFORMED' };
    if (parts.prefix !== TOKEN_PREFIX) {
      return { ok: false, reason: 'UNSUPPORTED_VERSION' };
    }

    const mac = fromBase64Url(parts.mac);
    if (mac === null) return { ok: false, reason: 'MALFORMED' };

    const key = await importKey(this.secret);
    // `crypto.subtle.verify` compares in constant time. Signing again and
    // comparing the strings with `===` would leak, through timing, how many
    // leading bytes of a forged MAC were correct — which is enough to forge one
    // byte at a time.
    const signatureValid = await crypto.subtle.verify(
      'HMAC',
      key,
      mac as unknown as BufferSource,
      encoder.encode(`${parts.prefix}.${parts.payload}`),
    );
    if (!signatureValid) return { ok: false, reason: 'BAD_SIGNATURE' };

    const payload = decodeTokenPayload(parts.payload);
    if (payload === null) return { ok: false, reason: 'MALFORMED' };

    const problem = checkTokenClaims(payload, expectedEventId, nowMs);
    if (problem) return { ok: false, reason: problem };

    return {
      ok: true,
      claims: {
        eventId: payload.e,
        versionId: payload.v,
        issuedAtSeconds: payload.i,
      },
    };
  }
}

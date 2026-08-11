// Rate limiting for the public flow.
//
// The public endpoints are the first in this system that an unauthenticated
// stranger can reach, so they are the first that need to survive being pointed
// at. Everything here reuses `PersistentRateLimiter` — same table, same atomic
// upsert, same fixed window — with the public flow's own numbers and its own
// key shapes.
//
// FOUR BUCKETS, BECAUSE THERE ARE FOUR DIFFERENT ABUSES.
//
//   pub_get:<ipHash>:<eventId>
//     Scraping a page. Generous: a visitor reloads, navigates back, shares a
//     link in a group chat.
//
//   pub_entry_ip:<ipHash>:<eventId>
//     One machine submitting repeatedly. A person submits once.
//
//   pub_entry_ip_email:<ipHash>:<emailHash>:<eventId>
//     THE PRECISE ONE. Somebody probing whether a specific address is already
//     registered is exactly this shape, and this is the bucket meant to stop
//     them — tight, but not so tight that a genuine correction is punished.
//
//   pub_entry_email:<emailHash>:<eventId>
//     A backstop across every source address, for the distributed case the
//     other three cannot see. Deliberately loose: see the lockout note below.
//
// THE LOCKOUT PROBLEM, STATED PLAINLY. The email-only bucket is the one that
// can be turned against the person it protects: an attacker who knows somebody's
// address could burn that bucket from many machines and stop the real person
// from registering at all. That is why its ceiling is high enough that no
// honest visitor will ever reach it, and why the refusal work is done by
// `pub_entry_ip_email`, which an attacker cannot exhaust on a victim's behalf
// without also holding the victim's IP address.
//
// Everything is keyed by EVENT as well, so pressure on one event cannot lock a
// person out of a different one.
//
// KNOWN LIMITS, inherited and unchanged: a fixed window admits up to 2x the
// ceiling across a boundary, and `check` then `record` is two round trips
// rather than one atomic operation. Both are acceptable here — this is a
// throttle on abuse, not an authorisation decision — and the real escalation
// for a determined attacker remains Cloudflare's WAF or a Durable Object, which
// plugs in behind this seam without touching a handler.

import {
  PUBLIC_ENTRY_EMAIL_RATE_MAX,
  PUBLIC_ENTRY_EMAIL_RATE_WINDOW_MS,
  PUBLIC_ENTRY_IP_EMAIL_RATE_MAX,
  PUBLIC_ENTRY_IP_EMAIL_RATE_WINDOW_MS,
  PUBLIC_ENTRY_IP_RATE_MAX,
  PUBLIC_ENTRY_IP_RATE_WINDOW_MS,
  PUBLIC_GET_RATE_MAX,
  PUBLIC_GET_RATE_WINDOW_MS,
} from '../../shared/limits';
import { PersistentRateLimiter, type RateLimitVerdict } from './rateLimit';
import { hashOpaqueValue } from './tokens';

export const PUBLIC_BUCKET_PREFIXES = {
  get: 'pub_get',
  entryIp: 'pub_entry_ip',
  entryIpEmail: 'pub_entry_ip_email',
  entryEmail: 'pub_entry_email',
} as const;

/**
 * Labels a public bucket for reporting.
 *
 * Order matters: `pub_entry_ip_email` shares a prefix with `pub_entry_ip`, so
 * the longer label has to be tested first or every composite bucket would be
 * mislabelled as the coarse one.
 */
export function publicBucketKind(bucketKey: string): string | null {
  if (bucketKey.startsWith(`${PUBLIC_BUCKET_PREFIXES.entryIpEmail}:`)) {
    return PUBLIC_BUCKET_PREFIXES.entryIpEmail;
  }
  if (bucketKey.startsWith(`${PUBLIC_BUCKET_PREFIXES.entryIp}:`)) {
    return PUBLIC_BUCKET_PREFIXES.entryIp;
  }
  if (bucketKey.startsWith(`${PUBLIC_BUCKET_PREFIXES.entryEmail}:`)) {
    return PUBLIC_BUCKET_PREFIXES.entryEmail;
  }
  if (bucketKey.startsWith(`${PUBLIC_BUCKET_PREFIXES.get}:`)) {
    return PUBLIC_BUCKET_PREFIXES.get;
  }
  return null;
}

/** SHA-256 of the normalized address. The raw email never becomes a key. */
export function hashEmailForBucket(normalizedEmail: string): Promise<string> {
  return hashOpaqueValue(normalizedEmail);
}

/**
 * The bucket used when the edge could not tell us who is calling.
 *
 * Previously an unknown address meant NO bucket and therefore no limit at all,
 * which turned "omit a header" into an unlimited-submission bypass. Behind
 * Cloudflare `CF-Connecting-IP` is always set and cannot be forged, so this
 * path should be unreachable in production — but a defence that depends on a
 * header being present is not a defence.
 *
 * Everyone unidentifiable therefore shares ONE bucket per event. That is
 * deliberately fail-closed: if the header ever stops arriving the flow throttles
 * hard and visibly, which is the failure mode you can diagnose, rather than
 * silently admitting everything.
 *
 * Kept per-event so unattributed traffic on one event cannot block another.
 */
const ANONYMOUS_SOURCE = 'anonymous';

function sourceOf(ipHash: string | null): string {
  return ipHash ?? ANONYMOUS_SOURCE;
}

/**
 * The public limiter.
 *
 * Four buckets with four different windows cannot share one fixed-window
 * counter instance, so this holds four — each a `PersistentRateLimiter` with
 * its own ceiling. They all persist to the same table; the key prefixes keep
 * them apart, exactly as `email:` and `ip:` keep the login buckets apart.
 */
export class PublicRateLimiter {
  private readonly getLimiter: PersistentRateLimiter;
  private readonly entryIpLimiter: PersistentRateLimiter;
  private readonly entryIpEmailLimiter: PersistentRateLimiter;
  private readonly entryEmailLimiter: PersistentRateLimiter;

  constructor(db: D1Database) {
    this.getLimiter = new PersistentRateLimiter(
      db,
      PUBLIC_GET_RATE_WINDOW_MS,
      PUBLIC_GET_RATE_MAX,
      publicBucketKind,
    );
    this.entryIpLimiter = new PersistentRateLimiter(
      db,
      PUBLIC_ENTRY_IP_RATE_WINDOW_MS,
      PUBLIC_ENTRY_IP_RATE_MAX,
      publicBucketKind,
    );
    this.entryIpEmailLimiter = new PersistentRateLimiter(
      db,
      PUBLIC_ENTRY_IP_EMAIL_RATE_WINDOW_MS,
      PUBLIC_ENTRY_IP_EMAIL_RATE_MAX,
      publicBucketKind,
    );
    this.entryEmailLimiter = new PersistentRateLimiter(
      db,
      PUBLIC_ENTRY_EMAIL_RATE_WINDOW_MS,
      PUBLIC_ENTRY_EMAIL_RATE_MAX,
      publicBucketKind,
    );
  }

  /**
   * Reading an event page.
   *
   * Every method here goes through `consume` — one statement that increments
   * and decides — rather than `check` then `record`. The two-step form admits
   * every concurrent caller that arrives before the first one has written, so
   * for an unauthenticated endpoint it is not a limiter at all.
   */
  async checkGet(ipHash: string | null, eventId: string): Promise<RateLimitVerdict> {
    return this.getLimiter.consume(
      `${PUBLIC_BUCKET_PREFIXES.get}:${sourceOf(ipHash)}:${eventId}`,
    );
  }

  /**
   * The address-only half of a submission, consumed BEFORE the body is parsed.
   *
   * Split from the email buckets on purpose: the email is not known until the
   * payload has been validated against the version, and making somebody's
   * cheapest defence wait for the most expensive step would let an attacker
   * spend the server's time before any limit applied.
   */
  async checkEntryIp(ipHash: string | null, eventId: string): Promise<RateLimitVerdict> {
    return this.entryIpLimiter.consume(
      `${PUBLIC_BUCKET_PREFIXES.entryIp}:${sourceOf(ipHash)}:${eventId}`,
    );
  }

  /**
   * The identity-aware half, consumed once the address is known.
   *
   * The composite bucket is consumed FIRST and its refusal returned before the
   * backstop is touched. Consuming both unconditionally would let an attacker
   * who is already blocked on the precise bucket keep burning the victim's
   * generous one — turning the control that protects the victim into the one
   * that locks them out.
   *
   * The two are separate limiters because their windows differ (ten minutes
   * against an hour) and one counter cannot carry two windows.
   */
  async checkEntryIdentity(
    ipHash: string | null,
    emailHash: string,
    eventId: string,
  ): Promise<RateLimitVerdict> {
    const composite = await this.entryIpEmailLimiter.consume(
      `${PUBLIC_BUCKET_PREFIXES.entryIpEmail}:${sourceOf(ipHash)}:${emailHash}:${eventId}`,
    );
    if (composite.limited) return composite;

    return this.entryEmailLimiter.consume(
      `${PUBLIC_BUCKET_PREFIXES.entryEmail}:${emailHash}:${eventId}`,
    );
  }

  /**
   * Clears an identity's backstop after a genuine registration.
   *
   * Mirrors the login limiter's reset-on-success. It matters for the lockout
   * case: once somebody has actually entered, the attempts spent getting there
   * are not evidence of abuse, and leaving them counted would let a failed
   * first try shorten a legitimate second one on another event.
   */
  async releaseIdentity(emailHash: string, eventId: string): Promise<void> {
    await this.entryEmailLimiter.reset([
      `${PUBLIC_BUCKET_PREFIXES.entryEmail}:${emailHash}:${eventId}`,
    ]);
  }

  /**
   * Bounded housekeeping, safe to call on any request.
   *
   * The public flow mints a row per distinct address, so without this the table
   * only ever grows. One sweep removes at most a fixed batch of windows that
   * can no longer block anybody.
   */
  async sweep(): Promise<number> {
    return this.getLimiter.sweepStale();
  }
}

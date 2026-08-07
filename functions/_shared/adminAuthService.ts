// Administrative authentication domain service.
//
// This is where the auth rules live. HTTP handlers only translate its results
// into responses; they contain no policy of their own. It has no dependency on
// React, on the frontend, or on the Request/Response objects themselves.

import type { AuthenticatedAdmin } from '../../shared/types';
import { normalizeEmail } from '../../shared/schemas';
import { AdminRepository, rowToAdminUser, type AdminUserRow } from './adminRepository';
import { SessionRepository } from './sessionRepository';
import { LoginRateLimiter, buildLoginBucketKeys } from './rateLimit';
import { DUMMY_PASSWORD_HASH, verifyPassword } from './password';
import { generateSessionToken, hashOpaqueValue, hashToken } from './tokens';
import { SESSION_TTL_MS, isoFromNow, nowIso, parseIso } from './auth';
import type { AdminUser } from '../../shared/types';

export type LoginOutcome =
  | { kind: 'ok'; admin: AdminUser; token: string; expiresAt: string; sessionId: string }
  | { kind: 'invalid_credentials' }
  | { kind: 'suspended' }
  | { kind: 'disabled' }
  | { kind: 'rate_limited'; retryAfterSeconds: number };

export type SessionOutcome =
  | { kind: 'valid'; admin: AuthenticatedAdmin; lastSeenAt: string | null }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | { kind: 'admin_suspended' }
  | { kind: 'admin_disabled' };

export interface LoginContext {
  email: string;
  password: string;
  userAgent?: string | null;
  clientIp?: string | null;
}

/**
 * `last_seen_at` is only rewritten when it is at least this stale. Without the
 * throttle every authenticated request would issue an UPDATE, turning a
 * read-only page poll (the dashboard polls every 4s) into a write storm.
 */
const LAST_SEEN_REFRESH_MS = 60_000;

export class AdminAuthService {
  private readonly admins: AdminRepository;
  private readonly sessions: SessionRepository;
  private readonly rateLimiter: LoginRateLimiter;

  constructor(
    db: D1Database,
    deps?: {
      admins?: AdminRepository;
      sessions?: SessionRepository;
      rateLimiter?: LoginRateLimiter;
    },
  ) {
    this.admins = deps?.admins ?? new AdminRepository(db);
    this.sessions = deps?.sessions ?? new SessionRepository(db);
    this.rateLimiter = deps?.rateLimiter ?? new LoginRateLimiter(db);
  }

  async login(context: LoginContext): Promise<LoginOutcome> {
    const normalizedEmail = normalizeEmail(context.email);
    const bucketKeys = await buildLoginBucketKeys(
      normalizedEmail,
      context.clientIp ?? null,
    );

    const verdict = await this.rateLimiter.check(bucketKeys);

    // The IP bucket is a HARD block: it stops volumetric guessing from one
    // source, and refusing before the KDF runs keeps that cheap to absorb.
    if (verdict.limitedKinds.includes('ip')) {
      return { kind: 'rate_limited', retryAfterSeconds: verdict.retryAfterSeconds };
    }

    // The email bucket is deliberately NOT a hard block. If it were, anyone who
    // knows an administrator's address could lock that person out on demand by
    // failing ten logins. Instead the request proceeds, and only a WRONG
    // password is refused below — a guesser never gets past it, while the real
    // admin (from an un-blocked IP, with the right password) always does.
    const emailBucketExhausted = verdict.limitedKinds.includes('email');

    const row = await this.admins.findByNormalizedEmail(normalizedEmail);

    // Always run a verification, even when the email is unknown, so the CPU
    // cost — and therefore the response time — does not disclose whether the
    // account exists.
    const passwordMatches = await verifyPassword(
      context.password,
      row?.password_hash ?? DUMMY_PASSWORD_HASH,
    );

    if (!row || !passwordMatches) {
      await this.rateLimiter.recordFailure(bucketKeys);
      if (emailBucketExhausted) {
        return { kind: 'rate_limited', retryAfterSeconds: verdict.retryAfterSeconds };
      }
      return { kind: 'invalid_credentials' };
    }

    // Status is only evaluated AFTER the password checks out. A caller who has
    // proved possession of the credentials learns nothing new from
    // "suspended", whereas returning it before verification would turn login
    // into an account-enumeration oracle.
    if (row.status === 'SUSPENDED') {
      await this.rateLimiter.recordFailure(bucketKeys);
      return { kind: 'suspended' };
    }
    if (row.status === 'DISABLED') {
      await this.rateLimiter.recordFailure(bucketKeys);
      return { kind: 'disabled' };
    }

    await this.rateLimiter.reset(bucketKeys);

    const token = generateSessionToken();
    const tokenHash = await hashToken(token);
    const expiresAt = isoFromNow(SESSION_TTL_MS);
    const ipHash = context.clientIp ? await hashOpaqueValue(context.clientIp) : null;

    const session = await this.sessions.create({
      adminUserId: row.id,
      tokenHash,
      expiresAt,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      ipHash,
    });

    const loginAt = nowIso();
    await this.admins.touchLastLogin(row.id, loginAt);

    return {
      kind: 'ok',
      admin: { ...rowToAdminUser(row), lastLoginAt: loginAt, updatedAt: loginAt },
      token,
      expiresAt,
      sessionId: session.id,
    };
  }

  /**
   * Resolves a plaintext session token to its owner, or explains precisely why
   * it is not usable. Never throws for untrusted input.
   */
  async validateSessionToken(token: string | null): Promise<SessionOutcome> {
    if (!token) return { kind: 'missing' };

    const tokenHash = await hashToken(token);
    const row = await this.sessions.findByTokenHashWithAdmin(tokenHash);
    if (!row) return { kind: 'invalid' };

    if (row.revoked_at) return { kind: 'revoked' };

    const expiresAtMs = parseIso(row.expires_at);
    if (expiresAtMs === null || expiresAtMs <= Date.now()) {
      return { kind: 'expired' };
    }

    // Status is re-read from the JOIN on every request, so suspending an admin
    // takes effect immediately for sessions that already exist.
    if (row.admin_status === 'SUSPENDED') return { kind: 'admin_suspended' };
    if (row.admin_status === 'DISABLED') return { kind: 'admin_disabled' };

    return {
      kind: 'valid',
      lastSeenAt: row.last_seen_at,
      admin: {
        id: row.admin_user_id,
        email: row.admin_email,
        displayName: row.admin_display_name,
        role: row.admin_role,
        status: row.admin_status,
        sessionId: row.id,
      },
    };
  }

  /** Refreshes `last_seen_at`, throttled (see LAST_SEEN_REFRESH_MS). */
  async touchSession(sessionId: string, lastSeenAt: string | null): Promise<void> {
    const previous = parseIso(lastSeenAt);
    if (previous !== null && Date.now() - previous < LAST_SEEN_REFRESH_MS) return;
    await this.sessions.touchLastSeen(sessionId);
  }

  /**
   * Revokes the session behind a token. Idempotent: an unknown, already
   * revoked or expired token is a no-op that still reports success, so a
   * client can always clear its cookie safely.
   */
  async logout(token: string | null): Promise<{ revoked: boolean }> {
    if (!token) return { revoked: false };
    const tokenHash = await hashToken(token);
    const row = await this.sessions.findByTokenHashWithAdmin(tokenHash);
    if (!row || row.revoked_at) return { revoked: false };
    await this.sessions.revokeById(row.id);
    return { revoked: true };
  }

  /** Exposed for handlers that need the repositories directly. */
  get repositories(): { admins: AdminRepository; sessions: SessionRepository } {
    return { admins: this.admins, sessions: this.sessions };
  }

  /** Best-effort housekeeping, safe to run under `waitUntil`. */
  async purgeExpired(retentionMs: number = SESSION_TTL_MS): Promise<void> {
    const cutoff = new Date(Date.now() - retentionMs).toISOString();
    await this.sessions.deleteExpiredBefore(cutoff);
    await this.rateLimiter.purgeStale();
  }
}

export type { AdminUserRow };

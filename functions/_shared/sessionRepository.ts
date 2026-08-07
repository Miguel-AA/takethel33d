// Persistence for `admin_sessions`.
//
// Every session belongs to an `admin_user_id` (NOT NULL + FK), so an
// unattributed session cannot exist. D1 stores only `token_hash`.
//
// Lookups are deliberately UNFILTERED: `findByTokenHashWithAdmin` returns the
// row whatever its state, and AdminAuthService decides whether it is expired,
// revoked or owned by an inactive admin. Filtering in SQL would collapse those
// cases into a single "not found" and make them untestable and undiagnosable.

import type { AdminRole, AdminSession, AdminStatus } from '../../shared/types';
import { nowIso } from './auth';

export interface AdminSessionRow {
  id: string;
  admin_user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  user_agent: string | null;
  ip_hash: string | null;
}

/** A session joined with its owner, as returned by the validation query. */
export interface AdminSessionWithAdminRow extends AdminSessionRow {
  admin_email: string;
  admin_display_name: string;
  admin_role: AdminRole;
  admin_status: AdminStatus;
}

export const ADMIN_SESSION_COLUMNS = `id, admin_user_id, token_hash, created_at, expires_at,
  revoked_at, last_seen_at, user_agent, ip_hash`;

export function rowToAdminSession(row: AdminSessionRow): AdminSession {
  return {
    id: row.id,
    adminUserId: row.admin_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
  };
}

export interface CreateSessionInput {
  adminUserId: string;
  tokenHash: string;
  expiresAt: string;
  userAgent?: string | null;
  ipHash?: string | null;
}

export class SessionRepository {
  constructor(private readonly db: D1Database) {}

  async create(input: CreateSessionInput): Promise<AdminSession> {
    const timestamp = nowIso();
    const row = await this.db
      .prepare(
        `INSERT INTO admin_sessions
           (id, admin_user_id, token_hash, created_at, expires_at, last_seen_at, user_agent, ip_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING ${ADMIN_SESSION_COLUMNS}`,
      )
      .bind(
        crypto.randomUUID(),
        input.adminUserId,
        input.tokenHash,
        timestamp,
        input.expiresAt,
        timestamp,
        input.userAgent ?? null,
        input.ipHash ?? null,
      )
      .first<AdminSessionRow>();
    if (!row) throw new Error('Session insert returned no row');
    return rowToAdminSession(row);
  }

  /** Returns the session and its owner regardless of state (see file header). */
  async findByTokenHashWithAdmin(
    tokenHash: string,
  ): Promise<AdminSessionWithAdminRow | null> {
    return this.db
      .prepare(
        `SELECT s.id, s.admin_user_id, s.token_hash, s.created_at, s.expires_at,
                s.revoked_at, s.last_seen_at, s.user_agent, s.ip_hash,
                a.email        AS admin_email,
                a.display_name AS admin_display_name,
                a.role         AS admin_role,
                a.status       AS admin_status
         FROM admin_sessions s
         JOIN admin_users a ON a.id = s.admin_user_id
         WHERE s.token_hash = ?
         LIMIT 1`,
      )
      .bind(tokenHash)
      .first<AdminSessionWithAdminRow>();
  }

  async findById(id: string): Promise<AdminSessionRow | null> {
    return this.db
      .prepare(`SELECT ${ADMIN_SESSION_COLUMNS} FROM admin_sessions WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<AdminSessionRow>();
  }

  /**
   * Marks a session revoked. Idempotent: an already-revoked session keeps its
   * original `revoked_at`, so the first revocation timestamp stays truthful.
   */
  async revokeById(id: string, at: string = nowIso()): Promise<void> {
    await this.db
      .prepare('UPDATE admin_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .bind(at, id)
      .run();
  }

  /** Revokes every live session of an admin (e.g. on suspension). */
  async revokeAllForAdmin(adminUserId: string, at: string = nowIso()): Promise<void> {
    await this.db
      .prepare(
        'UPDATE admin_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL',
      )
      .bind(at, adminUserId)
      .run();
  }

  async touchLastSeen(id: string, at: string = nowIso()): Promise<void> {
    await this.db
      .prepare('UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?')
      .bind(at, id)
      .run();
  }

  /**
   * Housekeeping: drops sessions that expired long ago. `revoked_at` is kept
   * for traceability while the session is still within the retention window,
   * so revocation is never represented by deletion alone.
   */
  async deleteExpiredBefore(cutoffIso: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM admin_sessions WHERE expires_at < ?')
      .bind(cutoffIso)
      .run();
  }
}

// Persistence for `admin_users`.
//
// The row type carries `password_hash`; the public type (`AdminUser`) does not.
// `rowToAdminUser` is the ONLY bridge between them, so a hash cannot reach an
// API response by accident — every public path goes through this mapper.

import type { AdminRole, AdminStatus, AdminUser } from '../../shared/types';
import { nowIso } from './auth';

export interface AdminUserRow {
  id: string;
  email: string;
  normalized_email: string;
  display_name: string;
  password_hash: string;
  role: AdminRole;
  status: AdminStatus;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  password_changed_at: string;
}

/** Every column of `admin_users`, INCLUDING the hash. Internal use only. */
export const ADMIN_USER_COLUMNS = `id, email, normalized_email, display_name, password_hash,
  role, status, created_at, updated_at, last_login_at, password_changed_at`;

/** Strips every secret. The result is safe to serialize into a response. */
export function rowToAdminUser(row: AdminUserRow): AdminUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

export type CreateAdminResult =
  | { kind: 'created'; admin: AdminUser }
  | { kind: 'email_exists' };

export interface CreateAdminInput {
  email: string;
  normalizedEmail: string;
  displayName: string;
  passwordHash: string;
  role?: AdminRole;
  status?: AdminStatus;
}

export class AdminRepository {
  constructor(private readonly db: D1Database) {}

  async findByNormalizedEmail(normalizedEmail: string): Promise<AdminUserRow | null> {
    return this.db
      .prepare(
        `SELECT ${ADMIN_USER_COLUMNS} FROM admin_users WHERE normalized_email = ? LIMIT 1`,
      )
      .bind(normalizedEmail)
      .first<AdminUserRow>();
  }

  async findById(id: string): Promise<AdminUserRow | null> {
    return this.db
      .prepare(`SELECT ${ADMIN_USER_COLUMNS} FROM admin_users WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<AdminUserRow>();
  }

  async getStatus(id: string): Promise<AdminStatus | null> {
    const row = await this.db
      .prepare('SELECT status FROM admin_users WHERE id = ? LIMIT 1')
      .bind(id)
      .first<{ status: AdminStatus }>();
    return row?.status ?? null;
  }

  async create(input: CreateAdminInput): Promise<CreateAdminResult> {
    const existing = await this.findByNormalizedEmail(input.normalizedEmail);
    if (existing) return { kind: 'email_exists' };

    const timestamp = nowIso();
    try {
      const row = await this.db
        .prepare(
          `INSERT INTO admin_users
             (id, email, normalized_email, display_name, password_hash,
              role, status, created_at, updated_at, password_changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING ${ADMIN_USER_COLUMNS}`,
        )
        .bind(
          crypto.randomUUID(),
          input.email,
          input.normalizedEmail,
          input.displayName,
          input.passwordHash,
          input.role ?? 'ADMIN',
          input.status ?? 'ACTIVE',
          timestamp,
          timestamp,
          timestamp,
        )
        .first<AdminUserRow>();
      if (!row) throw new Error('Insert returned no row');
      return { kind: 'created', admin: rowToAdminUser(row) };
    } catch (err) {
      // The UNIQUE index on normalized_email is the authoritative guard; the
      // pre-check above only produces a friendlier result in the common case.
      const message = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(message) && /normalized_email/i.test(message)) {
        return { kind: 'email_exists' };
      }
      throw err;
    }
  }

  async touchLastLogin(id: string, at: string = nowIso()): Promise<void> {
    await this.db
      .prepare('UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?')
      .bind(at, at, id)
      .run();
  }
}

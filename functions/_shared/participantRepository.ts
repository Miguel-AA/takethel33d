// Persistence for `participants`.
//
// Mutating statements are returned PREPARED, never executed, so the caller can
// commit them in one `db.batch()` together with the entry, its answers and the
// audit row. A participant created without the entry that justified creating
// them would be a person who appears in the system for no reason.
//
// There is NO delete. An identity with entries behind it is what makes those
// entries mean anything; removing it is a policy decision nobody has made yet,
// and a method that exists is a method something will eventually call.

import type { Participant } from '../../shared/types';
import {
  PARTICIPANT_EMAIL_MAX_LENGTH,
  PARTICIPANT_NAME_MAX_LENGTH,
  PARTICIPANT_PHONE_MAX_LENGTH,
} from '../../shared/limits';
import { isCivilDate, isIsoTimestamp } from './time';

export interface ParticipantRow {
  id: string;
  email: string;
  normalized_email: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  date_of_birth: string | null;
  created_at: string;
  updated_at: string;
}

const PARTICIPANT_COLUMNS = `id, email, normalized_email, first_name, last_name,
  phone, date_of_birth, created_at, updated_at`;

function assertTimestamp(value: string, field: string): string {
  if (!isIsoTimestamp(value)) {
    throw new TypeError(`participants.${field} is not a canonical ISO timestamp: ${value}`);
  }
  return value;
}

function assertBounded(value: string, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`participants.${field} is empty or over its limit`);
  }
  return value;
}

/**
 * Maps a row to the domain shape.
 *
 * Strict on purpose, exactly like every other mapper here: a malformed date of
 * birth, an un-normalized email or a naive timestamp THROWS rather than flowing
 * onward. The column CHECKs are the first line of defence; this is the second,
 * for rows a migration, a console session or a future bug could have written.
 * A date of birth that is not a real day would otherwise reach the eligibility
 * phase and silently decide whether somebody is old enough.
 */
export function rowToParticipant(row: ParticipantRow): Participant {
  if (!row.id) throw new TypeError('participants row is missing its identifier');

  assertBounded(row.email, 'email', PARTICIPANT_EMAIL_MAX_LENGTH);
  assertBounded(row.normalized_email, 'normalized_email', PARTICIPANT_EMAIL_MAX_LENGTH);
  if (row.normalized_email !== row.normalized_email.toLowerCase()) {
    throw new TypeError('participants.normalized_email is not in canonical form');
  }
  assertBounded(row.first_name, 'first_name', PARTICIPANT_NAME_MAX_LENGTH);
  assertBounded(row.last_name, 'last_name', PARTICIPANT_NAME_MAX_LENGTH);

  if (row.phone !== null) {
    assertBounded(row.phone, 'phone', PARTICIPANT_PHONE_MAX_LENGTH);
  }
  if (row.date_of_birth !== null && !isCivilDate(row.date_of_birth)) {
    throw new TypeError(
      `participants.date_of_birth is not a real calendar date: ${row.date_of_birth}`,
    );
  }

  return {
    id: row.id,
    email: row.email,
    normalizedEmail: row.normalized_email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    dateOfBirth: row.date_of_birth,
    createdAt: assertTimestamp(row.created_at, 'created_at'),
    updatedAt: assertTimestamp(row.updated_at, 'updated_at'),
  };
}

export interface ParticipantInsertValues {
  id: string;
  email: string;
  normalizedEmail: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  dateOfBirth: string | null;
  at: string;
}

export interface ParticipantProfileUpdate {
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  dateOfBirth: string | null;
  at: string;
}

export class ParticipantRepository {
  constructor(private readonly db: D1Database) {}

  async findById(id: string): Promise<Participant | null> {
    const row = await this.db
      .prepare(`SELECT ${PARTICIPANT_COLUMNS} FROM participants WHERE id = ? LIMIT 1`)
      .bind(id)
      .first<ParticipantRow>();
    return row ? rowToParticipant(row) : null;
  }

  /**
   * The identity lookup.
   *
   * `normalized_email` is the whole identity model in this phase: one address,
   * one participant. The caller must pass an already-normalized value — this is
   * not the place to normalize, because a lookup that normalizes differently
   * from the write is a lookup that silently misses.
   */
  async findByNormalizedEmail(normalizedEmail: string): Promise<Participant | null> {
    const row = await this.db
      .prepare(
        `SELECT ${PARTICIPANT_COLUMNS} FROM participants
         WHERE normalized_email = ? LIMIT 1`,
      )
      .bind(normalizedEmail)
      .first<ParticipantRow>();
    return row ? rowToParticipant(row) : null;
  }

  insertStatement(values: ParticipantInsertValues): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO participants
           (id, email, normalized_email, first_name, last_name, phone,
            date_of_birth, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        values.id,
        values.email,
        values.normalizedEmail,
        values.firstName,
        values.lastName,
        values.phone,
        values.dateOfBirth,
        values.at,
        values.at,
      );
  }

  /**
   * Refreshes the profile of an identity that already exists.
   *
   * `normalized_email` is NOT updatable: it is the identity, and changing it
   * would silently turn one person into another while leaving their old entries
   * attached. The presentable `email` may be refreshed, because how somebody
   * capitalises their own address is presentation, not identity.
   *
   * `phone` and `date_of_birth` use COALESCE so a form that did not ask cannot
   * erase what an earlier one recorded. A CONFLICTING date of birth never
   * reaches here — the service refuses the whole submission first, because
   * silently keeping one of two different birthdays is a decision no code
   * should make on a person's behalf.
   */
  updateProfileStatement(id: string, values: ParticipantProfileUpdate): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE participants
            SET email = ?,
                first_name = ?,
                last_name = ?,
                phone = COALESCE(?, phone),
                date_of_birth = COALESCE(?, date_of_birth),
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(
        values.email,
        values.firstName,
        values.lastName,
        values.phone,
        values.dateOfBirth,
        values.at,
        id,
      );
  }

  async count(): Promise<number> {
    const row = await this.db
      .prepare('SELECT COUNT(*) AS total FROM participants')
      .first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  /**
   * Identities, newest first.
   *
   * Not exposed by any endpoint in this phase — administration across events is
   * a later concern — but the domain is complete without waiting for it, and
   * the listing is what a future participant screen reads.
   */
  async list(query: {
    page: number;
    pageSize: number;
  }): Promise<{ items: Participant[]; total: number }> {
    const total = await this.count();
    const rows = await this.db
      .prepare(
        `SELECT ${PARTICIPANT_COLUMNS} FROM participants
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(query.pageSize, (query.page - 1) * query.pageSize)
      .all<ParticipantRow>();
    return { items: (rows.results ?? []).map(rowToParticipant), total };
  }
}

import type { RegisterRequest, Attendee } from '../../shared/types';
import { rowToAttendeeIso, type AttendeeRow } from './db';

export type InsertAttendeeResult =
  | { kind: 'inserted'; attendee: Attendee }
  | { kind: 'email_exists' }
  | { kind: 'idempotent'; attendee: Attendee };

/**
 * Atomically assigns the next participant_number and inserts an attendee
 * (now an insurance lead). Handles UNIQUE collisions on participant_number
 * with a small retry loop.
 *
 * If `jotformSubmissionId` is provided and a row already exists for it,
 * returns `{ kind: 'idempotent' }` without inserting — this lets the
 * Jotform webhook be safely re-delivered.
 */
export async function insertAttendee(
  db: D1Database,
  data: RegisterRequest,
  jotformSubmissionId?: string,
): Promise<InsertAttendeeResult> {
  if (jotformSubmissionId) {
    const existing = await db
      .prepare(
        `SELECT id, participant_number, nombre, email, telefono, insurance_type, created_at
         FROM attendees WHERE jotform_submission_id = ? LIMIT 1`,
      )
      .bind(jotformSubmissionId)
      .first<AttendeeRow>();
    if (existing) {
      return { kind: 'idempotent', attendee: rowToAttendeeIso(existing) };
    }
  }

  const emailDup = await db
    .prepare('SELECT id FROM attendees WHERE email = ? COLLATE NOCASE LIMIT 1')
    .bind(data.email)
    .first<{ id: string }>();
  if (emailDup) return { kind: 'email_exists' };

  const id = crypto.randomUUID();
  const MAX_RETRIES = 5;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const next = await db
      .prepare(
        'SELECT COALESCE(MAX(participant_number), 0) + 1 AS next FROM attendees',
      )
      .first<{ next: number }>();
    const participantNumber = next?.next ?? 1;
    try {
      const insert = await db
        .prepare(
          `INSERT INTO attendees (id, participant_number, nombre, email, telefono,
                                  insurance_type, jotform_submission_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING id, participant_number, nombre, email, telefono, insurance_type, created_at`,
        )
        .bind(
          id,
          participantNumber,
          data.nombre,
          data.email,
          data.telefono,
          data.insuranceType,
          jotformSubmissionId ?? null,
        )
        .first<AttendeeRow>();
      if (!insert) throw new Error('Insert returned no row');
      return { kind: 'inserted', attendee: rowToAttendeeIso(insert) };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/UNIQUE/i.test(msg) && /participant_number/i.test(msg)) continue;
      if (/UNIQUE/i.test(msg) && /email/i.test(msg)) {
        return { kind: 'email_exists' };
      }
      if (/UNIQUE/i.test(msg) && /jotform_submission/i.test(msg)) {
        if (jotformSubmissionId) {
          const existing = await db
            .prepare(
              `SELECT id, participant_number, nombre, email, telefono, insurance_type, created_at
               FROM attendees WHERE jotform_submission_id = ? LIMIT 1`,
            )
            .bind(jotformSubmissionId)
            .first<AttendeeRow>();
          if (existing) {
            return { kind: 'idempotent', attendee: rowToAttendeeIso(existing) };
          }
        }
      }
      throw err;
    }
  }
  throw lastErr ?? new Error('Could not assign participant number');
}

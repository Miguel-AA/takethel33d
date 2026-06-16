import type { RegisterRequest, Attendee } from '../../shared/types';
import { ATTENDEE_COLUMNS, rowToAttendeeIso, type AttendeeRow } from './db';

export type InsertAttendeeResult =
  | { kind: 'inserted'; attendee: Attendee }
  | { kind: 'email_exists' };

/**
 * Atomically assigns the next participant_number and inserts a lead captured
 * through the app's own /events flow. Handles UNIQUE collisions on
 * participant_number with a small retry loop.
 */
export async function insertAttendee(
  db: D1Database,
  data: RegisterRequest,
): Promise<InsertAttendeeResult> {
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
          `INSERT INTO attendees (id, participant_number, first_name, last_name, email, phone,
                                  highest_level_of_education, age, zip, city,
                                  housing_status, owns_vehicle, is_business_owner)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING ${ATTENDEE_COLUMNS}`,
        )
        .bind(
          id,
          participantNumber,
          data.firstName,
          data.lastName,
          data.email,
          data.phone,
          data.highestLevelOfEducation,
          data.age,
          data.zip,
          data.city ?? null,
          data.housingStatus,
          data.ownsVehicle ? 1 : 0,
          data.isBusinessOwner ? 1 : 0,
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
      throw err;
    }
  }
  throw lastErr ?? new Error('Could not assign participant number');
}

import type { Attendee, InsuranceType } from '@shared/types';

export interface AttendeeRow {
  id: string;
  participant_number: number;
  nombre: string;
  email: string;
  telefono: string;
  insurance_type: InsuranceType;
  created_at: string;
}

export function rowToAttendee(row: AttendeeRow): Attendee {
  return {
    id: row.id,
    participantNumber: row.participant_number,
    nombre: row.nombre,
    email: row.email,
    telefono: row.telefono,
    insuranceType: row.insurance_type,
    createdAt: row.created_at,
  };
}

// SQLite stores `datetime('now')` without a trailing Z; normalize to ISO UTC.
export function sqliteToIso(value: string): string {
  if (!value) return value;
  if (value.endsWith('Z')) return value;
  return value.replace(' ', 'T') + 'Z';
}

export function rowToAttendeeIso(row: AttendeeRow): Attendee {
  const a = rowToAttendee(row);
  a.createdAt = sqliteToIso(a.createdAt);
  return a;
}

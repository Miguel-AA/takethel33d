import type { Attendee, EducationLevel, HousingStatus } from '../../shared/types';

export interface AttendeeRow {
  id: string;
  participant_number: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  highest_level_of_education: EducationLevel | null;
  age: number | null;
  zip: string | null;
  city: string | null;
  housing_status: HousingStatus | null;
  owns_vehicle: number | null;
  is_business_owner: number | null;
  created_at: string;
}

// Canonical attendee column list, shared by every SELECT/RETURNING so the
// projection always matches `AttendeeRow`.
export const ATTENDEE_COLUMNS = `id, participant_number, first_name, last_name, email, phone,
  highest_level_of_education, age, zip, city, housing_status, owns_vehicle, is_business_owner, created_at`;

function boolFromInt(value: number | null): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  return value === 1;
}

export function rowToAttendee(row: AttendeeRow): Attendee {
  return {
    id: row.id,
    participantNumber: row.participant_number,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    highestLevelOfEducation: row.highest_level_of_education ?? undefined,
    age: row.age ?? undefined,
    zip: row.zip ?? undefined,
    city: row.city ?? undefined,
    housingStatus: row.housing_status ?? undefined,
    ownsVehicle: boolFromInt(row.owns_vehicle),
    isBusinessOwner: boolFromInt(row.is_business_owner),
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

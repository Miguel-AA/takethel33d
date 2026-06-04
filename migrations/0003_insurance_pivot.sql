-- Pivot the app from event registration to insurance lead capture.
-- The required fields are now: name, phone, email, insurance type.
-- Event-specific columns (genero, edad, institucion, carrera, nivel_academico)
-- are dropped. Existing rows cannot be migrated — they're cleared.

DELETE FROM raffle_draws;
DROP TABLE IF EXISTS attendees;

CREATE TABLE attendees (
  id TEXT PRIMARY KEY,
  participant_number INTEGER NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telefono TEXT NOT NULL,
  insurance_type TEXT NOT NULL CHECK (insurance_type IN ('HOUSE','AUTO','LIFE')),
  jotform_submission_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_attendees_email ON attendees(email);
CREATE INDEX idx_attendees_number ON attendees(participant_number);
CREATE INDEX idx_attendees_created ON attendees(created_at);
CREATE INDEX idx_attendees_insurance_type ON attendees(insurance_type);
CREATE UNIQUE INDEX idx_attendees_jotform_submission
  ON attendees(jotform_submission_id)
  WHERE jotform_submission_id IS NOT NULL;

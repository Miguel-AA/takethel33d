-- Migrate `attendees` from the insurance-lead shape to the general /events
-- lead shape collected by the app's own multi-step form.
--
--   * `nombre`           -> split into `first_name` / `last_name`
--   * `telefono`         -> renamed `phone`
--   * `insurance_type`   -> dropped (no longer collected)
--   * `jotform_submission_id` -> dropped (Jotform is no longer used)
--   * adds survey columns: highest_level_of_education, age, zip, city,
--     housing_status, owns_vehicle, is_business_owner
--
-- All new survey columns are NULLABLE so existing rows migrate without data
-- loss. Existing ids are preserved, so raffle_draws.attendee_id stays valid.

PRAGMA foreign_keys=OFF;

CREATE TABLE attendees_new (
  id TEXT PRIMARY KEY,
  participant_number INTEGER NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  phone TEXT NOT NULL,
  highest_level_of_education TEXT CHECK (
    highest_level_of_education IN
      ('HIGH_SCHOOL','SOME_COLLEGE','ASSOCIATE','BACHELORS','MASTERS','DOCTORATE','OTHER')
  ),
  age INTEGER,
  zip TEXT,
  city TEXT,
  housing_status TEXT CHECK (housing_status IN ('OWNER','RENTER')),
  owns_vehicle INTEGER CHECK (owns_vehicle IN (0,1)),
  is_business_owner INTEGER CHECK (is_business_owner IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Carry forward existing rows. `nombre` is split on the first space: everything
-- before it becomes first_name, the remainder (if any) becomes last_name.
INSERT INTO attendees_new (id, participant_number, first_name, last_name, email, phone, created_at)
SELECT
  id,
  participant_number,
  TRIM(substr(nombre, 1,
    CASE WHEN instr(nombre, ' ') = 0 THEN length(nombre) ELSE instr(nombre, ' ') - 1 END)),
  TRIM(CASE WHEN instr(nombre, ' ') = 0 THEN '' ELSE substr(nombre, instr(nombre, ' ') + 1) END),
  email,
  telefono,
  created_at
FROM attendees;

DROP TABLE attendees;
ALTER TABLE attendees_new RENAME TO attendees;

CREATE INDEX idx_attendees_email ON attendees(email);
CREATE INDEX idx_attendees_number ON attendees(participant_number);
CREATE INDEX idx_attendees_created ON attendees(created_at);

PRAGMA foreign_keys=ON;

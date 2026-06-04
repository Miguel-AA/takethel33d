-- Gifted Grads Events — D1 schema
-- Apply with: wrangler d1 migrations apply DB

CREATE TABLE IF NOT EXISTS attendees (
  id TEXT PRIMARY KEY,
  participant_number INTEGER NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  telefono TEXT NOT NULL,
  genero TEXT NOT NULL CHECK (genero IN ('M','F','OTRO','PREFIERO_NO_DECIR')),
  edad INTEGER NOT NULL,
  institucion TEXT NOT NULL,
  carrera TEXT NOT NULL,
  nivel_academico TEXT NOT NULL CHECK (nivel_academico IN ('SECUNDARIA','PREGRADO','POSGRADO','OTRO')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attendees_email ON attendees(email);
CREATE INDEX IF NOT EXISTS idx_attendees_number ON attendees(participant_number);
CREATE INDEX IF NOT EXISTS idx_attendees_created ON attendees(created_at);

CREATE TABLE IF NOT EXISTS manager_sessions (
  token TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raffle_draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attendee_id TEXT NOT NULL REFERENCES attendees(id),
  drawn_at TEXT NOT NULL DEFAULT (datetime('now')),
  mode TEXT NOT NULL CHECK (mode IN ('random','manual'))
);

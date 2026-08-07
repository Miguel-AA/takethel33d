-- Administrative identity and attributable sessions.
--
-- Replaces the single shared `MANAGER_PASSWORD` + anonymous `manager_sessions`
-- model with individual admin accounts whose sessions can always be traced back
-- to a person.
--
-- Timestamp convention for these tables: ISO-8601 UTC with milliseconds
-- (`YYYY-MM-DDTHH:MM:SS.sssZ`), identical to JavaScript's `toISOString()`. It is
-- fixed-width, so lexicographic comparison in SQL equals chronological order —
-- which the expiry and rate-limit queries depend on. This intentionally differs
-- from the older tables' `datetime('now')` (space-separated, no zone marker);
-- pre-existing tables are left untouched.
--
-- Tables not related to authentication (attendees, raffle_draws) are NOT
-- touched by this migration.

-- ---------------------------------------------------------------------------
-- Administrators
-- ---------------------------------------------------------------------------
-- NOT NULL alone would still admit the empty string, which for a credential
-- column is a silent trapdoor (an empty hash, an empty identity). Every
-- identity-bearing column therefore also asserts non-emptiness, so a malformed
-- row cannot be created by any path — application, script or manual SQL.
CREATE TABLE admin_users (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  -- Presentable form, as typed by the operator (e.g. "Ana.Lopez@Example.com").
  email TEXT NOT NULL CHECK (length(email) > 0),
  -- Canonical form (trimmed + lowercased). Carries the uniqueness guarantee.
  normalized_email TEXT NOT NULL CHECK (length(normalized_email) > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  -- Encoded PBKDF2-HMAC-SHA256 digest: pbkdf2-sha256$<iters>$<salt>$<hash>.
  -- Never a plaintext or reversible value.
  password_hash TEXT NOT NULL CHECK (length(password_hash) > 0),
  role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DISABLED')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT,
  password_changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Case-insensitive uniqueness is enforced through `normalized_email`, which the
-- application always writes lowercased, rather than through COLLATE NOCASE.
CREATE UNIQUE INDEX idx_admin_users_normalized_email
  ON admin_users(normalized_email);
CREATE INDEX idx_admin_users_status ON admin_users(status);

-- ---------------------------------------------------------------------------
-- Attributable sessions
-- ---------------------------------------------------------------------------
CREATE TABLE admin_sessions (
  id TEXT PRIMARY KEY,
  -- NOT NULL + FK: a session without an actor cannot be represented.
  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  -- SHA-256 of the session token. The plaintext token is never stored.
  token_hash TEXT NOT NULL CHECK (length(token_hash) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL CHECK (length(expires_at) > 0),
  -- Revocation is a timestamp, not a deletion, so a revoked session remains
  -- visible for basic traceability until it is purged.
  revoked_at TEXT,
  last_seen_at TEXT,
  user_agent TEXT,
  -- SHA-256 of the client IP. The raw address is never persisted.
  ip_hash TEXT
);

CREATE UNIQUE INDEX idx_admin_sessions_token_hash ON admin_sessions(token_hash);
CREATE INDEX idx_admin_sessions_admin_user ON admin_sessions(admin_user_id);
CREATE INDEX idx_admin_sessions_expires ON admin_sessions(expires_at);
CREATE INDEX idx_admin_sessions_revoked ON admin_sessions(revoked_at);

-- ---------------------------------------------------------------------------
-- Persistent login rate limiting
-- ---------------------------------------------------------------------------
-- Replaces the per-isolate in-memory Map, which was not shared across isolates
-- and therefore provided no real protection. Keys are SHA-256 digests prefixed
-- with their type (`email:<sha256>` / `ip:<sha256>`) — no raw email or IP.
CREATE TABLE admin_login_attempts (
  bucket_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_admin_login_attempts_window
  ON admin_login_attempts(window_started_at);

-- ---------------------------------------------------------------------------
-- Legacy sessions
-- ---------------------------------------------------------------------------
-- `manager_sessions` rows were created by the shared-password flow and have no
-- owner. They CANNOT be converted into attributable sessions honestly, and
-- attaching them to a synthetic administrator would fabricate an audit trail.
-- They are therefore invalidated by dropping the table outright.
--
-- Operational consequence: every manager signed in at deploy time is signed
-- out and must authenticate again with an individual account created via
-- `npm run bootstrap:admin`. This is documented in README.md.
DROP TABLE IF EXISTS manager_sessions;

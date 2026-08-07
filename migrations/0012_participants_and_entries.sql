-- Participants, their entries into events, and the answers they gave.
--
-- Three tables because there are three different things, and collapsing any two
-- of them loses something that cannot be recovered later:
--
--   participants        WHO somebody is. Reusable across events.
--   event_entries       THAT they took part in one event, using one frozen
--                       version of its form.
--   event_entry_answers WHAT they answered, question by question.
--
-- The legacy `attendees` table is NOT touched and is NOT this. It belongs to the
-- older lead-capture flow and has no event, no form and no version.
--
-- Timestamps follow the phase 2 convention: ISO-8601 UTC with milliseconds,
-- written by the application, fixed width so ordering is chronological. Dates of
-- birth are CIVIL DATES (`YYYY-MM-DD`) — a birthday is the same day everywhere,
-- and turning one into an instant is what produces the off-by-one-day bug.

-- ---------------------------------------------------------------------------
-- Participants
-- ---------------------------------------------------------------------------
-- A reusable identity. The same person entering three events is ONE row here
-- and three rows in `event_entries`.
--
-- IDENTITY IN V1 IS THE EMAIL ADDRESS, and nothing more. One human with two
-- addresses is two participants, and this table does not pretend otherwise:
-- there is no fuzzy name matching, no phone-based merging and no household
-- heuristic, because every one of those silently merges two different people
-- sooner or later. The limitation is documented rather than disguised.
CREATE TABLE participants (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- Presentable form, as the person typed it ("Ana.Lopez@Example.com").
  email TEXT NOT NULL CHECK (length(email) > 0 AND length(email) <= 160),

  -- Canonical form (trimmed + lowercased). Carries the uniqueness guarantee,
  -- exactly as `admin_users.normalized_email` does — same convention, same
  -- reason: case-insensitive identity without relying on a collation.
  normalized_email TEXT NOT NULL CHECK (
    length(normalized_email) > 0 AND
    length(normalized_email) <= 160 AND
    normalized_email = lower(normalized_email) AND
    normalized_email NOT GLOB '* *'
  ),

  first_name TEXT NOT NULL CHECK (length(trim(first_name)) > 0 AND length(first_name) <= 80),
  last_name TEXT NOT NULL CHECK (length(trim(last_name)) > 0 AND length(last_name) <= 80),

  -- Optional: a form need not ask for it, and no phone verification exists.
  phone TEXT CHECK (phone IS NULL OR (length(trim(phone)) > 0 AND length(phone) <= 20)),

  -- Optional at the identity level: an event with no minimum age has no reason
  -- to ask. A civil date, never an instant. Age is NOT computed in this phase.
  --
  -- The CHECK can only assert the SHAPE. "Not in the future" is not expressible
  -- here: a CHECK constraint must be deterministic, and `date('now')` is not —
  -- SQLite refuses it, and a bound baked in at migration time would expire. So
  -- the rule lives where it can be enforced honestly, in the domain layer
  -- (`latestPossibleBirthDate`), and is tested there. A row written directly
  -- with a future date is therefore possible; it is a corruption the mapper
  -- deliberately still READS, because making an existing row unreadable turns a
  -- fixable data problem into a person who cannot be looked at at all.
  date_of_birth TEXT CHECK (
    date_of_birth IS NULL OR (
      length(date_of_birth) = 10 AND
      date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )
  ),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at LIKE '____-__-__T__:__:__.___Z')
);

CREATE UNIQUE INDEX idx_participants_normalized_email
  ON participants(normalized_email);
CREATE INDEX idx_participants_created_at ON participants(created_at DESC);
CREATE INDEX idx_participants_last_name ON participants(last_name, first_name);

-- ---------------------------------------------------------------------------
-- Entries
-- ---------------------------------------------------------------------------
-- One identity taking part in one event, bound to the exact form version they
-- were shown.
--
-- `form_version_id` is what makes an old submission still readable. Without it,
-- publishing a new version tomorrow would leave yesterday's answers pointing at
-- questions nobody was actually asked.
CREATE TABLE event_entries (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- RESTRICT throughout. An entry is a record that a person took part; nothing
  -- may delete it as a side effect of tidying up something else.
  event_id TEXT NOT NULL CHECK (length(event_id) > 0)
    REFERENCES events(id) ON DELETE RESTRICT,
  participant_id TEXT NOT NULL CHECK (length(participant_id) > 0)
    REFERENCES participants(id) ON DELETE RESTRICT,

  -- SQLite cannot say "and this version must belong to THAT event" — that needs
  -- a composite foreign key against (id, event_id). The application enforces it
  -- on every write and on every read, exactly as it does for
  -- `events.published_form_version_id`. See ParticipantRegistrationService.
  form_version_id TEXT NOT NULL CHECK (length(form_version_id) > 0)
    REFERENCES event_form_versions(id) ON DELETE RESTRICT,

  -- Deliberately NOT including WINNER / NON_WINNER: those belong to a draw that
  -- does not exist yet, and a status nothing can produce is a status that will
  -- be wrong when it finally does.
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (
    status IN ('SUBMITTED', 'ELIGIBLE', 'INELIGIBLE', 'DISQUALIFIED')
  ),

  -- Eligibility columns exist now and stay NULL until the next phase fills
  -- them. Adding them here rather than later means an entry's shape does not
  -- change under rows that already exist.
  calculated_age INTEGER CHECK (
    calculated_age IS NULL OR (calculated_age >= 0 AND calculated_age <= 130)
  ),
  age_eligible INTEGER CHECK (age_eligible IS NULL OR age_eligible IN (0, 1)),
  overall_eligible INTEGER CHECK (overall_eligible IS NULL OR overall_eligible IN (0, 1)),
  eligibility_reason TEXT CHECK (
    eligibility_reason IS NULL OR length(eligibility_reason) <= 200
  ),

  submitted_at TEXT NOT NULL
    CHECK (length(submitted_at) = 24 AND submitted_at LIKE '____-__-__T__:__:__.___Z'),
  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at LIKE '____-__-__T__:__:__.___Z'),

  -- Already hashed when it arrives; the raw address never reaches this layer.
  ip_hash TEXT CHECK (ip_hash IS NULL OR length(ip_hash) = 64),
  user_agent TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 512)
);

-- ONE participation per identity per event. This is the constraint the whole
-- duplicate-entry defence rests on: a precheck can lose a race, an index cannot.
CREATE UNIQUE INDEX idx_event_entries_event_participant
  ON event_entries(event_id, participant_id);

CREATE INDEX idx_event_entries_event ON event_entries(event_id, submitted_at DESC);
CREATE INDEX idx_event_entries_participant ON event_entries(participant_id);
CREATE INDEX idx_event_entries_version ON event_entries(form_version_id);
CREATE INDEX idx_event_entries_status ON event_entries(event_id, status);

-- ---------------------------------------------------------------------------
-- Answers
-- ---------------------------------------------------------------------------
-- One answer to one question. There is NO column named after any question a
-- client invents: "Do you smoke?" is a row here, keyed by `question_key`, and
-- adding it is a POST rather than a migration.
--
-- The snapshot columns duplicate what the immutable VERSION row already holds.
-- That is intentional and bounded: key, label and type are what an export, a
-- support conversation or a debugging session needs, and reading them should
-- not require joining three tables and hoping the join still resolves. Nothing
-- else is duplicated — description, placeholder and validation stay in the
-- version, where they cannot drift.
CREATE TABLE event_entry_answers (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  event_entry_id TEXT NOT NULL CHECK (length(event_entry_id) > 0)
    REFERENCES event_entries(id) ON DELETE RESTRICT,

  -- Points at a VERSION-owned question. The foreign key can only say "some
  -- question"; that it belongs to THIS entry's version is checked by the
  -- service, because `form_questions` is polymorphic and carries no composite
  -- key to lean on.
  question_id TEXT NOT NULL CHECK (length(question_id) > 0)
    REFERENCES form_questions(id) ON DELETE RESTRICT,

  -- Same shape as `form_questions.key`, for the same reason: it must survive an
  -- export header, a JSON key and a column name unchanged.
  question_key TEXT NOT NULL CHECK (
    length(question_key) > 0 AND length(question_key) <= 64 AND
    question_key = lower(question_key) AND
    question_key NOT GLOB '*[^a-z0-9_]*' AND
    question_key NOT GLOB '[^a-z]*'
  ),

  question_label_snapshot TEXT NOT NULL CHECK (
    length(trim(question_label_snapshot)) > 0 AND length(question_label_snapshot) <= 300
  ),

  -- Copied from the version's question, never chosen by the caller. INFORMATION
  -- is absent on purpose: copy collects nothing, so an answer to it cannot exist.
  answer_type TEXT NOT NULL CHECK (answer_type IN (
    'SHORT_TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'NUMBER',
    'YES_NO', 'SINGLE_SELECT', 'MULTI_SELECT', 'DROPDOWN', 'CONSENT'
  )),

  -- Canonical JSON: "John", 42, true, "option_value", ["one","two"].
  answer_value TEXT CHECK (answer_value IS NULL OR length(answer_value) <= 8000),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z')
);

-- A question produces at most one answer per entry. Two rows for one question
-- would make "what did they answer?" a question with two answers.
CREATE UNIQUE INDEX idx_entry_answers_entry_question
  ON event_entry_answers(event_entry_id, question_id);

CREATE INDEX idx_entry_answers_entry ON event_entry_answers(event_entry_id);
CREATE INDEX idx_entry_answers_question ON event_entry_answers(question_id);
CREATE INDEX idx_entry_answers_key ON event_entry_answers(question_key);

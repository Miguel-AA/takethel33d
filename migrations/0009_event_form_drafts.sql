-- The registration form, as data.
--
-- Nothing a client asks a participant is a column. "Do you smoke?" is a row in
-- `form_questions`; its answers are rows in `form_question_options`; where it
-- appears is an integer. Adding a question must never mean a migration, which
-- is the whole point of this phase.
--
-- Timestamps follow the phase 2 convention: ISO-8601 UTC with milliseconds,
-- written by the application, fixed width so ordering is chronological.

-- The working copy an administrator edits. Exactly one per event.
--
-- It is NOT what participants fill in: publishing (next phase) freezes a copy
-- into a version, and that is what goes live. Keeping the two apart is why a
-- draft can be edited while registration is open without changing the form
-- under anyone's feet.
CREATE TABLE event_form_drafts (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- RESTRICT, never CASCADE: an event that carries a form is configuration, not
  -- debris. Deleting it must fail loudly; archiving is how an event is retired.
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE RESTRICT,

  -- Optimistic concurrency for the WHOLE form. Every step, question and option
  -- mutation moves this number: two administrators editing one builder are
  -- editing one document, and a per-row token would let their changes
  -- interleave into something neither of them designed.
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),

  updated_by TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at LIKE '____-__-__T__:__:__.___Z')
);

CREATE INDEX idx_event_form_drafts_updated_at ON event_form_drafts(updated_at DESC);

-- A page of the wizard.
--
-- `form_owner_type` / `form_owner_id` are deliberately polymorphic: the same
-- rows describe a DRAFT today and a published VERSION next phase, so publishing
-- copies rows instead of migrating a table. The pair therefore cannot carry a
-- foreign key — its referent depends on the type, and one of the two tables
-- does not exist yet. The service never resolves a step except through the
-- draft it has already loaded, which is what keeps ownership honest.
CREATE TABLE form_steps (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  form_owner_type TEXT NOT NULL CHECK (form_owner_type IN ('DRAFT', 'VERSION')),
  form_owner_id TEXT NOT NULL CHECK (length(form_owner_id) > 0),

  title TEXT NOT NULL CHECK (length(trim(title)) > 0 AND length(title) <= 160),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),

  -- Ceiling is the reorder's parking offset plus the question limit; see
  -- FormRepository.reorderStatements for why it cannot be tighter.
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0 AND sort_order <= 1000200),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at LIKE '____-__-__T__:__:__.___Z')
);

CREATE INDEX idx_form_steps_owner ON form_steps(form_owner_type, form_owner_id);
CREATE UNIQUE INDEX idx_form_steps_position
  ON form_steps(form_owner_type, form_owner_id, sort_order);

-- One thing asked of a participant.
CREATE TABLE form_questions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  form_owner_type TEXT NOT NULL CHECK (form_owner_type IN ('DRAFT', 'VERSION')),
  form_owner_id TEXT NOT NULL CHECK (length(form_owner_id) > 0),

  -- RESTRICT: a step holding questions cannot be deleted out from under them.
  -- Emptying it first is the deliberate act.
  step_id TEXT NOT NULL REFERENCES form_steps(id) ON DELETE RESTRICT,

  -- The stable name an answer will be filed under. Lowercase snake_case so it
  -- survives an export header, a JSON key and a column name unchanged.
  --
  -- GLOB matches exactly one character per `[...]` and has no repetition
  -- operator, so the shape is expressed as two NEGATIVE patterns instead: no
  -- character outside the alphabet anywhere, and no first character that is not
  -- a letter. That is the whole rule, and it holds for a one-character key too.
  key TEXT NOT NULL CHECK (
    length(key) > 0 AND length(key) <= 64 AND
    key = lower(key) AND
    key NOT GLOB '*[^a-z0-9_]*' AND
    key NOT GLOB '[^a-z]*'
  ),

  -- The platform's own identities. `NONE` is every custom question a client
  -- invents; the named ones let later phases find "the email question" without
  -- guessing from a label.
  system_field TEXT NOT NULL DEFAULT 'NONE' CHECK (
    system_field IN ('FIRST_NAME', 'LAST_NAME', 'EMAIL', 'DATE_OF_BIRTH', 'PHONE', 'NONE')
  ),

  type TEXT NOT NULL CHECK (type IN (
    'SHORT_TEXT', 'LONG_TEXT', 'EMAIL', 'PHONE', 'DATE', 'NUMBER',
    'YES_NO', 'SINGLE_SELECT', 'MULTI_SELECT', 'DROPDOWN', 'CONSENT', 'INFORMATION'
  )),

  label TEXT NOT NULL CHECK (length(trim(label)) > 0 AND length(label) <= 300),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  placeholder TEXT CHECK (placeholder IS NULL OR length(placeholder) <= 160),

  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  exportable INTEGER NOT NULL DEFAULT 1 CHECK (exportable IN (0, 1)),

  sort_order INTEGER NOT NULL CHECK (sort_order >= 0 AND sort_order <= 1000200),

  -- Per-type constraints (lengths, bounds, how many may be selected), stored as
  -- JSON because their SHAPE depends on the type. Validated by the schema layer
  -- on the way in and re-validated by the mapper on the way out; NULL means
  -- "nothing configured".
  validation_config TEXT CHECK (validation_config IS NULL OR length(validation_config) <= 2000),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at LIKE '____-__-__T__:__:__.___Z'),

  -- Copy has no answer, so it can neither be required nor exported.
  CHECK (type <> 'INFORMATION' OR (required = 0 AND exportable = 0))
);

CREATE INDEX idx_form_questions_owner ON form_questions(form_owner_type, form_owner_id);
CREATE INDEX idx_form_questions_step ON form_questions(step_id);
CREATE INDEX idx_form_questions_active ON form_questions(form_owner_type, form_owner_id, active);

-- An answer key is unique within a form: two questions cannot file into one.
CREATE UNIQUE INDEX idx_form_questions_key
  ON form_questions(form_owner_type, form_owner_id, key);

-- Position is unique WITHIN A STEP. Moving a question to another step is
-- therefore a change of both columns, and the index keeps the destination's
-- ordering coherent.
CREATE UNIQUE INDEX idx_form_questions_position
  ON form_questions(step_id, sort_order);

-- A system field may appear at most ONCE per form. Partial, because 'NONE' is
-- the default that every custom question carries.
CREATE UNIQUE INDEX idx_form_questions_system_field
  ON form_questions(form_owner_type, form_owner_id, system_field)
  WHERE system_field <> 'NONE';

-- A choice offered for a select-style question.
CREATE TABLE form_question_options (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- RESTRICT: deleting a question deletes its options in the same batch, in
  -- that order. Nothing is ever silently discarded by the database.
  question_id TEXT NOT NULL REFERENCES form_questions(id) ON DELETE RESTRICT,

  -- What gets stored when chosen; the label is what gets read.
  value TEXT NOT NULL CHECK (
    length(value) > 0 AND length(value) <= 64 AND
    value = lower(value) AND
    value NOT GLOB '*[^a-z0-9_-]*' AND
    value NOT GLOB '[^a-z0-9]*'
  ),
  label TEXT NOT NULL CHECK (length(trim(label)) > 0 AND length(label) <= 200),

  sort_order INTEGER NOT NULL CHECK (sort_order >= 0 AND sort_order <= 1000200),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at LIKE '____-__-__T__:__:__.___Z')
);

CREATE INDEX idx_form_options_question ON form_question_options(question_id);
CREATE UNIQUE INDEX idx_form_options_value ON form_question_options(question_id, value);
CREATE UNIQUE INDEX idx_form_options_position ON form_question_options(question_id, sort_order);

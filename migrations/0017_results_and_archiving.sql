-- Publishing a result.
--
-- Phase 11 decided who won. This decides what the world is told, and it is the
-- second irreversible act in the system: a publication cannot be withdrawn. So
-- the schema is built the same way the draw's was — to make the wrong states
-- unrepresentable rather than merely discouraged.
--
-- WHY A SNAPSHOT AND NOT A VIEW. The obvious design renders the public page
-- from `draw_assignments` joined to `participants` on every request. It is
-- wrong for one reason: a participant can correct their name, and a prize can
-- be renamed, and neither of those may rewrite a result that was already
-- announced. A publication is a copy taken at one instant, and it never changes
-- afterwards — the same reasoning that put `question_label_snapshot` on an
-- answer and `prize_name_snapshot` on an assignment, applied one layer further
-- out.
--
-- THE CHAIN OF CUSTODY this completes:
--
--   event_prizes.name          what the prize is called today
--     → draw_assignments.prize_name_snapshot   what it was called when it was won
--       → result_publication_items.prize_name_snapshot   what was announced
--
-- Each link is a copy, so an edit at any point cannot travel forward.
--
-- WHAT THE DATABASE GUARANTEES:
--
--   * one publication per event               UNIQUE(event_id)
--   * one publication per draw                UNIQUE(draw_id)
--   * one item per assignment                 UNIQUE(publication_id, assignment_id)
--   * one item per position                   UNIQUE(publication_id, draw_order)
--   * a publication and its draw belong to the SAME event   composite FK
--   * an item and its assignment belong to the SAME draw     composite FK
--   * nothing that was published can be deleted              FK RESTRICT
--
-- ARCHIVING adds nothing here. `events.archived_at` has existed since 0001 and
-- `archive` has been a real transition with its own audit action since phase 3;
-- phase 12 gives it a screen, not a second definition. No `archived_by_admin_id`
-- column is added: `events.updated_by` already records who performed the last
-- transition, and `audit_logs` is the authoritative, append-only answer to "who
-- closed this?". A third copy would be a third thing that could disagree.

-- ---------------------------------------------------------------------------
-- Composite parent key
-- ---------------------------------------------------------------------------
-- Lets `result_publication_items` require that an item's assignment belongs to
-- the publication's draw. Phase 11's validation found the cost of leaving this
-- to separate foreign keys: each reference existed, their agreement did not,
-- and a row mixing two draws inserted cleanly. SQLite enforces a composite
-- foreign key only when the parent columns carry a UNIQUE index in that order.
CREATE UNIQUE INDEX ux_draw_assignments_id_draw ON draw_assignments(id, draw_id);

-- ---------------------------------------------------------------------------
-- result_publications
-- ---------------------------------------------------------------------------
-- A row here means the winners are PUBLIC. There is no draft state and no
-- unpublished state: the absence of the row is the unpublished state, and a
-- status column would be a second source of truth that could contradict the
-- items beneath it.
CREATE TABLE result_publications (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- ONE PUBLICATION PER EVENT, and one per DRAW. Both, because they are
  -- different mistakes: the first stops an event being announced twice, the
  -- second stops one draw being announced under two events.
  event_id TEXT NOT NULL CHECK (length(event_id) > 0),
  draw_id TEXT NOT NULL CHECK (length(draw_id) > 0),

  published_at TEXT NOT NULL
    CHECK (length(published_at) = 24 AND published_at LIKE '____-__-__T__:__:__.___Z'),

  -- ON DELETE SET NULL, and nothing below requires it. The principle phase 10
  -- established after the two contradicted each other: removing an
  -- administrator must not erase the record that results were published, and
  -- attribution that became unknown because an account was deleted is a fact
  -- rather than an incoherence. `audit_logs` keeps the authoritative answer.
  published_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,

  -- Correlates the publication with its log lines and its audit row.
  request_id TEXT,

  -- How many winners were announced. Checked against the item count and against
  -- the draw's own `assignment_count` on every read, so a publication can never
  -- present fewer winners than it recorded — the failure phase 11's validation
  -- found in the draw read and fixed there.
  winner_count INTEGER NOT NULL CHECK (winner_count >= 1),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),

  -- ONE EVENT, THROUGHOUT. The composite key forces the draw to belong to the
  -- event the publication claims; two simple foreign keys would each be
  -- satisfied by a row that mixed them.
  FOREIGN KEY (draw_id, event_id) REFERENCES draws(id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX ux_result_publications_event ON result_publications(event_id);
CREATE UNIQUE INDEX ux_result_publications_draw ON result_publications(draw_id);
-- The composite parent key its items need.
CREATE UNIQUE INDEX ux_result_publications_id_draw ON result_publications(id, draw_id);

-- ---------------------------------------------------------------------------
-- result_publication_items
-- ---------------------------------------------------------------------------
-- One announced winner.
--
-- WHAT IS DELIBERATELY ABSENT: email, date of birth, phone, answers, the
-- participant id and the entry id. A public record is the last place personal
-- data should accumulate, and everything an operator might need is one join
-- away through `assignment_id` — behind authentication, where it belongs.
CREATE TABLE result_publication_items (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  publication_id TEXT NOT NULL CHECK (length(publication_id) > 0),

  -- Denormalised so an item can be tied to its draw without joining through the
  -- publication — and, with the composite key below, it is what forces the
  -- assignment to belong to the publication's own draw.
  draw_id TEXT NOT NULL CHECK (length(draw_id) > 0),

  assignment_id TEXT NOT NULL CHECK (length(assignment_id) > 0),

  -- The position in the draw. Public ordering is this and nothing else.
  draw_order INTEGER NOT NULL CHECK (draw_order >= 0),

  -- WHAT THE WORLD WAS TOLD. Computed once, by `formatPublicWinnerName`, at the
  -- moment of publication. A participant correcting their name afterwards
  -- changes their record and does not change this.
  winner_display_name_snapshot TEXT NOT NULL CHECK (
    length(trim(winner_display_name_snapshot)) > 0
    AND length(winner_display_name_snapshot) <= 160
  ),

  -- COPIED FROM THE ASSIGNMENT, never from `event_prizes`. The assignment
  -- already holds what the prize was called when it was won; this carries that
  -- forward rather than reaching back to a table that can still change.
  prize_name_snapshot TEXT NOT NULL CHECK (
    length(trim(prize_name_snapshot)) > 0 AND length(prize_name_snapshot) <= 120
  ),
  prize_description_snapshot TEXT CHECK (
    prize_description_snapshot IS NULL OR length(prize_description_snapshot) <= 2000
  ),
  prize_unit_index INTEGER NOT NULL CHECK (prize_unit_index >= 1),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),

  -- ONE DRAW, THROUGHOUT.
  FOREIGN KEY (publication_id, draw_id)
    REFERENCES result_publications(id, draw_id) ON DELETE RESTRICT,
  FOREIGN KEY (assignment_id, draw_id)
    REFERENCES draw_assignments(id, draw_id) ON DELETE RESTRICT
);

-- ONE ITEM PER ASSIGNMENT: the same winner cannot be announced twice.
CREATE UNIQUE INDEX ux_result_items_assignment
  ON result_publication_items(publication_id, assignment_id);

-- ONE ITEM PER POSITION: two rows claiming the same place in the draw would
-- make the public order ambiguous, and the order is the only thing that says
-- which prize was drawn first.
CREATE UNIQUE INDEX ux_result_items_order
  ON result_publication_items(publication_id, draw_order);

CREATE INDEX idx_result_items_publication
  ON result_publication_items(publication_id, draw_order);

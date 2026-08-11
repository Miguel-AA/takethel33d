-- The draw: one per event, ever.
--
-- This is the first irreversible act in the system. Everything before it can be
-- corrected — an event reopened, a prize re-quantified, a participant
-- reinstated — but a draw picks winners, and picking them again would mean the
-- first result was a rehearsal. So the schema is built to make a second draw
-- impossible rather than merely discouraged.
--
-- WHAT THE DATABASE GUARANTEES, so no code path can lose it:
--
--   * one draw per event                      UNIQUE(event_id)
--   * one prize per winner, per draw          UNIQUE(draw_id, entry_id)
--   * one winner per prize unit, per draw     UNIQUE(draw_id, prize_id, prize_unit_index)
--   * counts that cannot describe an impossible draw   CHECK constraints
--   * nothing that participated can be deleted afterwards   FK RESTRICT
--
-- WHAT IT DELIBERATELY DOES NOT STORE: the random bytes. Keeping them would
-- make the selection reproducible by anybody who read the row, which is the
-- opposite of what a draw needs. What is kept is a hash of the population that
-- was consumed, so "who was in the running?" is answerable without making "who
-- would win?" predictable.

-- ---------------------------------------------------------------------------
-- The population a draw is allowed to consume
-- ---------------------------------------------------------------------------
-- Phase 10 permits disqualification and reinstatement while the event is
-- DRAW_READY — deliberately, because discovering a cheat in the hour before a
-- draw is exactly when an operator needs to act. That leaves a window: the draw
-- resolves its candidates, somebody changes the population, and the draw
-- commits winners chosen from a set that no longer exists.
--
-- This counter closes it. It advances ONLY when an entry enters or leaves the
-- draw-eligible set — not on any participant activity, because a change that
-- cannot affect who could win must not invalidate a draw in flight. The draw
-- captures it alongside the candidates and re-asserts it at commit time, so a
-- population that moved underneath takes the whole batch down.
--
-- Registration cannot interfere: `entryWindowProblem` requires the event to be
-- OPEN, and a draw requires DRAW_READY, so the two can never interleave.
ALTER TABLE events ADD COLUMN participant_population_revision INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- draws
-- ---------------------------------------------------------------------------
-- A row here means a COMPLETED draw. There is no PENDING state, because there
-- is no moment at which a draw half-exists: the selection, every assignment,
-- the audit row and the event's transition commit in one batch or none of them
-- do. A status column would describe a state the system cannot be in.
CREATE TABLE draws (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- ONE DRAW PER EVENT. The unique index below is the whole no-reroll
  -- guarantee: not a convention, not a service check that could be forgotten,
  -- but a constraint a second attempt cannot get past.
  event_id TEXT NOT NULL CHECK (length(event_id) > 0)
    REFERENCES events(id) ON DELETE RESTRICT,

  completed_at TEXT NOT NULL
    CHECK (length(completed_at) = 24 AND completed_at LIKE '____-__-__T__:__:__.___Z'),

  -- ON DELETE SET NULL, and the coherence rules below never require it. Phase
  -- 10 established the principle after the two contradicted each other there:
  -- removing an administrator must not erase the record that a draw happened,
  -- and attribution that became unknown because the account was deleted is a
  -- fact rather than an incoherence. The authoritative record of who ran it
  -- survives in `audit_logs`, which is append-only.
  executed_by_admin_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,

  -- Correlates the draw with its log lines and its audit row.
  request_id TEXT,

  -- The three numbers that describe the draw, checked against each other below
  -- so a row can never claim something arithmetically impossible.
  candidate_count INTEGER NOT NULL CHECK (candidate_count >= 1),
  prize_unit_count INTEGER NOT NULL CHECK (prize_unit_count >= 1),
  assignment_count INTEGER NOT NULL CHECK (assignment_count >= 1),

  -- Which selection procedure produced this. Recorded so a future change to the
  -- algorithm cannot silently reinterpret an old draw: a row says how it was
  -- made, and nothing has to be inferred from the deployment date.
  algorithm_version TEXT NOT NULL CHECK (length(algorithm_version) > 0),

  -- SHA-256 over the sorted candidate entry ids. Evidence of WHICH population
  -- was consumed, carrying no personal data and making nothing predictable.
  candidate_set_hash TEXT NOT NULL CHECK (length(candidate_set_hash) > 0),

  -- The population counter as it stood when the candidates were resolved.
  candidate_population_revision INTEGER NOT NULL CHECK (candidate_population_revision >= 0),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),

  -- A draw cannot have given away more than it had, in either direction.
  CHECK (assignment_count <= candidate_count),
  CHECK (assignment_count <= prize_unit_count)
);

-- The no-reroll guarantee.
CREATE UNIQUE INDEX ux_draws_event ON draws(event_id);
CREATE INDEX idx_draws_completed_at ON draws(completed_at DESC);

-- ---------------------------------------------------------------------------
-- Composite parent keys
-- ---------------------------------------------------------------------------
-- These exist so `draw_assignments` can name a COMPOSITE foreign key below.
--
-- Without them, each of an assignment's four references is checkable on its own
-- and their AGREEMENT is not: a row could point at event A's draw while
-- carrying event B's prize and event B's entry, and every individual foreign
-- key would be satisfied. Measured before this existed — such a row inserted
-- cleanly, and it is exactly the shape that puts one event's winners on another
-- event's screen.
--
-- SQLite enforces a composite foreign key only when the parent columns carry a
-- UNIQUE index in that exact order, so each parent gets one. They are redundant
-- as uniqueness constraints — `id` is already a primary key — and they are not
-- redundant as parent keys.
CREATE UNIQUE INDEX ux_draws_id_event ON draws(id, event_id);
CREATE UNIQUE INDEX ux_event_prizes_id_event ON event_prizes(id, event_id);
CREATE UNIQUE INDEX ux_event_entries_id_event ON event_entries(id, event_id);

-- ---------------------------------------------------------------------------
-- draw_assignments
-- ---------------------------------------------------------------------------
-- One prize unit, one winner.
CREATE TABLE draw_assignments (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  draw_id TEXT NOT NULL CHECK (length(draw_id) > 0),

  -- Denormalised so an assignment can be scoped by event without joining
  -- through the draw — and, because of the composite foreign keys at the foot
  -- of this table, it is also what forces the draw, the prize and the entry to
  -- belong to the SAME event. The column is not a convenience; it is the join
  -- key that makes cross-event corruption unrepresentable.
  event_id TEXT NOT NULL CHECK (length(event_id) > 0)
    REFERENCES events(id) ON DELETE RESTRICT,

  -- RESTRICT throughout. A prize somebody won, and the participation that won
  -- it, are the evidence of the draw; nothing may delete either as a side
  -- effect of tidying up.
  prize_id TEXT NOT NULL CHECK (length(prize_id) > 0),
  entry_id TEXT NOT NULL CHECK (length(entry_id) > 0),

  -- Which unit of a multi-quantity prize this is. A prize with quantity 3 has
  -- units 1, 2 and 3, and each is won separately.
  prize_unit_index INTEGER NOT NULL CHECK (prize_unit_index >= 1),

  -- The position in the shuffled order that produced this assignment. Recorded
  -- so the sequence is reconstructable for display without implying it is
  -- reproducible.
  draw_order INTEGER NOT NULL CHECK (draw_order >= 0),

  -- WHAT THE PRIZE WAS CALLED WHEN IT WAS WON. Copied, not joined: a prize
  -- renamed a year later must not silently rewrite what somebody was told they
  -- had won. The same reasoning `event_entry_answers.question_label_snapshot`
  -- follows.
  prize_name_snapshot TEXT NOT NULL CHECK (
    length(trim(prize_name_snapshot)) > 0 AND length(prize_name_snapshot) <= 120
  ),
  prize_description_snapshot TEXT CHECK (
    prize_description_snapshot IS NULL OR length(prize_description_snapshot) <= 2000
  ),

  assigned_at TEXT NOT NULL
    CHECK (length(assigned_at) = 24 AND assigned_at LIKE '____-__-__T__:__:__.___Z'),

  -- ONE EVENT, THROUGHOUT. Each of these pairs the reference with `event_id`,
  -- so the draw, the prize and the participation must all belong to the event
  -- the assignment claims. Three simple foreign keys would each be satisfied by
  -- a row that mixed two events; these cannot be.
  FOREIGN KEY (draw_id, event_id) REFERENCES draws(id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (prize_id, event_id) REFERENCES event_prizes(id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (entry_id, event_id) REFERENCES event_entries(id, event_id) ON DELETE RESTRICT
);

-- ONE PRIZE PER WINNER. This is what stops a single person taking the vape, the
-- grinder and the gift card out of one draw. A precheck can lose a race; an
-- index cannot.
CREATE UNIQUE INDEX ux_draw_assignments_winner ON draw_assignments(draw_id, entry_id);

-- ONE WINNER PER UNIT. Two rows for one physical thing would mean two people
-- were both told they had won it.
CREATE UNIQUE INDEX ux_draw_assignments_unit
  ON draw_assignments(draw_id, prize_id, prize_unit_index);

CREATE INDEX idx_draw_assignments_draw ON draw_assignments(draw_id, draw_order);
CREATE INDEX idx_draw_assignments_event ON draw_assignments(event_id);
CREATE INDEX idx_draw_assignments_entry ON draw_assignments(entry_id);
CREATE INDEX idx_draw_assignments_prize ON draw_assignments(prize_id);

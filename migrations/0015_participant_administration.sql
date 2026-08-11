-- Administrative disposition of a participation.
--
-- THE PROBLEM. An operator discovers that somebody entered twice under two
-- addresses, or breached the rules, or asked to be withdrawn. They need to take
-- that entry out of consideration — and the system must still be able to answer
-- "what did we actually decide about this person when they entered?"
--
-- Those are two different facts, and phases 7-8 only recorded the first. The
-- tempting shortcut is to reuse `eligibility_reason`, writing something like
-- "disqualified by operator" over `AGE_REQUIREMENT_NOT_MET`. That destroys the
-- verdict: the entry then claims a decision nobody took, and the question "was
-- this person eligible?" becomes permanently unanswerable. So disposition gets
-- its own columns and the verdict is never touched.
--
-- WHY ADD COLUMN AND TRIGGERS, NOT A REBUILD.
--
-- SQLite's ALTER TABLE cannot add a CHECK, so constraining these columns at the
-- storage layer means either a rebuild or triggers. Migrations 0013 and 0014
-- both weighed that trade for this same table and chose triggers, for reasons
-- that have not changed: `event_entries` is referenced by
-- `event_entry_answers`, so a rebuild would drop and restore a foreign key
-- guarding the answers real people gave, and would have to recreate the five
-- triggers those migrations added.

-- ---------------------------------------------------------------------------
-- Optimistic concurrency
-- ---------------------------------------------------------------------------
-- Until now an entry was written once and never updated, so it needed no
-- concurrency token. It does now: two administrators looking at the same
-- participant list can act on the same row, and without a guard the second
-- write would silently overwrite the first — including overwriting the recorded
-- previous status, which is the one value that cannot be reconstructed.
--
-- Every existing row starts at 1. Nothing else about them changes.
ALTER TABLE event_entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Disposition
-- ---------------------------------------------------------------------------
ALTER TABLE event_entries ADD COLUMN disqualified_at TEXT;

-- ON DELETE SET NULL, never CASCADE: removing an administrator must not erase
-- the record that a disqualification happened. The row survives, unattributed
-- but intact — the same policy `audit_logs.actor_admin_id` follows.
--
-- AND THEREFORE THIS COLUMN IS NOT REQUIRED BY THE COHERENCE TRIGGER BELOW,
-- even on a DISQUALIFIED row. The first draft of this migration demanded it,
-- and the two rules contradicted each other: deleting an administrator fired
-- the foreign key's SET NULL, which fired the trigger, which aborted — so an
-- account could never be removed once it had disqualified anybody. Measured:
-- `DELETE FROM admin_users` threw "incoherent administrative disposition".
--
-- The resolution is to be precise about what the invariant is FOR. A
-- disqualification must be interpretable and undoable: WHEN it happened, WHY,
-- and WHAT STATUS it replaced. Those three are required. WHO did it is
-- attribution, and attribution that has become unknown because the account was
-- deleted is a fact rather than an incoherence — exactly the case
-- `ON DELETE SET NULL` exists to express. The authoritative record of who acted
-- survives in `audit_logs`, which is append-only and never deleted.
--
-- SQLite permits adding a column with a REFERENCES clause only when its default
-- is NULL, which is exactly what is wanted here.
ALTER TABLE event_entries ADD COLUMN disqualified_by_admin_id TEXT
  REFERENCES admin_users(id) ON DELETE SET NULL;

ALTER TABLE event_entries ADD COLUMN disqualification_reason TEXT;

-- THE STATUS THE ENTRY HELD BEFORE, so reinstatement can put it back.
--
-- Recording it is what makes reinstatement honest. The alternative — deciding
-- again at reinstatement time — would run the age rule against today's date and
-- today's `minimum_age`, and could hand somebody a different answer from the one
-- they were originally given. A verdict belongs to the moment it was taken.
ALTER TABLE event_entries ADD COLUMN pre_disqualification_status TEXT;

-- Disposition is queried per event ("show me the disqualified ones"), so the
-- partial index stays small: it covers only rows that actually carry one.
CREATE INDEX idx_event_entries_disqualified
  ON event_entries(event_id, disqualified_at)
  WHERE disqualified_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Coherence
-- ---------------------------------------------------------------------------
-- The four disposition columns and the status are one fact recorded five ways,
-- and a row where they disagree is a row nobody can interpret. The service
-- enforces this too; these are the second line, for anything written by a
-- migration, a console session or a future bug.
--
-- Rows written BEFORE this migration are left alone deliberately, exactly as
-- 0013 left phase 7's unjudged entries alone. A pre-existing DISQUALIFIED row
-- with no disposition (none can exist through the application — nothing ever
-- set that status) would be refused any further update, which is the correct
-- outcome: it cannot be reinstated honestly either, and the service reports
-- that as a typed refusal rather than guessing.
CREATE TRIGGER trg_event_entries_disposition_insert
BEFORE INSERT ON event_entries
FOR EACH ROW
WHEN
  -- Disqualified means all four are recorded. A disqualification that does not
  -- say who, when, why, or what it replaced is not a decision anybody can
  -- explain or undo.
  (NEW.status = 'DISQUALIFIED' AND (
      NEW.disqualified_at IS NULL
   OR NEW.disqualification_reason IS NULL
   OR NEW.pre_disqualification_status IS NULL))
  -- And not disqualified means none of them are. Leftover disposition on a
  -- reinstated entry would make it look disqualified to anything reading the
  -- columns rather than the status.
  OR (NEW.status <> 'DISQUALIFIED' AND (
      NEW.disqualified_at IS NOT NULL
   OR NEW.disqualified_by_admin_id IS NOT NULL
   OR NEW.disqualification_reason IS NOT NULL
   OR NEW.pre_disqualification_status IS NOT NULL))
  -- A previous status of DISQUALIFIED would mean a disqualification undoing to
  -- a disqualification, which loses the original verdict.
  OR (NEW.pre_disqualification_status IS NOT NULL
      AND NEW.pre_disqualification_status NOT IN ('ELIGIBLE', 'INELIGIBLE', 'SUBMITTED'))
  OR (NEW.disqualification_reason IS NOT NULL
      AND (length(trim(NEW.disqualification_reason)) = 0
           OR length(NEW.disqualification_reason) > 500))
  OR (NEW.disqualified_at IS NOT NULL
      AND NOT (length(NEW.disqualified_at) = 24
               AND NEW.disqualified_at LIKE '____-__-__T__:__:__.___Z'))
  -- A revision below 1 would make every optimistic-concurrency comparison
  -- meaningless, since the guard matches on it.
  OR NEW.revision < 1
BEGIN
  SELECT RAISE(ABORT, 'event_entries: incoherent administrative disposition');
END;

CREATE TRIGGER trg_event_entries_disposition_update
BEFORE UPDATE ON event_entries
FOR EACH ROW
WHEN
  (NEW.status = 'DISQUALIFIED' AND (
      NEW.disqualified_at IS NULL
   OR NEW.disqualification_reason IS NULL
   OR NEW.pre_disqualification_status IS NULL))
  OR (NEW.status <> 'DISQUALIFIED' AND (
      NEW.disqualified_at IS NOT NULL
   OR NEW.disqualified_by_admin_id IS NOT NULL
   OR NEW.disqualification_reason IS NOT NULL
   OR NEW.pre_disqualification_status IS NOT NULL))
  OR (NEW.pre_disqualification_status IS NOT NULL
      AND NEW.pre_disqualification_status NOT IN ('ELIGIBLE', 'INELIGIBLE', 'SUBMITTED'))
  OR (NEW.disqualification_reason IS NOT NULL
      AND (length(trim(NEW.disqualification_reason)) = 0
           OR length(NEW.disqualification_reason) > 500))
  OR (NEW.disqualified_at IS NOT NULL
      AND NOT (length(NEW.disqualified_at) = 24
               AND NEW.disqualified_at LIKE '____-__-__T__:__:__.___Z'))
  OR NEW.revision < 1
  -- A revision that does not advance is a lost-update guard that never fired.
  OR NEW.revision < OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'event_entries: incoherent administrative disposition');
END;

-- ---------------------------------------------------------------------------
-- WHY THERE IS NO "VERDICT IS IMMUTABLE" TRIGGER HERE
-- ---------------------------------------------------------------------------
-- The obvious next trigger would forbid any UPDATE that changes
-- `calculated_age`, `age_eligible`, `overall_eligible` or `eligibility_reason`,
-- making the historical verdict unwritable at the storage layer.
--
-- It is deliberately absent. Phase 8 left `EventEntryRepository.applyEligibilityStatement`
-- as an explicit, tested seam for a future administrative CORRECTION flow — an
-- entry may be re-judged, it may never be re-homed — and a blanket trigger here
-- would silently delete that capability and pre-empt a design decision that
-- belongs to the phase which builds it.
--
-- What phase 10 owes instead is that ITS OWN surface never touches those
-- columns. `disqualifyStatement` and `reinstateStatement` name every column
-- they set, none of them is a verdict column, and the tests assert that a
-- disqualification followed by a reinstatement leaves the age, the flags, the
-- reason, the answers and the version bit-for-bit unchanged. The guarantee is
-- the same; it is enforced where the risk actually is rather than by removing
-- something else's tool.

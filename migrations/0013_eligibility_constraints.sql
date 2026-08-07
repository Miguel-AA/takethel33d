-- Database-level invariants for an eligibility decision.
--
-- WHY TRIGGERS AND NOT CHECK CONSTRAINTS
--
-- SQLite's `ALTER TABLE` cannot add a CHECK. Adding one means rebuilding
-- `event_entries` — create, copy, drop, rename — and that table is referenced by
-- `event_entry_answers`, so the rebuild would have to break and restore a
-- foreign key that guards the answers real people gave. A destructive rebuild to
-- add a defence that the service and the mapper already enforce is a bad trade.
--
-- A trigger is additive, non-destructive, and protects exactly what needs
-- protecting: NEW data. Rows written before this migration are left alone
-- deliberately — phase 7 recorded participations before eligibility existed, and
-- they are `SUBMITTED` with no verdict. Those are history. Rewriting them would
-- invent decisions nobody took about people nobody assessed.
--
-- WHAT IS ENFORCED HERE, AND WHAT IS NOT
--
-- Only invariants a single row can prove about itself. Whether an age rule
-- APPLIED depends on `events.minimum_age`, which the row does not carry and
-- which can legitimately change afterwards — so that one is checked where the
-- event is available, in the service, and never here. A trigger that guessed
-- would reject perfectly good history the first time an operator edited an
-- event.

-- A decision that says ELIGIBLE must be eligible.
CREATE TRIGGER trg_event_entries_decision_insert
BEFORE INSERT ON event_entries
FOR EACH ROW
WHEN
  (NEW.status = 'ELIGIBLE' AND (NEW.overall_eligible IS NULL OR NEW.overall_eligible <> 1))
  OR (NEW.status = 'INELIGIBLE' AND (NEW.overall_eligible IS NULL OR NEW.overall_eligible <> 0))
  -- A verdict of "excluded" that does not say why is a verdict nobody can
  -- explain to the person it excluded.
  OR (NEW.overall_eligible = 0 AND NEW.eligibility_reason IS NULL)
  -- An age rule cannot have been applied to an age that was never recorded.
  OR (NEW.age_eligible IS NOT NULL AND NEW.calculated_age IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'event_entries: incoherent eligibility decision');
END;

-- The same rules on the correction path, so a later administrative edit cannot
-- produce a state the creation path refuses.
CREATE TRIGGER trg_event_entries_decision_update
BEFORE UPDATE ON event_entries
FOR EACH ROW
WHEN
  (NEW.status = 'ELIGIBLE' AND (NEW.overall_eligible IS NULL OR NEW.overall_eligible <> 1))
  OR (NEW.status = 'INELIGIBLE' AND (NEW.overall_eligible IS NULL OR NEW.overall_eligible <> 0))
  OR (NEW.overall_eligible = 0 AND NEW.eligibility_reason IS NULL)
  OR (NEW.age_eligible IS NOT NULL AND NEW.calculated_age IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'event_entries: incoherent eligibility decision');
END;

-- An entry may be re-judged; it may never be re-homed. The identity, the event
-- and the form version an entry was recorded against are what make its answers
-- mean anything, and nothing in the application has a reason to move them.
CREATE TRIGGER trg_event_entries_immutable_identity
BEFORE UPDATE ON event_entries
FOR EACH ROW
WHEN
  NEW.event_id <> OLD.event_id
  OR NEW.participant_id <> OLD.participant_id
  OR NEW.form_version_id <> OLD.form_version_id
  OR NEW.submitted_at <> OLD.submitted_at
BEGIN
  SELECT RAISE(ABORT, 'event_entries: an entry cannot be re-homed');
END;

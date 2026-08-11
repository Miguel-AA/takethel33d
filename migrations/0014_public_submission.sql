-- Idempotency for the public submission flow.
--
-- THE PROBLEM. A participant on a phone taps "Submit", the connection stalls,
-- and they tap again. Nothing in phases 7-8 distinguishes that from two people
-- entering: the duplicate-identity index would catch the second one and answer
-- "you have already entered", which is technically true and completely useless
-- as an explanation to somebody who is not sure their first attempt worked.
--
-- The client therefore mints an idempotency key once per filled-in form and
-- sends it with every attempt. The same key means the same logical submission,
-- however many times it arrives.
--
-- WHY ADD COLUMN AND A PARTIAL INDEX, AND NOT A REBUILD.
--
-- SQLite's ALTER TABLE cannot add a CHECK, so a rebuild would be the only way
-- to constrain the column's shape at the storage layer. Migration 0013 already
-- weighed and rejected that trade for this same table, and nothing has changed:
-- `event_entries` is referenced by `event_entry_answers`, so a rebuild means
-- dropping and restoring a foreign key that guards the answers real people
-- gave, and it would have to drop and recreate the three triggers 0013 added.
-- A destructive rebuild to duplicate a constraint the schema layer and the
-- mapper already enforce is a bad trade.
--
-- The precedent for the shape is in this repository: 0002 added
-- `attendees.jotform_submission_id` exactly this way, with exactly this kind of
-- partial unique index.

ALTER TABLE event_entries ADD COLUMN submission_id TEXT;

-- ONE entry per idempotency key, PER EVENT.
--
-- Scoped by `event_id`, not global. A key is a client-minted UUID, so a genuine
-- collision across events is vanishingly unlikely — but a caller can reuse one
-- deliberately, and under a global index that turned a perfectly ordinary
-- submission to a second event into a constraint violation the service could
-- only report as "unavailable". Scoping it makes the key mean what it says: one
-- submission, to one event.
--
-- The lookup is scoped the same way, so a key obtained from one event's
-- response can never be replayed against another to discover whether it exists.
--
-- PARTIAL — `WHERE submission_id IS NOT NULL` — and that is the whole reason
-- this works. SQL considers NULLs distinct, but relying on that is relying on a
-- subtlety; stating it makes the intent explicit and keeps the index small.
--
-- Every entry written before this migration, and every entry the administrative
-- endpoint writes, carries NULL here. They are not less real for it: an entry
-- recorded by an operator has no client-side retry to deduplicate. Those rows
-- must all coexist, and under this index they do.
--
-- This index is what actually decides a race. Two simultaneous retries both
-- read "no such submission" and both proceed; the second INSERT violates this
-- constraint, its whole batch rolls back — audit row included — and the service
-- re-reads the winner and returns the original result. A SELECT-then-INSERT
-- without this index would produce two entries and two audit rows.
CREATE UNIQUE INDEX ux_event_entries_submission_id
  ON event_entries(event_id, submission_id)
  WHERE submission_id IS NOT NULL;

-- An entry may be re-judged; its idempotency key may never be rewritten.
--
-- A SEPARATE trigger rather than an extra clause in
-- `trg_event_entries_immutable_identity`: that trigger is certified phase 8
-- code, and editing it would mean re-proving it. This one states one new fact
-- and can be read on its own.
--
-- `IS NOT` rather than `<>` deliberately: `NULL <> 'x'` evaluates to NULL, not
-- true, so a `<>` comparison would silently permit writing a key onto a
-- historical row — the exact case this is meant to forbid.
CREATE TRIGGER trg_event_entries_immutable_submission
BEFORE UPDATE ON event_entries
FOR EACH ROW
WHEN NEW.submission_id IS NOT OLD.submission_id
BEGIN
  SELECT RAISE(ABORT, 'event_entries: submission_id cannot be changed');
END;

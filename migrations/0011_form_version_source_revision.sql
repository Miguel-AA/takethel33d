-- One version per draft revision.
--
-- The service already refuses to publish a draft whose revision matches the
-- LATEST version's, which covers the ordinary "you clicked twice" case. It is
-- not enough on its own: if version numbers ever advance past the version that
-- froze this revision — a repair, a manual insert, an import — the same
-- revision can be frozen twice, producing two versions that are byte-identical
-- but numbered differently, and a history where nothing distinguishes them.
--
-- The rule belongs in the database because it is about what may EXIST, not
-- about what a particular code path happens to check. Together with
-- UNIQUE(event_id, version_number) it makes both halves of a publication's
-- identity structural: which number it is, and what it froze.
CREATE UNIQUE INDEX idx_form_versions_event_source_revision
  ON event_form_versions(event_id, source_draft_revision);

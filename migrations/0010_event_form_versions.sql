-- Published form versions: the frozen copy participants will fill in.
--
-- A published version is IMMUTABLE. The draft stays editable forever, but what
-- was published can never change — otherwise a form somebody already completed
-- would silently become a different form, and the answers already given would
-- be answers to questions nobody was asked.
--
-- Publishing therefore COPIES rather than promotes: the draft's steps,
-- questions and options are duplicated into the same tables under
-- `form_owner_type = 'VERSION'`, owned by the row created here. That is the
-- seam migration 0009 left open, and this is what closes it.

CREATE TABLE event_form_versions (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- RESTRICT, never CASCADE: a published form is a record of what was asked.
  -- Deleting the event would destroy that record, so it must fail loudly.
  event_id TEXT NOT NULL CHECK (length(event_id) > 0)
    REFERENCES events(id) ON DELETE RESTRICT,

  -- 1, 2, 3… per event. The UNIQUE index below is what makes two simultaneous
  -- publications resolve to one winner instead of two rows claiming v4.
  version_number INTEGER NOT NULL CHECK (version_number >= 1),

  -- Which revision of the draft this froze. Comparing it with the draft's
  -- CURRENT revision is how "unpublished changes" is answered without diffing
  -- two whole forms on every render.
  source_draft_revision INTEGER NOT NULL CHECK (source_draft_revision >= 1),

  published_by TEXT NOT NULL CHECK (length(published_by) > 0)
    REFERENCES admin_users(id) ON DELETE RESTRICT,

  published_at TEXT NOT NULL
    CHECK (length(published_at) = 24 AND published_at LIKE '____-__-__T__:__:__.___Z'),

  -- A complete, self-contained JSON rendering of what was published.
  --
  -- SECONDARY evidence, not the runtime source: the normalized rows under
  -- `form_owner_type = 'VERSION'` are what the renderer reads. The snapshot
  -- exists so a version can still be read, audited and compared even if a
  -- future refactor moves the normalized shape underneath it — and so a
  -- disagreement between the two is detectable rather than invisible.
  schema_snapshot TEXT NOT NULL CHECK (length(schema_snapshot) > 0),

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z')
);

CREATE INDEX idx_form_versions_event ON event_form_versions(event_id);
CREATE UNIQUE INDEX idx_form_versions_event_version
  ON event_form_versions(event_id, version_number);
CREATE INDEX idx_form_versions_published_at ON event_form_versions(published_at DESC);

-- Which version is live for this event. NULL until the first publication, and
-- RESTRICT so a version that an event still points at cannot be removed.
--
-- SQLite cannot express "and it must belong to THIS event" — that would need a
-- composite foreign key against (id, event_id). The application enforces it:
-- FormVersionRepository.versionBelongsToEvent is the only way a pointer is
-- ever set, and the publishing service writes the id it has just created.
ALTER TABLE events ADD COLUMN published_form_version_id TEXT
  REFERENCES event_form_versions(id) ON DELETE RESTRICT;

CREATE INDEX idx_events_published_form_version
  ON events(published_form_version_id);

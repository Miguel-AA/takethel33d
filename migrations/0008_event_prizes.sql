-- Configurable prizes, owned by an event.
--
-- A first-class entity, not JSON stuffed into `events`, not repeated
-- `prize_1`/`prize_2` columns, and nothing hardcoded: "Vape", "Grinder" and
-- "Gift Card" are DATA a client may seed, never schema.
--
-- Timestamps follow the phase 2 convention: ISO-8601 UTC with milliseconds,
-- written by the application, fixed width so ordering is chronological.

CREATE TABLE event_prizes (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),

  -- RESTRICT, never CASCADE: deleting an event that still has prizes must fail
  -- loudly rather than silently discarding its configuration. Retiring an
  -- event is what archiving is for.
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE RESTRICT,

  name TEXT NOT NULL CHECK (length(trim(name)) > 0 AND length(name) <= 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  -- Only ever an http/https URL; the scheme is enforced in the application,
  -- where a real URL parser is available.
  image_url TEXT CHECK (image_url IS NULL OR length(image_url) <= 2048),

  quantity INTEGER NOT NULL CHECK (quantity >= 1 AND quantity <= 1000),

  -- Position. The ceiling is 1000100 = the reorder's parking offset (1000000)
  -- plus the 100-prize-per-event limit.
  --
  -- It cannot be tighter. A reorder stages positions in that high range mid-
  -- batch (see PrizeRepository.reorderStatements), and SQLite evaluates CHECKs
  -- per statement, not at commit — D1 has no deferrable constraints — so a
  -- bound below the parking range would reject the staging write itself. What
  -- this DOES guarantee is that no value can ever exceed the range the
  -- algorithm reserves; real positions are held two orders of magnitude below
  -- it by the schemas in shared/, and the mapper refuses anything above on read.
  sort_order INTEGER NOT NULL CHECK (sort_order >= 0 AND sort_order <= 1000100),

  status TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')),

  -- Optimistic concurrency, per prize. Reordering never touches the EVENT's
  -- revision: moving a prize is not a change to the event itself.
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),

  created_by TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,
  updated_by TEXT NOT NULL REFERENCES admin_users(id) ON DELETE RESTRICT,

  created_at TEXT NOT NULL
    CHECK (length(created_at) = 24 AND created_at LIKE '____-__-__T__:__:__.___Z'),
  updated_at TEXT NOT NULL
    CHECK (length(updated_at) = 24 AND updated_at LIKE '____-__-__T__:__:__.___Z'),
  archived_at TEXT
    CHECK (archived_at IS NULL OR
           (length(archived_at) = 24 AND archived_at LIKE '____-__-__T__:__:__.___Z')),

  -- Status and its timestamp cannot disagree: ARCHIVED always carries the
  -- moment it happened, and anything else never does.
  CHECK (
    (status = 'ARCHIVED' AND archived_at IS NOT NULL) OR
    (status <> 'ARCHIVED' AND archived_at IS NULL)
  )
);

CREATE INDEX idx_event_prizes_event_id ON event_prizes(event_id);
CREATE INDEX idx_event_prizes_event_status ON event_prizes(event_id, status);
CREATE INDEX idx_event_prizes_event_sort ON event_prizes(event_id, sort_order);
CREATE INDEX idx_event_prizes_status ON event_prizes(status);
CREATE INDEX idx_event_prizes_archived_at ON event_prizes(archived_at);
CREATE INDEX idx_event_prizes_updated_at ON event_prizes(updated_at DESC);

-- Position is unique WITHIN THE LIVE LIST of an event.
--
-- Partial on purpose: an archived prize has left the ordering entirely, so it
-- must not keep occupying a slot that the remaining prizes then collide with.
-- Because SQLite checks uniqueness per statement (D1 has no deferrable
-- constraints), a straight swap would collide mid-batch. The reorder therefore
-- writes in two passes through a high parking range that no real position can
-- occupy (positions are bounded by the 100-prize-per-event limit), keeping
-- `sort_order >= 0` true at every step — see PrizeRepository.reorderStatements.
CREATE UNIQUE INDEX idx_event_prizes_event_position
  ON event_prizes(event_id, sort_order)
  WHERE status <> 'ARCHIVED';

-- Track the Jotform submission ID against each attendee row so the webhook
-- is idempotent (Jotform retries aggressively) and the confirmation page
-- can look up the assigned participant number by submission ID.

ALTER TABLE attendees ADD COLUMN jotform_submission_id TEXT;

-- Partial unique index: enforces uniqueness only when the column is set,
-- so legacy rows registered via POST /api/register (NULL) still validate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_jotform_submission
  ON attendees(jotform_submission_id)
  WHERE jotform_submission_id IS NOT NULL;

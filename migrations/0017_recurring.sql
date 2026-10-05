-- Recurring reminders (PLAN §6.7, B6, 2026-10-05).
--
-- A series holds the rule, and a reminder row is one occurrence. Only the next
-- occurrence is ever stored: it is written when the current one is first
-- claimed, so the alarm's work stays constant and a lease covers it.
--
-- `status` is what makes a cancel final. An occurrence that was sent and later
-- requeued (a late failure report) checks it, so a series the user ended does
-- not start again from an old row.

CREATE TABLE IF NOT EXISTS reminder_series (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  rule_json  TEXT NOT NULL,
  status     TEXT NOT NULL,          -- active | cancelled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE reminders ADD COLUMN series_id TEXT;

-- Two claims of the same occurrence write the same next one at most once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_series_due
  ON reminders (series_id, due_at_utc);

-- Reminders and their delivery state (PLAN §6.7, §6.8).
--
-- `lease_until` is what makes the alarm handler idempotent: a row is claimed
-- before it is sent, and a crash between claiming and sending leaves a lease
-- that expires rather than a reminder that vanishes or fires twice.
--
-- `wamid` is stored after a successful send, so a retry that races a late
-- success can tell the difference.

CREATE TABLE IF NOT EXISTS reminders (
  id              TEXT PRIMARY KEY,
  principal       TEXT NOT NULL,
  text            TEXT NOT NULL,
  due_at_utc      INTEGER NOT NULL,
  local_wall_time TEXT NOT NULL,      -- echoed back to the user, DST-safe
  tz              TEXT NOT NULL,
  status          TEXT NOT NULL,      -- scheduled | sending | sent | failed | cancelled | done
  channel         TEXT,               -- whatsapp | calendar
  attempts        INTEGER NOT NULL DEFAULT 0,
  lease_until     INTEGER,
  backup_event_id TEXT,
  wamid           TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_due
  ON reminders (status, due_at_utc);

CREATE INDEX IF NOT EXISTS idx_reminders_principal
  ON reminders (principal, status, due_at_utc);

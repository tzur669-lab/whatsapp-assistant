-- Proactive calendar suggestions (block L, L3, 2026-10-15): "יש לך מחר
-- פגישה עם מקום. לקבוע תזכורת יציאה?" with a button.
--
-- reminders.event_id: the calendar event a "time to leave" reminder was set
-- for, written by `reminders.leave` from now on. NULL for every other reminder
-- and for leave reminders made before this migration (matched in code by
-- place and time, or skipped).
--
-- suggestions: one row per event per day it was suggested, so a rerun of the
-- daily job is a no-op (the unique key). Status moves:
--   open → checking → used | open (a Calendar error) | dismissed
--   open → dismissed
-- `checking` is a 2-minute lease held by one tap, fenced by `claim_token`:
-- every move out of it names the token, so a slow, superseded tap changes
-- nothing. `pending_id` is the reminder's confirmation card. `nonce_hash` is
-- SHA-256 of the notice button's nonce. Kept 30 days.
ALTER TABLE reminders ADD COLUMN event_id TEXT;

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  event_id TEXT NOT NULL,
  day TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'checking', 'used', 'dismissed')),
  nonce_hash TEXT NOT NULL,
  claimed_at INTEGER,
  claim_token TEXT,
  pending_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (principal, event_id, day)
);

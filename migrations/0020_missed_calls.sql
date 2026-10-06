-- Missed calls for the morning digest (ROADMAP #20, 2026-10-06).
--
-- At the digest hour the server asks the phone, by an empty push, for the calls
-- it missed in the last day. The phone answers with names (never numbers) and
-- times. The rows live for one digest. They are deleted as soon as it is built,
-- and maintenance drops anything older than 36 hours that slipped through.
--
-- `name` is the contact's name on the phone, or NULL for a number not in the
-- contacts. It is someone else's words: rendered by code, never sent to a model.

CREATE TABLE IF NOT EXISTS missed_calls (
  principal   TEXT NOT NULL,
  name        TEXT,
  at          INTEGER NOT NULL,
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_missed_calls_principal ON missed_calls (principal, at);

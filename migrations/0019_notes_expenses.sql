-- Notes and expenses (PLAN §6.22, ROADMAP #9 and #10, 2026-10-05).
--
-- Notes are the user's own words, kept for them and never sent to the model.
-- They are not encrypted here: a key rotation would silently delete every one,
-- and reminders and expenses sit in the same private storage as plain text.
--
-- An expense is a day, not an instant: `spent_on` is the local date. The
-- amount is whole agorot, so a sum is exact.

CREATE TABLE IF NOT EXISTS notes (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  text       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_notes_principal ON notes (principal, created_at);

CREATE TABLE IF NOT EXISTS expenses (
  id            TEXT PRIMARY KEY,
  principal     TEXT NOT NULL,
  amount_agorot INTEGER NOT NULL CHECK (amount_agorot > 0),
  category      TEXT NOT NULL,
  description   TEXT,
  spent_on      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_expenses_principal_day ON expenses (principal, spent_on);

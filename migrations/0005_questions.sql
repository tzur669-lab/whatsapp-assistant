-- One open clarifying question per sender (PLAN §6.11).
--
-- When a tool cannot proceed because the user left something out, the question
-- is asked *and written down*: the tool, everything already understood, and
-- which slot is being waited on. The next free-text message is then read as an
-- answer to it rather than as a fresh request.
--
-- `principal` is the primary key, not `id`. One outstanding question at a time
-- is a rule, and making it a structural one means a second question replaces
-- the first instead of leaving two rows that an answer could ambiguously match.
--
-- `slots_json` holds message content — a reminder body, an event title. It is
-- storage, never a log field, and it expires on its own.

CREATE TABLE IF NOT EXISTS open_questions (
  principal  TEXT PRIMARY KEY,
  tool       TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  asked      TEXT NOT NULL,          -- text | time | target | title | date | duration
  language   TEXT NOT NULL,          -- he | en
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_questions_expiry
  ON open_questions (expires_at);

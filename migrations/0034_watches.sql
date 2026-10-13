-- Event-triggered reminders (block J, J4, PLAN §6.30, 2026-10-13):
-- "כשמגיע מייל מ-DHL, תזכיר לי לבדוק את המשלוח".
--
-- watches: one row per watch. `keywords` holds the keywords normalized for
-- matching (JSON array, sent to the phone), `said` the same words as the user
-- said them (JSON array, for the Gmail query and for /watches), `sender` an
-- optional mail sender's words. `text` is the reminder, the user's own words,
-- stored in plain text exactly as reminder text is: a fire copies it into
-- `reminders`. The trigger's text never reaches the server.
--
-- A fire is one conditional UPDATE (active, not expired, fires left, out of
-- cooldown) and a due-now reminder, in one transaction. `last_checked` and
-- `seen_ids` (JSON, the last 50 Gmail ids) serve mail watches only.
-- status: active | spent | cancelled. An expired row stays `active` until
-- purged and is never listed or claimed (`expires_at` is in every query).
CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  source TEXT NOT NULL,
  keywords TEXT NOT NULL,
  said TEXT NOT NULL,
  sender TEXT,
  text TEXT NOT NULL,
  fires_left INTEGER NOT NULL,
  cooldown_until INTEGER,
  expires_at INTEGER NOT NULL,
  last_checked INTEGER,
  seen_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX watches_active ON watches (principal, status, expires_at);

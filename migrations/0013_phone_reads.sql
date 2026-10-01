-- Phone reads (PLAN §6.21).
--
-- agent_turns: an agent turn waiting for the paired phone to read its
-- contacts, notifications or SMS. The turn itself is AES-GCM ciphertext bound
-- to the sender and the query id (`src/agent/turns.ts`), kept only while the
-- row is waiting or running — three minutes at most — and cleared the moment
-- it settles. Settled rows keep their status, without the ciphertext, for an
-- hour, so a late or repeated result is answered rather than run again.
--
-- app_outbox.private: the reply carries text someone else wrote (an SMS, a
-- notification, a calendar invitation). The app shows a generic notification
-- for it, so that text never reaches the lock screen.

CREATE TABLE agent_turns (
  query_id   TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  wamid      TEXT NOT NULL,
  ciphertext TEXT,
  status     TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'done', 'superseded', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX agent_turns_wamid ON agent_turns (wamid);
CREATE INDEX agent_turns_waiting ON agent_turns (status, expires_at);

ALTER TABLE app_outbox ADD COLUMN private INTEGER NOT NULL DEFAULT 0;

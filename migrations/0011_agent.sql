-- The agent (PLAN §6.19).
--
-- conversation_turns: the short memory that makes a chat a conversation. One row
-- per exchange — the user's words and the reply sent, never a tool result —
-- encrypted with AES-GCM (`src/security/crypto.ts`) under associated data bound
-- to this table and this sender. A voice note is stored as a placeholder: the
-- transcript is never written down (invariant 13). Rows expire on their own
-- (12 hours, or 1 hour when the turn read text someone else wrote), and `/forget`
-- and `/pair off` delete them.
--
-- agent_lock: one agent turn per sender at a time. The model call is an await,
-- and a Durable Object takes other requests while it waits. Without this, two
-- turns could interleave on the same history and the same one-write rule.
--
-- open_questions.tainted: a question asked in a turn that read text someone else
-- wrote carries that into the answer, so "8" cannot turn into an unconfirmed
-- write that the injected text set up.

CREATE TABLE IF NOT EXISTS conversation_turns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  principal  TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  tainted    INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversation_principal
  ON conversation_turns (principal, id);

CREATE INDEX IF NOT EXISTS idx_conversation_expiry
  ON conversation_turns (expires_at);

CREATE TABLE IF NOT EXISTS agent_lock (
  principal  TEXT PRIMARY KEY,
  turn_id    TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

ALTER TABLE open_questions ADD COLUMN tainted INTEGER NOT NULL DEFAULT 0;

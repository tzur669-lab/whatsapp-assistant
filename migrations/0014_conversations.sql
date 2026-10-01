-- Conversations in the app (PLAN §6.18, 2026-10-01).
--
-- The app keeps several chats, like an LLM client, and sends the id of the one
-- a message was written in. The agent's short memory is kept per conversation:
-- the same limits as before (six exchanges, twelve hours, one when tainted),
-- each conversation on its own. '' is the one shared thread of before, and of
-- WhatsApp. The id is also bound into the row's associated data, so a row moved
-- to another conversation no longer decrypts.

ALTER TABLE conversation_turns ADD COLUMN conversation TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_conversation_thread
  ON conversation_turns (principal, conversation, id);

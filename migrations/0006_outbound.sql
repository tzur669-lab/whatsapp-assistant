-- Outbound message tracking (PLAN §6.8).
--
-- `outbound_messages` has existed since migration 0001 and nothing ever wrote
-- to it. That mattered more than it looked: the Cloud API answers 200 with a
-- valid wamid for messages it never delivers, so a reminder marked `sent` on
-- the strength of that 200 alone could never be told apart from one that
-- actually arrived.
--
-- These columns are what makes the status webhook usable: who it was for, which
-- reminder it was, when the last status arrived, and why it failed. Added
-- rather than replacing the table, so a rollback of one version still reads it.

ALTER TABLE outbound_messages ADD COLUMN principal TEXT;
ALTER TABLE outbound_messages ADD COLUMN reminder_id TEXT;
ALTER TABLE outbound_messages ADD COLUMN status_at INTEGER;
ALTER TABLE outbound_messages ADD COLUMN error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_outbound_status
  ON outbound_messages (delivery_status, sent_at);

CREATE INDEX IF NOT EXISTS idx_outbound_reminder
  ON outbound_messages (reminder_id);

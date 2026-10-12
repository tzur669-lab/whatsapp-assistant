-- Routines: numbers and the card (PLAN §6.27, 2026-10-12).
--
-- routine_names.position: the place of the routine in the list on the phone, as the
-- sync sent it, its number is position + 1. NULL for a row from before this
-- migration, until the next sync.
-- routine_runs.announced_at: when the card for a run (what runs, when, a
-- cancel button) went to the reminders conversation, NULL until then.
-- routine_runs.notice_hash: the SHA-256 of the cancel
-- nonce of the two-minute notice, kept beside the hash of the card (cancel_hash) so both buttons work.
ALTER TABLE routine_names ADD COLUMN position INTEGER;
ALTER TABLE routine_runs ADD COLUMN announced_at INTEGER;
ALTER TABLE routine_runs ADD COLUMN notice_hash TEXT;

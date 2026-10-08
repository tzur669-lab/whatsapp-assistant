-- Consent turns (smart conversations, slice 5, 2026-10-08). Not deployed yet,
-- like 0026: both ship together. Its own file because it alters agent_turns
-- (0013), which 0026 does not need.
--
-- agent_turns.kind: a suspended turn waits for the phone's read
-- ('phone', every row before this) or for the user's consent ('consent'). The
-- phone's result path takes only 'phone' rows, and a consent tap only 'consent'.
-- A consent row also keeps, in the clear, what its tap must check
-- synchronously before anything is decrypted: the SHA-256 of the button's
-- nonce, the source asked for (a closed enum), and the app conversation a
-- "this conversation" tap writes its row for. None of these is message text.
ALTER TABLE agent_turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'phone' CHECK (kind IN ('phone', 'consent'));
ALTER TABLE agent_turns ADD COLUMN nonce_hash TEXT;
ALTER TABLE agent_turns ADD COLUMN source TEXT;
ALTER TABLE agent_turns ADD COLUMN conversation TEXT;

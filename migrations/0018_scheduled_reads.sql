-- Scheduled reads (PLAN §6.7, ROADMAP #7, 2026-10-05).
--
-- A scheduled read is a recurring reminder whose occurrence carries a closed
-- action — "send me the weather every morning at 7" — instead of free text.
-- NULL is an ordinary reminder. Code checks the value against a closed list
-- when it reads it. Anything else is delivered as plain text, never run.

ALTER TABLE reminders ADD COLUMN action TEXT;

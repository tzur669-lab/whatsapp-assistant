-- "Time to leave" reminders (PLAN §6.7, ROADMAP #5, 2026-10-06).
--
-- The place of the calendar event a reminder was set to leave for. At the due
-- time the reminder carries a Waze card to it. NULL for every other reminder.
-- Its text holds the event's title, someone else's words: a read that shows a
-- reminder with a place taints the turn.

ALTER TABLE reminders ADD COLUMN place TEXT;

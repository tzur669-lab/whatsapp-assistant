-- The screen agent answers in the conversation it was confirmed in (PLAN §6.28,
-- 2026-10-13).
--
-- screen_tasks.in_reply_to: the app message id of the turn that confirmed the
-- task, set once after that turn. The task's messages (approval cards, the
-- end) carry it as `inReplyTo`, so the app puts them in that conversation
-- instead of the reminders one. An id only. A row from before this migration
-- has none and still goes to the reminders conversation.
ALTER TABLE screen_tasks ADD COLUMN in_reply_to TEXT;

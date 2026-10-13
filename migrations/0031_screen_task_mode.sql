-- The screen agent follows the conversation models (PLAN §6.28, 2026-10-13).
--
-- screen_tasks.mode: the conversation the task was confirmed in. A local task
-- asks only the Groq screen models, a smart task only the Gemini ones, and a
-- task never crosses. A row from before this migration is local.
-- screen_model_day: screen-step tokens per Groq model per Asia/Jerusalem day,
-- so the screen agent never takes more than its share of a model daily budget
-- from the chat. Ids, a day and a count only.
ALTER TABLE screen_tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'local' CHECK (mode IN ('local', 'smart'));

CREATE TABLE screen_model_day (
  principal TEXT NOT NULL,
  local_day TEXT NOT NULL,
  model     TEXT NOT NULL,
  tokens    INTEGER NOT NULL,
  PRIMARY KEY (principal, local_day, model)
);

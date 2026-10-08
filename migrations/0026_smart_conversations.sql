-- Smart conversations (Gemini), 2026-10-08. Not deployed yet: later slices
-- append their tables to this same file before it ships.
--
-- model_day_requests: requests per model per Pacific day (Google resets its
-- daily quotas at midnight Pacific), for models whose entry declares
-- `dayRequests`. Read and written synchronously inside TokenBudget.fits/reserve
-- (src/agent/budget.ts), so it outlives the Durable Object's memory. Only the
-- current day's rows are kept.

CREATE TABLE model_day_requests (
  day   TEXT NOT NULL,
  model TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (day, model)
);

-- conversation_modes: each app conversation's mode, recorded once by its first
-- message and never changed (smart conversations, slice 3). Written inside the
-- same transaction as the inbound dedupe insert (Repository.recordInbound): the
-- first writer wins, and a later message that declares the other mode is
-- refused with 422. The shared thread ('') never has a row: it is always local.
-- Deleted by /forget and /pair off. Rows unused for 30 days are purged.
CREATE TABLE conversation_modes (
  principal    TEXT NOT NULL,
  conversation TEXT NOT NULL,
  mode         TEXT NOT NULL CHECK (mode IN ('smart', 'local')),
  last_used    INTEGER NOT NULL,
  PRIMARY KEY (principal, conversation)
);

-- conversation_consents: a data source the user allowed for the rest of one
-- smart conversation (used from slice 5). Same cleanup as conversation_modes.
CREATE TABLE conversation_consents (
  principal    TEXT NOT NULL,
  conversation TEXT NOT NULL,
  source       TEXT NOT NULL,
  last_used    INTEGER NOT NULL,
  PRIMARY KEY (principal, conversation, source)
);

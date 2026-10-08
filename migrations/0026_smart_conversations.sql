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

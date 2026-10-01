-- Quotas shown in the app (2026-10-01).
--
-- groq_limits: the last rate-limit headers Groq sent for each model — the
-- daily request bucket and the per-minute token bucket — and when. Numbers
-- only: no request, no response body.
--
-- groq_token_spend: tokens each model used, as Groq billed them in the
-- response, for the rolling 24 hours Groq's daily token limit is counted over.
-- Groq does not report that limit in any header, so it is counted here. Rows
-- older than a day are deleted when read.
--
-- worker_requests: requests that reached this object, per UTC day — the day
-- Cloudflare's free 100,000 resets on. The server's own count.

CREATE TABLE IF NOT EXISTS groq_limits (
  model              TEXT PRIMARY KEY,
  limit_requests     INTEGER,
  remaining_requests INTEGER,
  reset_requests_at  INTEGER,
  requests_seen_at   INTEGER,
  limit_tokens       INTEGER,
  remaining_tokens   INTEGER,
  reset_tokens_at    INTEGER,
  tokens_seen_at     INTEGER
);

CREATE TABLE IF NOT EXISTS groq_token_spend (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  model  TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_groq_token_spend ON groq_token_spend (model, at);

CREATE TABLE IF NOT EXISTS worker_requests (
  day   TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);

-- The bot learns the user (block K, K1, PLAN §6.31, 2026-10-14).
--
-- Off by default (`/learn on`). Nothing here is ever sent to a model, logged,
-- or used to change policy, tiers or limits (invariant 8).
--
-- learn_events: one row per learning event. `kind` is a closed set:
--   miss       — a copy of what "לא הבנת" kept, `confidence` 'reported'
--   rephrase   — a failed request and its rephrase, ONE row holding both
--                (one ciphertext `{ failed, fixed }`), `confidence` 'heuristic'
--   undo       — an Undo tapped: tool and seconds in `meta`, no text
--   confirm_no — a confirmation declined: tool and seconds, no text
--   leave      — a "time to leave" reminder: minutes and whether they were said
-- `ciphertext` is AES-GCM (src/security/crypto.ts), bound to principal and id;
-- NULL for the kinds that carry no text. `meta` is JSON of closed codes and
-- integers only. Kept 60 days, the newest 200.
--
-- learn_weeks: counters per week (Sunday, Asia/Jerusalem), kept 26 weeks.
CREATE TABLE learn_events (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('miss', 'rephrase', 'undo', 'confirm_no', 'leave')),
  confidence TEXT CHECK (confidence IN ('reported', 'heuristic') OR confidence IS NULL),
  ciphertext TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX learn_events_by_principal ON learn_events (principal, created_at);

CREATE TABLE learn_weeks (
  principal TEXT NOT NULL,
  week_start TEXT NOT NULL,
  messages INTEGER NOT NULL DEFAULT 0,
  misses INTEGER NOT NULL DEFAULT 0,
  rephrases INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (principal, week_start)
);

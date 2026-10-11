-- Routines, stage 2 (PLAN §6.27, 2026-10-11). The steps live on the phone
-- only. The server knows a routine by the user's own name for it, the target
-- app's label, and the SHA-256 of its steps.
--
-- routine_names: replaced as a whole by every signed sync from the paired app.
-- routine_runs: one scheduled run each, its own table rather than a kind of
-- reminder, so no reminder path (digest, list, repeat, give-up) ever sees one.
-- Each status step is one conditional UPDATE: scheduled -> noticed -> pushed
-- -> claimed -> done | unverified | failed | unknown, or -> cancelled |
-- expired | changed. `cancel_hash` is the SHA-256 of the cancel button's nonce.
-- None of these columns is message text.
CREATE TABLE routine_names (
  principal  TEXT NOT NULL,
  routine_id TEXT NOT NULL,
  name       TEXT NOT NULL,
  step_hash  TEXT NOT NULL,
  app_label  TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal, routine_id)
);

CREATE TABLE routine_runs (
  run_id      TEXT PRIMARY KEY,
  principal   TEXT NOT NULL,
  routine_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  app_label   TEXT NOT NULL,
  step_hash   TEXT NOT NULL,
  due_at_utc  INTEGER NOT NULL,
  tz          TEXT NOT NULL,
  cancel_hash TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN (
                'scheduled', 'noticed', 'pushed', 'claimed',
                'done', 'unverified', 'failed', 'unknown',
                'cancelled', 'expired', 'changed')),
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  pushed_at   INTEGER,
  claimed_at  INTEGER,
  settled_at  INTEGER
);

CREATE INDEX routine_runs_status_due ON routine_runs (status, due_at_utc);

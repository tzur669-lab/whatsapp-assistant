-- Confirmation and undo records (PLAN §6.5).
--
-- `input_json` is the validated input as it was when the preview was rendered.
-- Execution always uses this row, never a re-parse of the original message.
-- `input_hash` exists so a row that changed underneath us is refused rather
-- than executed.

CREATE TABLE IF NOT EXISTS pending_actions (
  id          TEXT PRIMARY KEY,
  tool        TEXT NOT NULL,
  input_json  TEXT NOT NULL,
  input_hash  TEXT NOT NULL,
  summary     TEXT NOT NULL,
  tier        INTEGER NOT NULL,
  principal   TEXT NOT NULL,
  nonce_hash  TEXT NOT NULL,
  status      TEXT NOT NULL,          -- pending | executed | cancelled | expired
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  executed_at INTEGER,
  result_ref  TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_status
  ON pending_actions (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_pending_principal
  ON pending_actions (principal, status);

CREATE TABLE IF NOT EXISTS undo_actions (
  id                TEXT PRIMARY KEY,
  tool              TEXT NOT NULL,
  compensating_json TEXT NOT NULL,
  principal         TEXT NOT NULL,
  nonce_hash        TEXT NOT NULL,
  status            TEXT NOT NULL,    -- pending | used | expired
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_undo_status
  ON undo_actions (status, expires_at);

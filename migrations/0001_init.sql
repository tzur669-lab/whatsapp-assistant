-- Phase 1 schema (PLAN §6.8). Later phases add their own numbered migrations.
-- No message bodies are stored anywhere in this schema.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  wamid        TEXT PRIMARY KEY,
  principal    TEXT NOT NULL,          -- keyed hash, never the raw number
  received_at  INTEGER NOT NULL,       -- ms since epoch, our clock
  sent_at      INTEGER NOT NULL,       -- ms since epoch, Meta's clock
  kind         TEXT NOT NULL,          -- text | button | unsupported
  intent       TEXT,
  decision     TEXT,
  error_code   TEXT
);

CREATE INDEX IF NOT EXISTS idx_inbound_received
  ON inbound_messages (received_at);

CREATE TABLE IF NOT EXISTS outbound_messages (
  wamid            TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  sent_at          INTEGER NOT NULL,
  delivery_status  TEXT,
  pricing_category TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  principal     TEXT,
  tool          TEXT,
  tier          INTEGER,
  decision      TEXT NOT NULL,
  input_digest  TEXT,
  outcome       TEXT,
  external_ref  TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);

CREATE TABLE IF NOT EXISTS counters (
  month         TEXT PRIMARY KEY,      -- YYYY-MM
  wa_sent       INTEGER NOT NULL DEFAULT 0,
  llm_calls     INTEGER NOT NULL DEFAULT 0,
  llm_tokens    INTEGER NOT NULL DEFAULT 0,
  fallbacks     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS window_state (
  principal       TEXT PRIMARY KEY,
  last_inbound_at INTEGER NOT NULL
);

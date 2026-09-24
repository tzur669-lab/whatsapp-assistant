-- Google integration state (PLAN §6.6, §7.2).
--
-- Three short-lived or long-lived things, deliberately kept apart:
--
--   oauth_links   the one-time link sent over WhatsApp. 10 minutes, single use.
--   oauth_states  the `state` + PKCE verifier for one authorization attempt.
--   integrations  the standing grant: a refresh token, stored only as AES-GCM
--                 ciphertext through src/security/crypto.ts, never in the clear.
--
-- Access tokens are absent on purpose. They live in Durable Object memory for
-- the length of one request and are refreshed on expiry or a 401, so there is
-- nothing to steal at rest and nothing to migrate.

CREATE TABLE IF NOT EXISTS integrations (
  provider              TEXT NOT NULL,        -- google
  account               TEXT NOT NULL,        -- primary
  status                TEXT NOT NULL,        -- connected | disconnected
  refresh_token_enc     TEXT,                 -- enc.<version>.<base64> only
  scopes                TEXT NOT NULL DEFAULT '',
  reminders_calendar_id TEXT,                 -- the app-created "Assistant Reminders"
  connected_at          INTEGER,
  updated_at            INTEGER NOT NULL,
  -- A stable code, never a message from Google.
  last_error            TEXT,
  PRIMARY KEY (provider, account)
);

CREATE TABLE IF NOT EXISTS oauth_links (
  id         TEXT PRIMARY KEY,                -- 256 random bits, hex
  principal  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state         TEXT PRIMARY KEY,             -- 256 random bits, hex
  principal     TEXT NOT NULL,
  code_verifier TEXT NOT NULL,                -- PKCE, single use, minutes old
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  used_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_oauth_links_expiry ON oauth_links (expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expiry ON oauth_states (expires_at);

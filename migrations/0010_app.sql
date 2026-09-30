-- The app channel (PLAN §6.18). Forward-only: there is no down migration.
--
--   devices          gains `public_key`: the phone signs every request with a
--                    Keystore key and we keep only its public half. New rows
--                    fill the old `token_hash` with an empty string, which no
--                    bearer token can match, so an older build rolled back
--                    onto this schema still starts and still refuses them.
--                    Every device paired before this migration is revoked —
--                    its bearer token is no longer a credential — and has to
--                    pair again.
--   device_pairings  also remembers the bootstrap code once used (`kind`), the
--                    code itself as ciphertext while it is live (the server
--                    must know it to check the pairing MAC), and which public
--                    key used it, so a pairing whose answer was lost can be
--                    retried by the same phone and by nobody else.
--   app_outbox       every message to the phone, until the phone acks it.
--                    Holds message text (reminder text, replies), so it is
--                    deleted on ack, after 7 days for a reminder and 24 hours
--                    for anything else. Never a voice transcript (§6.10).
--   app_nonces       one row per signed request, kept only as long as the
--                    same request could still be accepted.

ALTER TABLE devices ADD COLUMN public_key TEXT;

UPDATE devices SET revoked_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000 WHERE revoked_at IS NULL;

ALTER TABLE device_pairings ADD COLUMN kind TEXT NOT NULL DEFAULT 'pair';
ALTER TABLE device_pairings ADD COLUMN code_enc TEXT;
ALTER TABLE device_pairings ADD COLUMN public_key_hash TEXT;
ALTER TABLE device_pairings ADD COLUMN device_id TEXT;

ALTER TABLE call_dispatches ADD COLUMN in_reply_to TEXT;

CREATE TABLE IF NOT EXISTS app_outbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,                 -- reply | reminder | digest | call | notice
  reminder_id  TEXT UNIQUE,
  in_reply_to  TEXT,                          -- the client message id this answers
  text         TEXT NOT NULL,
  buttons_json TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  next_push_at INTEGER,                       -- null: no more pushes
  pushes       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_app_outbox_reply ON app_outbox (in_reply_to);
CREATE INDEX IF NOT EXISTS idx_app_outbox_push ON app_outbox (next_push_at);
CREATE INDEX IF NOT EXISTS idx_app_outbox_expiry ON app_outbox (expires_at);

CREATE TABLE IF NOT EXISTS app_nonces (
  device_id  TEXT NOT NULL,
  nonce      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, nonce)
);

CREATE INDEX IF NOT EXISTS idx_app_nonces_expiry ON app_nonces (expires_at);

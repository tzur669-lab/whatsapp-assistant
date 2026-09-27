-- The device companion (PLAN §6.17).
--
--   device_pairings  the one-time code `/pair` sends. 10 minutes, single use.
--                    Only its keyed hash is stored, never the code itself.
--   devices          a paired phone. Its token is stored only as a keyed hash
--                    (DEVICE_TOKEN_PEPPER) and its push address only as AES-GCM
--                    ciphertext. A revoked row stays, so a replayed token is
--                    refused rather than unknown.
--   call_dispatches  one "call X" request, waiting for the phone. Opaque id —
--                    the only thing the push carries. Expires after 2 minutes.
--
-- No contact name the phone matched, and no phone number, is ever written
-- here: the device reports how many contacts matched and what happened, never
-- which one (§6.17, "No number ever reaches the Worker").

CREATE TABLE IF NOT EXISTS device_pairings (
  code_hash  TEXT PRIMARY KEY,                -- HMAC(pepper, code), hex
  principal  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER
);

CREATE TABLE IF NOT EXISTS devices (
  id             TEXT PRIMARY KEY,            -- 128 random bits, hex
  principal      TEXT NOT NULL,
  token_hash     TEXT NOT NULL,               -- HMAC(pepper, device token), hex
  push_token_enc TEXT,                        -- enc.<version>.<base64> only
  paired_at      INTEGER NOT NULL,
  revoked_at     INTEGER
);

CREATE TABLE IF NOT EXISTS call_dispatches (
  id         TEXT PRIMARY KEY,                -- 128 random bits, hex, opaque
  principal  TEXT NOT NULL,
  device_id  TEXT NOT NULL,
  -- The words to match, as the user said them — the same kind of content as
  -- a question's stored slots, and purged with the row.
  query_json TEXT NOT NULL,
  status     TEXT NOT NULL,                   -- pending | fetched | placed | cancelled | no_match | expired | failed
  matched    TEXT,                            -- none | one | many, as reported
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_device_pairings_expiry ON device_pairings (expires_at);
CREATE INDEX IF NOT EXISTS idx_devices_principal ON devices (principal, revoked_at);
CREATE INDEX IF NOT EXISTS idx_call_dispatches_open ON call_dispatches (status, expires_at);

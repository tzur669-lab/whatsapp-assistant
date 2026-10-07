-- "לא הבנת" capture (PLAN §6.23, ROADMAP block H part 16, 2026-10-07).
--
-- `seq` orders inbound messages by arrival. It comes from a durable counter in
-- `settings` (`inbound_seq`), not the rowid: this table is pruned, and an empty
-- table would restart the rowid at 1.
--
-- `last_exchange` is the one latest exchange per conversation that reached a
-- model, encrypted (AES-GCM, src/security/crypto.ts), kept an hour. `misses` is
-- what the user's own "לא הבנת" copied from it: encrypted, 30 days, at most 50.
-- Neither is ever logged or sent to a model.

ALTER TABLE inbound_messages ADD COLUMN seq INTEGER;

CREATE TABLE last_exchange (
  principal    TEXT NOT NULL,
  conversation TEXT NOT NULL,
  seq          INTEGER NOT NULL,
  ciphertext   TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (principal, conversation)
);

CREATE TABLE misses (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX misses_by_principal ON misses (principal, created_at);

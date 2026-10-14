-- The weekly review's proposals (block K, K2, PLAN §6.31, 2026-10-14).
--
-- One row per answer. A proposal is a group of one (`ok` / `no`), the weekly
-- question is a group of up to three answers, one `ok` button each. The first
-- accepted row of a group supersedes the rest. `value` is the stored setting
-- a tap applies — never one read from the button. `nonce_hash` is SHA-256 of
-- the button's nonce. Nothing here is text, and nothing reaches a model.
--
-- Status moves one way: pending → accepted | declined | superseded | expired
-- | cancelled (`/learn off`). Terminal rows are kept 90 days, and pending rows are
-- marked expired first, never deleted early.
CREATE TABLE learn_proposals (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  group_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('digest_hour', 'leave_min')),
  value INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'declined', 'superseded', 'expired', 'cancelled')),
  nonce_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX learn_proposals_by_group ON learn_proposals (group_id);
CREATE INDEX learn_proposals_by_principal ON learn_proposals (principal, status);

-- Mail cleanup (block L, L5, 2026-10-15): "תארכב את כל הניוזלטרים מהשבוע",
-- confirmed, and `/unarchive` for 7 days.
--
-- One row per confirmed archive: the exact message ids the card showed
-- (`ids_json`, cleared at 7 days), and a temporary Gmail label made for this
-- batch only (`label_name` = בוט/ארכוב-<8 hex>, `label_id` once Google gave
-- it). The label is added before INBOX is removed, so no message is ever
-- archived without the label that brings it back.
--
-- Two independent axes:
--   op:          pending → done | failed, and done | pending → restored
--   label_state: unknown → present | none, and present → deleted | kept (renamed by the user)
-- `exec_until` fences a running archive: while it is in the future, neither
-- `/unarchive` nor the cleanup touches the row (an archive request may still
-- remove INBOX). `claim_at` + `claim_token` are `/unarchive`'s lease.
-- A row is deleted only once 7 days have passed and its label is none,
-- deleted or kept. Only names, ids and counters outlive the message list.
CREATE TABLE mail_archives (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ids_json TEXT,
  op TEXT NOT NULL CHECK (op IN ('pending', 'done', 'failed', 'restored')),
  exec_until INTEGER,
  label_name TEXT NOT NULL,
  label_id TEXT,
  label_state TEXT NOT NULL CHECK (label_state IN ('unknown', 'present', 'none', 'deleted', 'kept')),
  claim_at INTEGER,
  claim_token TEXT,
  restored_at INTEGER,
  cleanup_attempts INTEGER NOT NULL DEFAULT 0,
  next_cleanup_at INTEGER
);

CREATE INDEX mail_archives_by_principal ON mail_archives (principal, created_at);

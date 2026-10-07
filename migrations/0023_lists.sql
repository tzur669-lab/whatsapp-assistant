-- Named lists in the bot (PLAN §6.25, ROADMAP block H part 17, 2026-10-07).
--
-- Private, like notes: no reply of a lists tool reaches the model. A list is
-- found by `name_key` — its name folded, generic words ("רשימת") stripped — so
-- "רשימת קניות" and "קניות" are one list. A list has no duplicate active items
-- (`item_key`, the item folded).
--
-- Removals are soft (`removed_at`), so an Undo restores rows by id and never
-- carries their text. Every change bumps `version`, so a stale Undo refuses
-- instead of overwriting a newer edit. Soft-deleted rows are purged once the
-- Undo window has passed.

CREATE TABLE lists (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL CHECK (name_key <> ''),
  version    INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX lists_active_key ON lists (principal, name_key) WHERE removed_at IS NULL;

CREATE TABLE list_items (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL,
  text       TEXT NOT NULL,
  item_key   TEXT NOT NULL CHECK (item_key <> ''),
  position   INTEGER NOT NULL,
  version    INTEGER NOT NULL DEFAULT 0,
  removed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX list_items_active_key ON list_items (list_id, item_key) WHERE removed_at IS NULL;
CREATE INDEX list_items_by_list ON list_items (list_id, position);

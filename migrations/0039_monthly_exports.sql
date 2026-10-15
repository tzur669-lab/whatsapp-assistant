-- The monthly bookkeeping file (block L, L4, 2026-10-15): on the 1st, last
-- month's expenses and the bills found in Gmail, in one CSV card.
--
-- One row per month sent. The job builds the file first (no state touched),
-- then inserts this row, the card's pending action and the outbox notice in
-- one transaction: the row exists only together with a queued card, so a
-- failed build or send never marks a month done, and `INSERT OR IGNORE` on
-- the key makes a second tick a no-op. Nothing here is text. Kept 400 days.
CREATE TABLE monthly_exports (
  principal TEXT NOT NULL,
  month TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (principal, month)
);

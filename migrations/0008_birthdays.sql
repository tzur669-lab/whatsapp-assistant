-- A local birthday list (PLAN §6.16).
--
-- Deliberately local rather than read from Google Contacts. Contacts would mean
-- a third OAuth scope -- a §14 security decision -- and would hand this
-- assistant every address the user owns in order to answer a question about
-- eight of them. A list the user types is a worse feature and a much better
-- trade.
--
-- `name` is content: stored, never logged. `year` is optional because most
-- people know the date and not the year, and a feature that insists on one
-- would mostly go unused.

CREATE TABLE IF NOT EXISTS birthdays (
  id         TEXT PRIMARY KEY,
  principal  TEXT NOT NULL,
  name       TEXT NOT NULL,
  day        INTEGER NOT NULL,
  month      INTEGER NOT NULL,
  year       INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_birthdays_principal ON birthdays (principal, month, day);

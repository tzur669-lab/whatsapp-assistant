-- iCal feed subscriptions (PLAN §6.15).
--
-- One subscribed feed per row, and its events expanded into a window and cached.
-- The cache exists because a feed is a file over the network: fetching a
-- semester's timetable every time the calendar is read would be slow, wasteful
-- and rate-limited by the other end.
--
-- `ical_events` holds event titles, which are content. They are storage, never a
-- log field, and they are replaced wholesale on every refresh rather than
-- merged — a stale event that no longer exists in the feed is worse than a
-- missing one.

CREATE TABLE IF NOT EXISTS ical_feeds (
  id              TEXT PRIMARY KEY,
  principal       TEXT NOT NULL,
  url             TEXT NOT NULL,
  etag            TEXT,
  last_fetched_at INTEGER,
  last_error      TEXT,
  event_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ical_feeds_principal ON ical_feeds (principal);

CREATE TABLE IF NOT EXISTS ical_events (
  feed_id   TEXT NOT NULL,
  uid       TEXT NOT NULL,
  title     TEXT NOT NULL,
  start_utc INTEGER NOT NULL,
  end_utc   INTEGER NOT NULL,
  all_day   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (feed_id, uid, start_utc)
);

CREATE INDEX IF NOT EXISTS idx_ical_events_window ON ical_events (start_utc, end_utc);

-- The stock portfolio (PLAN §6.24, ROADMAP block H part 19, 2026-10-08).
--
-- "יש לי 10 מניות אפל ב-150". Private like notes: a holding never reaches the
-- model. Money in integer minor units of the holding's own currency (cents or
-- agorot), quantity in thousandths of a share. A removal is soft (removed_at)
-- and every change bumps version, so an Undo is refused when the row changed.
--
-- quote_cache keeps the last good quote per symbol for a few minutes, and
-- serves it, labelled stale, when the source fails.

CREATE TABLE holdings (
  id              TEXT PRIMARY KEY,
  principal       TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  market          TEXT NOT NULL CHECK (market IN ('us', 'tase')),
  name            TEXT,
  quantity_milli  INTEGER NOT NULL CHECK (quantity_milli > 0 AND quantity_milli <= 10000000000),
  buy_price_minor INTEGER CHECK (buy_price_minor > 0),
  currency        TEXT NOT NULL CHECK (currency IN ('USD', 'ILS')),
  version         INTEGER NOT NULL DEFAULT 0,
  removed_at      INTEGER,
  added_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX holdings_active ON holdings (principal, symbol, market) WHERE removed_at IS NULL;

CREATE TABLE quote_cache (
  symbol           TEXT NOT NULL,
  market           TEXT NOT NULL CHECK (market IN ('us', 'tase')),
  price_minor      INTEGER NOT NULL CHECK (price_minor > 0),
  prev_close_minor INTEGER,
  currency         TEXT NOT NULL CHECK (currency IN ('USD', 'ILS')),
  as_of            INTEGER NOT NULL,
  market_open      INTEGER NOT NULL,
  fetched_at       INTEGER NOT NULL,
  PRIMARY KEY (symbol, market)
);

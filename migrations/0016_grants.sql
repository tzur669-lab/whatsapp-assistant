-- Separate Google grants (PLAN §6.6, 2026-10-01).
--
-- A one-time link and an authorization attempt now say which grant they are
-- for — calendar, gmail, tasks or drive — so the callback stores the token
-- under that grant's own `integrations` row and nowhere else. Rows from before
-- were all for the calendar.

ALTER TABLE oauth_links ADD COLUMN grant_name TEXT NOT NULL DEFAULT 'calendar';
ALTER TABLE oauth_states ADD COLUMN grant_name TEXT NOT NULL DEFAULT 'calendar';

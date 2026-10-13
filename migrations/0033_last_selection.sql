-- Inherited tool groups (block J, J2a, 2026-10-13).
--
-- last_selection: the tool groups code chose for the latest local agent turn
-- of each conversation, so a short follow-up that names no group ("תבטל אותה")
-- is offered the same groups instead of the full catalog. Group names are
-- code constants, never message content. One row per conversation, written
-- when the turn's plan is made and ordered by the inbound `seq`, so an older
-- turn never overwrites a newer one.
--
-- groups: comma-separated group names, empty for the full set (never inherited).
-- tainted: the turn started tainted (someone else's words): never inherited.
-- ran: set by the same turn (`seq =`) when it ran a tool and every tool it ran
--      is in `groups`. Only then is it inherited.
-- Rows older than 10 minutes are useless and purged on every alarm.
CREATE TABLE last_selection (
  principal TEXT NOT NULL,
  conversation TEXT NOT NULL,
  seq INTEGER NOT NULL,
  groups TEXT NOT NULL,
  tainted INTEGER NOT NULL DEFAULT 0,
  ran INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (principal, conversation)
);

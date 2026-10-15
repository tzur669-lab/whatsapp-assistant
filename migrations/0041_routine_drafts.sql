-- The bot builds routines (docs/plans/routine-builder.md, part 1, 2026-10-15).
--
-- routine_names.tested: the phone says whether a routine passed one attended
-- full run of its current steps. A recorded or model-drafted routine is synced
-- untested (0) and `routine.run` refuses it. Every older row, and a sync that
-- does not say, is tested (1).
ALTER TABLE routine_names ADD COLUMN tested INTEGER NOT NULL DEFAULT 1;

-- One row per confirmed "build a routine" request. The request's words
-- (goal, inputs, words) are sealed with AES-GCM and cleared as soon as the
-- model answered or the draft ended earlier. The screen the phone read and the
-- steps drafted from it are never stored: they cross in memory, inside one
-- response. Every move is one conditional UPDATE:
--   confirmed -> pushed -> claimed -> drafted -> offered | build_failed | slot_busy
--   claimed -> failed, pushed -> expired, claimed | drafted -> unknown (10 min)
--   any open -> preempted (a routine is due)
-- `screen_at` marks the one screen post: a repeat finds it set.
CREATE TABLE routine_drafts (
  draft_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  package TEXT NOT NULL,
  app_label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('local', 'smart')),
  sealed TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'confirmed', 'pushed', 'claimed', 'drafted',
    'offered', 'build_failed', 'slot_busy', 'failed', 'expired', 'unknown', 'preempted'
  )),
  reason TEXT,
  in_reply_to TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  pushed_at INTEGER,
  claimed_at INTEGER,
  screen_at INTEGER,
  drafted_at INTEGER,
  settled_at INTEGER
);

CREATE INDEX routine_drafts_by_status ON routine_drafts (principal, status);

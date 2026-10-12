-- The screen agent (PLAN §6.28, 2026-10-12).
--
-- screen_allow: the apps the user turned on for the agent on the phone, with
-- the per-app "ask before every tap" switch. Replaced as a whole by every
-- signed sync. Package names and the app's own label only.
--
-- screen_tasks: one confirmed task each. `sealed` is the task's words and the
-- approved inputs, AES-GCM (`encryptToken`, associated data `screen_task` +
-- the task id), cleared when the task ends. No screen text is ever stored:
-- `action` is the decided action as codes and the phone's binding, `history`
-- the past steps as codes, `hashes` the last three screen hashes (SHA-256 the
-- phone computed). Each status move is one conditional UPDATE:
--   confirmed -> pushed -> running <-> awaiting_approval -> released -> running
--   -> stopped | preempted | deadline | done | failed | unknown
-- `approval_nonce` and `stop_nonce` are kept as is: a lost answer must be
-- answerable with the same nonce, and the chat card in the outbox holds it too.
CREATE TABLE screen_allow (
  principal     TEXT NOT NULL,
  package       TEXT NOT NULL,
  label         TEXT NOT NULL,
  ask_every_tap INTEGER NOT NULL,
  position      INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (principal, package)
);

CREATE TABLE screen_tasks (
  task_id             TEXT PRIMARY KEY,
  principal           TEXT NOT NULL,
  package             TEXT NOT NULL,
  app_label           TEXT NOT NULL,
  sealed              TEXT,
  input_count         INTEGER NOT NULL,
  status              TEXT NOT NULL CHECK (status IN (
                        'confirmed', 'pushed', 'running', 'awaiting_approval', 'released',
                        'stopped', 'preempted', 'deadline', 'done', 'failed', 'unknown')),
  step                INTEGER NOT NULL DEFAULT 0,
  action_id           TEXT,
  action              TEXT,
  cls                 TEXT,
  why                 TEXT,
  approval_nonce      TEXT,
  approval_expires_at INTEGER,
  max_class           TEXT,
  history             TEXT NOT NULL DEFAULT '[]',
  hashes              TEXT NOT NULL DEFAULT '[]',
  typed_non_search    INTEGER NOT NULL DEFAULT 0,
  dispatched          INTEGER NOT NULL DEFAULT 0,
  waits               INTEGER NOT NULL DEFAULT 0,
  tokens              INTEGER NOT NULL DEFAULT 0,
  inflight_until      INTEGER,
  stop_nonce          TEXT NOT NULL,
  outcome             TEXT,
  reason              TEXT,
  local_day           TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  pushed_at           INTEGER,
  claimed_at          INTEGER,
  deadline_at         INTEGER,
  settled_at          INTEGER
);

CREATE INDEX screen_tasks_principal_status ON screen_tasks (principal, status);
CREATE INDEX screen_tasks_day ON screen_tasks (principal, local_day);

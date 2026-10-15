-- Mail follow-ups (block L, L2, 2026-10-15): "תזכיר לי אם לא ענו לי על
-- המייל לדני עד יום חמישי ב-9".
--
-- One row per follow-up of one sent mail. Code found the sent message
-- (`sent_id`, its thread, its RFC Message-ID for a reply's In-Reply-To) and
-- holds the recipients' header only to address a reminder draft: it is never
-- rendered and never reaches a model. `subject` is the user's own subject,
-- shown in the notice.
--
-- The hourly tick reads the thread first, then moves the row and queues its
-- notice in one transaction. Status moves one way:
--   open → answered | bounced | notified | unsure | cancelled
--   notified → used | dismissed | cancelled
-- `attempts` counts Gmail failures in a row (3 → unsure). `day_marker` is the
-- local day of the last "could not check" notice, so there is one a day.
-- `nonce_hash` is SHA-256 of the notice button's nonce. `pending_id` is the
-- draft's confirmation, created in the same transaction as `used`.
-- Settled rows are kept 90 days, like reminders.
CREATE TABLE mail_followups (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  sent_id TEXT NOT NULL,
  sent_message_id TEXT,
  sent_at INTEGER NOT NULL,
  subject TEXT NOT NULL,
  to_header TEXT,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'notified', 'answered', 'bounced', 'unsure', 'used', 'dismissed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  nonce_hash TEXT,
  day_marker TEXT,
  pending_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX mail_followups_due ON mail_followups (principal, status, due_at);

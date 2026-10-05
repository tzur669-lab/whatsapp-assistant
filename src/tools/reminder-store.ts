/**
 * Reminder storage and the claim/lease protocol (PLAN §6.7).
 *
 * The alarm handler has to be idempotent whatever the platform's retry
 * semantics do, so delivery is a two-step: a row is *claimed* under a short
 * lease before it is sent, and only marked sent afterwards.
 *
 *   crash before the send  -> the lease expires, the row is claimed again
 *   crash after the send   -> the row is already `sent`, and is not re-claimed
 *
 * That is why `claimDue` both reads and writes. A read-then-write from the
 * caller would leave a window where two alarms could pick up the same row.
 *
 * Plain TypeScript over `SqlDriver`: no platform imports, so the same code runs
 * under the Node Plan B (PLAN §3.4).
 */
import type { SqlDriver } from '../core/sql.js';
import { nextOccurrence } from '../time/recur.js';
import type { RecurRule } from '../time/recur.js';
import { localPartsOf } from '../time/tz.js';

/** How long a claim holds before another alarm may take the row. */
const LEASE_MS = 60_000;

/** After this many tries the reminder is given up on and the user is told. */
const MAX_ATTEMPTS = 5;

export type ReminderStatus = 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled' | 'done';

export type Reminder = {
  id: string;
  principal: string;
  text: string;
  dueAtUtc: number;
  localWallTime: string;
  tz: string;
  status: ReminderStatus;
  attempts: number;
  /** The Google Calendar event standing in for a send we cannot make (§6.7). */
  backupEventId: string | null;
  /** The series this occurrence belongs to, for a recurring reminder (B6). */
  seriesId: string | null;
  /** The series' rule, joined in on reads. Null for a one-off. */
  rule: RecurRule | null;
};

export type ClaimedReminder = Reminder & {
  /** How far past its due time this delivery is. Zero when on time. */
  lateByMs: number;
};

export class ReminderStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  schedule(params: {
    principal: string;
    text: string;
    dueAtUtc: number;
    localWallTime: string;
    tz: string;
    /** Present for a recurring reminder: this is its first occurrence (B6). */
    rule?: RecurRule;
  }): Reminder {
    const id = randomHex(12);
    const timestamp = this.now();
    const seriesId = params.rule ? randomHex(12) : null;

    this.sql.transaction(() => {
      if (params.rule && seriesId) {
        this.sql.exec(
          `INSERT INTO reminder_series (id, principal, rule_json, status, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?)`,
          seriesId,
          params.principal,
          JSON.stringify(params.rule),
          timestamp,
          timestamp,
        );
      }
      this.sql.exec(
        `INSERT INTO reminders
           (id, principal, text, due_at_utc, local_wall_time, tz, status, attempts, series_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?, ?)`,
        id,
        params.principal,
        params.text,
        params.dueAtUtc,
        params.localWallTime,
        params.tz,
        seriesId,
        timestamp,
        timestamp,
      );
    });

    return {
      id,
      principal: params.principal,
      text: params.text,
      dueAtUtc: params.dueAtUtc,
      localWallTime: params.localWallTime,
      tz: params.tz,
      status: 'scheduled',
      attempts: 0,
      backupEventId: null,
      seriesId,
      rule: params.rule ?? null,
    };
  }

  byId(id: string): Reminder | null {
    const row = this.sql.exec(`${SELECT_WITH_RULE} WHERE r.id = ?`, id)[0];
    return row ? toReminder(row) : null;
  }

  listUpcoming(principal: string, limit = 20): Reminder[] {
    const rows = this.sql.exec(
      `${SELECT_WITH_RULE}
       WHERE r.principal = ? AND r.status = 'scheduled' AND r.due_at_utc >= ?
       ORDER BY r.due_at_utc ASC
       LIMIT ?`,
      principal,
      this.now(),
      limit,
    );
    return rows.map(toReminder);
  }

  /**
   * Reminders that are due and still waiting (PLAN §6.12).
   *
   * A `scheduled` row past its time is normally transient — the next alarm
   * claims it — but one held over a shut 24-hour window can sit here for hours.
   * That is exactly what a digest should lead with: not "you have a reminder",
   * but "this one did not reach you".
   */
  listOverdue(principal: string, limit = 20): Reminder[] {
    const rows = this.sql.exec(
      `${SELECT_WITH_RULE}
       WHERE r.principal = ? AND r.status = 'scheduled' AND r.due_at_utc < ?
       ORDER BY r.due_at_utc ASC
       LIMIT ?`,
      principal,
      this.now(),
      limit,
    );
    return rows.map(toReminder);
  }

  /**
   * Take ownership of every reminder that is due, under a lease.
   *
   * A row is eligible when it is `scheduled`, or when it is `sending` with an
   * expired lease — that second case is a previous run that died mid-flight.
   * Rows that have exhausted their attempts are retired here rather than being
   * handed back again.
   */
  claimDue(): ClaimedReminder[] {
    const now = this.now();
    // The claim and the next occurrences it writes land together: a crash
    // between them would leave a first claim whose successor nothing writes.
    return this.sql.transaction(() => this.claimDueInside(now));
  }

  private claimDueInside(now: number): ClaimedReminder[] {

    this.sql.exec(
      `UPDATE reminders SET status = 'failed', lease_until = NULL, updated_at = ?
       WHERE status IN ('scheduled', 'sending')
         AND due_at_utc <= ?
         AND attempts >= ?
         AND (lease_until IS NULL OR lease_until <= ?)`,
      now,
      now,
      MAX_ATTEMPTS,
      now,
    );

    const rows = this.sql.exec(
      `UPDATE reminders
       SET status = 'sending',
           lease_until = ?,
           attempts = attempts + 1,
           updated_at = ?
       WHERE status IN ('scheduled', 'sending')
         AND due_at_utc <= ?
         AND attempts < ?
         AND (lease_until IS NULL OR lease_until <= ?)
       RETURNING *`,
      now + LEASE_MS,
      now,
      now,
      MAX_ATTEMPTS,
      now,
    );

    // A recurring occurrence writes the next one on its first claim only. A
    // retry or a requeue is a later claim of the same occurrence, so it never
    // starts a second successor; the unique index backs that up (B6).
    for (const row of rows) {
      if (Number(row['attempts']) === 1 && typeof row['series_id'] === 'string') {
        this.materializeNext(row, now);
      }
    }

    return rows.map((row) => ({
      ...toReminder(row),
      lateByMs: Math.max(0, now - Number(row['due_at_utc'])),
    }));
  }

  /**
   * Write the occurrence after this one, if its series is still running.
   *
   * After `max(due, now)`, not after `due`: a reminder delivered three days
   * late is followed by the next one still ahead, not by three catching up.
   */
  private materializeNext(row: Record<string, unknown>, now: number): void {
    const seriesId = String(row['series_id']);
    const series = this.sql.exec(
      `SELECT rule_json FROM reminder_series WHERE id = ? AND status = 'active'`,
      seriesId,
    )[0];
    const rule = series ? parseRule(series['rule_json']) : null;
    if (!rule) return;

    const tz = String(row['tz']);
    const nextAt = nextOccurrence(rule, Math.max(Number(row['due_at_utc']), now), tz);
    if (nextAt === null) return;

    this.sql.exec(
      `INSERT OR IGNORE INTO reminders
         (id, principal, text, due_at_utc, local_wall_time, tz, status, attempts, series_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?, ?)`,
      randomHex(12),
      String(row['principal']),
      String(row['text']),
      nextAt,
      wallTimeOf(nextAt, tz),
      tz,
      seriesId,
      now,
      now,
    );
  }

  /** Record the calendar event standing in for this reminder (PLAN §6.7). */
  setBackupEvent(id: string, eventId: string | null): void {
    this.sql.exec(
      'UPDATE reminders SET backup_event_id = ?, channel = ?, updated_at = ? WHERE id = ?',
      eventId,
      eventId ? 'calendar' : 'whatsapp',
      this.now(),
      id,
    );
  }

  markSent(id: string, wamid: string): void {
    this.sql.exec(
      `UPDATE reminders SET status = 'sent', wamid = ?, lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      wamid,
      this.now(),
      id,
    );
  }

  /** Hand the row back for another try. The attempt has already been counted. */
  markFailed(id: string): void {
    this.sql.exec(
      `UPDATE reminders SET status = 'scheduled', lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      this.now(),
      id,
    );
  }

  /**
   * Stop trying. For a failure that will not come right — an undeliverable
   * recipient, a shut window, a bad token — where each retry spends one of a
   * thousand free messages to learn what the first attempt already said (§6.8).
   *
   * The row lands in `failed`, so `takeFailed` reports it once, and the Google
   * Calendar stand-in written at creation stays where it is.
   */
  abandon(id: string): void {
    this.sql.exec(
      `UPDATE reminders SET status = 'failed', lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'sending'`,
      this.now(),
      id,
    );
  }

  /**
   * A message Meta accepted and later reported as failed (PLAN §6.8).
   *
   * This is the case the whole outbound table exists for: until the status
   * webhook arrived, this reminder was `sent` and nothing would ever look at it
   * again. Returns whether it goes back in the queue or is given up on.
   */
  reopenForRetry(id: string): { retrying: boolean } | null {
    // An occurrence of a series the user has since ended is not sent again,
    // and not reported as given up either: it was cancelled (B6).
    const ended = this.sql.exec(
      `UPDATE reminders SET status = 'cancelled', lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'sent'
         AND series_id IN (SELECT id FROM reminder_series WHERE status = 'cancelled')
       RETURNING id`,
      this.now(),
      id,
    );
    if (ended.length > 0) return { retrying: false };

    const requeued = this.sql.exec(
      `UPDATE reminders
       SET status = 'scheduled', lease_until = NULL, wamid = NULL, updated_at = ?
       WHERE id = ? AND status = 'sent' AND attempts < ?
       RETURNING id`,
      this.now(),
      id,
      MAX_ATTEMPTS,
    );
    if (requeued.length > 0) return { retrying: true };

    return this.retireSent(id) ? { retrying: false } : null;
  }

  /**
   * Give up on a delivered-then-failed reminder without another attempt, for a
   * failure that will answer the same way every time. The row lands in `failed`,
   * so it is reported once and the calendar stand-in stays put.
   */
  retireSent(id: string): boolean {
    const rows = this.sql.exec(
      `UPDATE reminders SET status = 'failed', lease_until = NULL, updated_at = ?
       WHERE id = ? AND status = 'sent'
       RETURNING id`,
      this.now(),
      id,
    );
    return rows.length > 0;
  }

  /**
   * Only the owner may cancel. Returns false if there was nothing to cancel.
   *
   * An occurrence of a recurring reminder ends its whole series, whatever state
   * this occurrence is in: between a preview and the tap it may have fired and
   * been followed by the next one, and "cancel" still means the series (B6).
   */
  cancel(id: string, principal: string): boolean {
    const seriesId = this.sql.exec(
      'SELECT series_id FROM reminders WHERE id = ? AND principal = ?',
      id,
      principal,
    )[0]?.['series_id'];
    if (typeof seriesId === 'string') return this.cancelSeries(seriesId, principal);

    const rows = this.sql.exec(
      `UPDATE reminders SET status = 'cancelled', lease_until = NULL, updated_at = ?
       WHERE id = ? AND principal = ? AND status IN ('scheduled', 'sending')
       RETURNING id`,
      this.now(),
      id,
      principal,
    );
    return rows.length > 0;
  }

  /** End a series and every occurrence still waiting. True if anything changed. */
  cancelSeries(seriesId: string, principal: string): boolean {
    return this.sql.transaction(() => {
      const now = this.now();
      const series = this.sql.exec(
        `UPDATE reminder_series SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND principal = ? AND status = 'active'
         RETURNING id`,
        now,
        seriesId,
        principal,
      );
      const rows = this.sql.exec(
        `UPDATE reminders SET status = 'cancelled', lease_until = NULL, updated_at = ?
         WHERE series_id = ? AND principal = ? AND status IN ('scheduled', 'sending')
         RETURNING id`,
        now,
        seriesId,
        principal,
      );
      return series.length > 0 || rows.length > 0;
    });
  }

  /**
   * Move a waiting reminder to a new time (B8). Only a `scheduled` row moves:
   * one that fired between the preview and the tap is left alone, and the
   * caller says so. A recurring occurrence moves alone; its series goes on.
   */
  reschedule(id: string, principal: string, dueAtUtc: number, localWallTime: string): boolean {
    const rows = this.sql.exec(
      `UPDATE OR IGNORE reminders
       SET due_at_utc = ?, local_wall_time = ?, updated_at = ?
       WHERE id = ? AND principal = ? AND status = 'scheduled'
       RETURNING id`,
      dueAtUtc,
      localWallTime,
      this.now(),
      id,
      principal,
    );
    return rows.length > 0;
  }

  /**
   * When the next alarm should fire, or null if there is nothing pending.
   *
   * Leased rows are included on purpose: if the run holding the lease dies, the
   * alarm still needs to come back and pick the row up.
   */
  nextDueAt(): number | null {
    const rows = this.sql.exec(
      `SELECT MIN(due_at_utc) AS next FROM reminders
       WHERE status IN ('scheduled', 'sending') AND attempts < ?`,
      MAX_ATTEMPTS,
    );
    const next = rows[0]?.['next'];
    return typeof next === 'number' ? next : null;
  }

  /** Reminders that gave up, so the user can be told once. */
  takeFailed(): Reminder[] {
    const rows = this.sql.exec(
      `UPDATE reminders SET status = 'done', updated_at = ? WHERE status = 'failed' RETURNING *`,
      this.now(),
    );
    return rows.map(toReminder);
  }
}

function toReminder(row: Record<string, unknown>): Reminder {
  return {
    id: String(row['id']),
    principal: String(row['principal']),
    text: String(row['text']),
    dueAtUtc: Number(row['due_at_utc']),
    localWallTime: String(row['local_wall_time']),
    tz: String(row['tz']),
    status: String(row['status']) as ReminderStatus,
    attempts: Number(row['attempts']),
    backupEventId:
      typeof row['backup_event_id'] === 'string' && row['backup_event_id'].length > 0
        ? row['backup_event_id']
        : null,
    seriesId: typeof row['series_id'] === 'string' ? row['series_id'] : null,
    rule: parseRule(row['rule_json']),
  };
}

/** Reads join the series' rule, so a list can say an occurrence repeats. */
const SELECT_WITH_RULE = `SELECT r.*, s.rule_json AS rule_json
  FROM reminders r LEFT JOIN reminder_series s ON s.id = r.series_id`;

/** A stored rule, or null for anything that does not read as one. */
function parseRule(value: unknown): RecurRule | null {
  if (typeof value !== 'string') return null;
  let parsed: Partial<RecurRule>;
  try {
    parsed = JSON.parse(value) as Partial<RecurRule>;
  } catch {
    return null;
  }
  if (parsed.freq !== 'daily' && parsed.freq !== 'weekly' && parsed.freq !== 'monthly') return null;
  if (typeof parsed.hour !== 'number' || typeof parsed.minute !== 'number') return null;
  return {
    freq: parsed.freq,
    hour: parsed.hour,
    minute: parsed.minute,
    ...(Array.isArray(parsed.weekdays)
      ? { weekdays: parsed.weekdays.filter((d): d is number => typeof d === 'number') }
      : {}),
    ...(typeof parsed.day === 'number' ? { day: parsed.day } : {}),
  };
}

/** `2026-09-25T14:00`, the wall time stored beside the instant (§6.8). */
function wallTimeOf(utcMs: number, tz: string): string {
  const p = localPartsOf(utcMs, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

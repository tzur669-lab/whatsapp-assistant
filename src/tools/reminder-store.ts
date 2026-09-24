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
  }): Reminder {
    const id = randomHex(12);
    const timestamp = this.now();

    this.sql.exec(
      `INSERT INTO reminders
         (id, principal, text, due_at_utc, local_wall_time, tz, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?, ?)`,
      id,
      params.principal,
      params.text,
      params.dueAtUtc,
      params.localWallTime,
      params.tz,
      timestamp,
      timestamp,
    );

    return {
      id,
      principal: params.principal,
      text: params.text,
      dueAtUtc: params.dueAtUtc,
      localWallTime: params.localWallTime,
      tz: params.tz,
      status: 'scheduled',
      attempts: 0,
    };
  }

  listUpcoming(principal: string, limit = 20): Reminder[] {
    const rows = this.sql.exec(
      `SELECT * FROM reminders
       WHERE principal = ? AND status = 'scheduled' AND due_at_utc >= ?
       ORDER BY due_at_utc ASC
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

    return rows.map((row) => ({
      ...toReminder(row),
      lateByMs: Math.max(0, now - Number(row['due_at_utc'])),
    }));
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

  /** Only the owner may cancel. Returns false if there was nothing to cancel. */
  cancel(id: string, principal: string): boolean {
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
  };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

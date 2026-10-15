/**
 * Mail follow-ups' store (block L, L2, 2026-10-15).
 *
 * A follow-up waits for anyone to reply in a sent mail's thread until a
 * deadline. The hourly tick reads the thread first (no state touched), then
 * moves the row and queues its notice in one transaction (`settle`): a crash
 * before it changes nothing and the next tick reads again; after it, the
 * notice is in the outbox and its push retries deliver it. Two ticks may both
 * read; only the first transaction moves the row.
 *
 * A notice's "draft" button is `tap`: one transaction that checks the nonce,
 * the owner and the age, moves `notified → used`, and asks the caller to
 * issue the draft's confirmation card — so the row and the card it points to
 * are written together. A later tap on a `used` row whose card is still live
 * replaces that card (the reply carrying it may have been lost): the old one
 * is superseded in the same transaction, so at most one can ever run.
 */
import type { SqlDriver, SqlRow } from '../core/sql.js';
import { sha256Hex } from '../confirm/pending.js';

export const MAX_ACTIVE_FOLLOWUPS = 20;
/** Due rows read per tick: each is one Gmail call against the Worker's subrequest cap. */
export const MAX_FOLLOWUPS_PER_TICK = 5;
/** Gmail failures in a row before the follow-up is reported as unsure. */
export const MAX_FOLLOWUP_ATTEMPTS = 3;
/** How long a notice's buttons work. */
export const FOLLOWUP_TAP_MS = 48 * 60 * 60 * 1000;
/** A settled row is kept this long, like a reminder. */
export const FOLLOWUP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type FollowUpStatus = 'open' | 'notified' | 'answered' | 'bounced' | 'unsure' | 'used' | 'dismissed' | 'cancelled';

export type FollowUp = {
  id: string;
  threadId: string;
  sentId: string;
  sentMessageId: string | null;
  sentAt: number;
  subject: string;
  toHeader: string | null;
  dueAt: number;
  status: FollowUpStatus;
  attempts: number;
  pendingId: string | null;
  updatedAt: number;
};

/** What a settle moves an open row to, and whether it gets buttons. */
export type SettleTo = 'answered' | 'bounced' | 'unsure' | 'notified';

export type TapOutcome<T> =
  | { kind: 'card'; card: T }
  | { kind: 'dismissed' }
  /** Wrong nonce or owner, too old, or already handled: one answer for all, never which. */
  | { kind: 'gone' };

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nonceHash(nonce: string): string {
  return sha256Hex(new TextEncoder().encode(`followup:${nonce}`));
}

const STATUSES: readonly FollowUpStatus[] = ['open', 'notified', 'answered', 'bounced', 'unsure', 'used', 'dismissed', 'cancelled'];

function followUpOf(row: SqlRow): FollowUp | null {
  const status = String(row['status']);
  if (!(STATUSES as readonly string[]).includes(status)) return null;
  return {
    id: String(row['id']),
    threadId: String(row['thread_id']),
    sentId: String(row['sent_id']),
    sentMessageId: typeof row['sent_message_id'] === 'string' ? row['sent_message_id'] : null,
    sentAt: Number(row['sent_at']),
    subject: String(row['subject']),
    toHeader: typeof row['to_header'] === 'string' ? row['to_header'] : null,
    dueAt: Number(row['due_at']),
    status: status as FollowUpStatus,
    attempts: Number(row['attempts']),
    pendingId: typeof row['pending_id'] === 'string' ? row['pending_id'] : null,
    updatedAt: Number(row['updated_at']),
  };
}

export class FollowUpStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /**
   * A new follow-up, or `full` at `MAX_ACTIVE_FOLLOWUPS`, or `exists` when this
   * sent mail already has one waiting. The checks and the insert are one transaction.
   */
  create(params: {
    principal: string;
    threadId: string;
    sentId: string;
    sentMessageId: string | null;
    sentAt: number;
    subject: string;
    toHeader: string | null;
    dueAt: number;
  }): { ok: true; id: string } | { ok: false; reason: 'full' | 'exists' } {
    const now = this.now();
    const id = randomHex(16);
    return this.sql.transaction(() => {
      const waiting = this.sql.exec(
        "SELECT sent_id FROM mail_followups WHERE principal = ? AND status IN ('open', 'notified')",
        params.principal,
      );
      if (waiting.some((row) => String(row['sent_id']) === params.sentId)) return { ok: false as const, reason: 'exists' as const };
      if (waiting.length >= MAX_ACTIVE_FOLLOWUPS) return { ok: false as const, reason: 'full' as const };
      this.sql.exec(
        `INSERT INTO mail_followups
           (id, principal, thread_id, sent_id, sent_message_id, sent_at, subject, to_header, due_at, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?)`,
        id,
        params.principal,
        params.threadId,
        params.sentId,
        params.sentMessageId,
        params.sentAt,
        params.subject,
        params.toHeader,
        params.dueAt,
        now,
        now,
      );
      return { ok: true as const, id };
    });
  }

  /** Stop waiting. True when it was still open or notified; anything else is already the state asked for. */
  cancel(principal: string, id: string): boolean {
    const now = this.now();
    return (
      this.sql.exec(
        `UPDATE mail_followups SET status = 'cancelled', updated_at = ?, settled_at = ?
         WHERE id = ? AND principal = ? AND status IN ('open', 'notified') RETURNING id`,
        now,
        now,
        id,
        principal,
      ).length === 1
    );
  }

  /** The follow-ups still waiting, soonest first (`/followups`). */
  active(principal: string): FollowUp[] {
    return this.sql
      .exec(
        "SELECT * FROM mail_followups WHERE principal = ? AND status IN ('open', 'notified') ORDER BY due_at, created_at",
        principal,
      )
      .flatMap((row) => followUpOf(row) ?? []);
  }

  /** Open follow-ups whose deadline passed, at most `MAX_FOLLOWUPS_PER_TICK`. */
  due(principal: string): FollowUp[] {
    return this.sql
      .exec(
        "SELECT * FROM mail_followups WHERE principal = ? AND status = 'open' AND due_at <= ? ORDER BY due_at LIMIT ?",
        principal,
        this.now(),
        MAX_FOLLOWUPS_PER_TICK,
      )
      .flatMap((row) => followUpOf(row) ?? []);
  }

  /**
   * Move an open row and queue its notice, in one transaction. `notice` runs
   * inside it (an `outbox.accept`), with the button nonce when the row becomes
   * `notified`; a throw in it rolls the move back. False when another tick or
   * a cancel moved the row first: nothing is sent.
   */
  settle(id: string, to: SettleTo, notice: ((nonce: string | null) => void) | null): boolean {
    return this.sql.transaction(() => {
      const now = this.now();
      const nonce = to === 'notified' ? randomHex(16) : null;
      const moved = this.sql.exec(
        `UPDATE mail_followups SET status = ?, nonce_hash = ?, updated_at = ?, settled_at = ?
         WHERE id = ? AND status = 'open' RETURNING id`,
        to,
        nonce === null ? null : nonceHash(nonce),
        now,
        to === 'notified' ? null : now,
        id,
      ).length;
      if (moved !== 1) return false;
      notice?.(nonce);
      return true;
    });
  }

  /**
   * One more Gmail failure for an open row. Returns the count after it, or null
   * when the row is no longer open. The caller settles it as unsure at
   * `MAX_FOLLOWUP_ATTEMPTS`.
   */
  recordFailure(id: string): number | null {
    const row = this.sql.exec(
      "UPDATE mail_followups SET attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'open' RETURNING attempts",
      this.now(),
      id,
    )[0];
    return row ? Number(row['attempts']) : null;
  }

  /** A successful read that found nothing yet clears the failure count. */
  clearFailures(id: string): void {
    this.sql.exec("UPDATE mail_followups SET attempts = 0 WHERE id = ? AND status = 'open' AND attempts > 0", id);
  }

  /**
   * Gmail is not reachable and follow-ups are due: one "could not check"
   * notice a day. Marks every due open row with the day and runs `notice` in
   * the same transaction, only when at least one row was not marked today.
   */
  markCouldNotCheck(principal: string, day: string, notice: () => void): boolean {
    return this.sql.transaction(() => {
      const marked = this.sql.exec(
        `UPDATE mail_followups SET day_marker = ?
         WHERE principal = ? AND status = 'open' AND due_at <= ? AND (day_marker IS NULL OR day_marker != ?)
         RETURNING id`,
        day,
        principal,
        this.now(),
        day,
      ).length;
      if (marked === 0) return false;
      notice();
      return true;
    });
  }

  /**
   * A notice button (invariant 7): nonce, owner and age checked in one
   * transaction. `no` closes the row. `draft` moves `notified → used` and asks
   * `issue` for the draft's confirmation card, storing its id with the row; on a
   * `used` row whose card is still live, the old card is superseded by
   * `supersede` and a new one issued — a reply that carried the first card may
   * have been lost. `issue` and `supersede` are synchronous SQL on the same storage.
   */
  tap<T extends { pendingId: string }>(params: {
    principal: string;
    id: string;
    nonce: string;
    verb: 'draft' | 'no';
    issue: (row: FollowUp) => T;
    supersede: (pendingId: string) => boolean;
  }): TapOutcome<T> {
    return this.sql.transaction((): TapOutcome<T> => {
      const now = this.now();
      const raw = this.sql.exec(
        'SELECT * FROM mail_followups WHERE id = ? AND principal = ? AND nonce_hash = ?',
        params.id,
        params.principal,
        nonceHash(params.nonce),
      )[0];
      const row = raw ? followUpOf(raw) : null;
      if (!row || now - row.updatedAt > FOLLOWUP_TAP_MS) return { kind: 'gone' };

      if (params.verb === 'no') {
        const closed = this.sql.exec(
          "UPDATE mail_followups SET status = 'dismissed', updated_at = ?, settled_at = ? WHERE id = ? AND status = 'notified' RETURNING id",
          now,
          now,
          row.id,
        ).length;
        return closed === 1 ? { kind: 'dismissed' } : { kind: 'gone' };
      }

      if (row.status === 'used') {
        // Re-issue only while the first card could still have run: never a second live card.
        if (row.pendingId === null || !params.supersede(row.pendingId)) return { kind: 'gone' };
      } else if (row.status !== 'notified') {
        return { kind: 'gone' };
      }
      const card = params.issue(row);
      // `updated_at` is left alone: the buttons keep the age of the notice.
      this.sql.exec(
        "UPDATE mail_followups SET status = 'used', pending_id = ? WHERE id = ? AND status IN ('notified', 'used')",
        card.pendingId,
        row.id,
      );
      return { kind: 'card', card };
    });
  }

  /**
   * Close notices whose buttons expired untouched, then delete rows settled
   * more than `FOLLOWUP_RETENTION_MS` ago.
   */
  purge(): number {
    const now = this.now();
    this.sql.exec(
      "UPDATE mail_followups SET status = 'dismissed', settled_at = ? WHERE status = 'notified' AND updated_at < ?",
      now,
      now - FOLLOWUP_TAP_MS,
    );
    const cutoff = now - FOLLOWUP_RETENTION_MS;
    return this.sql.exec(
      `DELETE FROM mail_followups
       WHERE status NOT IN ('open', 'notified') AND COALESCE(settled_at, updated_at) < ?
       RETURNING id`,
      cutoff,
    ).length;
  }
}

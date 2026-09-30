/**
 * Everything the assistant says to the app, until the phone says it has it
 * (PLAN §6.18).
 *
 * One mechanism for every outbound message. A reply to a command goes here and
 * back in the HTTP response too, as a shortcut; a reminder, the digest and a
 * call's outcome go only here, and a push tells the phone to come and fetch.
 * The push carries nothing but "there is something" — no text, no id.
 *
 * "Delivered" means the phone acked it, exactly as a status webhook meant it
 * on WhatsApp. Writing a row is the *acceptance*, the equivalent of Meta's 200:
 * the caller does it inside one transaction together with `recordOutbound` and
 * `markSent`, so a crash leaves either all three or none.
 *
 * A phone that is off is not a failure. A reminder's row simply waits — pushed
 * again after 15 minutes, an hour and four hours — for up to seven days, and is
 * fetched whenever the app opens. Only then is it given up on. Anything else
 * waits 24 hours. Rows hold message text, so they go on ack.
 *
 * Plain TypeScript: no platform imports (invariant 11).
 */
import type { SqlDriver } from '../../core/sql.js';
import type { Repository } from '../../core/repo.js';
import type { OutboundButton } from '../types.js';

export type OutboxKind = 'reply' | 'reminder' | 'digest' | 'call' | 'notice';

export const REMINDER_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const OTHER_ROW_TTL_MS = 24 * 60 * 60 * 1000;
/** A reply went back in the HTTP body; push only if the phone has not acked it by then. */
export const REPLY_PUSH_DELAY_MS = 60 * 1000;
/** Re-push schedule for anything the phone has not acked, after each push. */
export const REPUSH_AFTER_MS = [15 * 60 * 1000, 60 * 60 * 1000, 4 * 60 * 60 * 1000] as const;
/** At most this many rows per fetch; the phone asks again while `more` is true. */
export const PAGE_SIZE = 50;

export type OutboxRow = {
  seq: number;
  kind: OutboxKind;
  inReplyTo: string | null;
  text: string;
  buttons: OutboundButton[];
  createdAt: number;
};

export type Accepted = { seq: number; wamid: string; adopted: boolean };

export function outboxWamid(seq: number): string {
  return `app:${seq}`;
}

export class AppOutbox {
  constructor(
    private readonly sql: SqlDriver,
    private readonly repo: Repository,
    private readonly now: () => number,
  ) {}

  /**
   * Write one message. Must run inside the caller's transaction, with whatever
   * else makes it count (`markSent` for a reminder).
   *
   * A reminder that already has a row gets that row back rather than a second
   * one. It cannot happen when the transaction holds — the reminder would be
   * `sent` and never claimed again — so it is logged by the caller as a bug,
   * but it must not throw inside the alarm and burn the reminder's attempts.
   */
  accept(message: {
    kind: OutboxKind;
    text: string;
    buttons?: readonly OutboundButton[];
    inReplyTo?: string;
    reminderId?: string;
    principal?: string;
  }): Accepted {
    const now = this.now();
    const ttl = message.kind === 'reminder' ? REMINDER_ROW_TTL_MS : OTHER_ROW_TTL_MS;
    const firstPush = message.kind === 'reply' ? now + REPLY_PUSH_DELAY_MS : now;

    const inserted = this.sql.exec(
      `INSERT INTO app_outbox (kind, reminder_id, in_reply_to, text, buttons_json, created_at, expires_at, next_push_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(reminder_id) DO NOTHING
       RETURNING seq`,
      message.kind,
      message.reminderId ?? null,
      message.inReplyTo ?? null,
      message.text,
      message.buttons && message.buttons.length > 0 ? JSON.stringify(message.buttons) : null,
      now,
      now + ttl,
      firstPush,
    )[0];

    if (!inserted) {
      const existing = Number(
        this.sql.exec('SELECT seq FROM app_outbox WHERE reminder_id = ?', message.reminderId ?? null)[0]?.['seq'],
      );
      return { seq: existing, wamid: outboxWamid(existing), adopted: true };
    }

    const seq = Number(inserted['seq']);
    this.repo.recordOutbound({
      wamid: outboxWamid(seq),
      kind: message.kind,
      sentAt: now,
      ...(message.principal ? { principal: message.principal } : {}),
      ...(message.reminderId ? { reminderId: message.reminderId } : {}),
    });
    return { seq, wamid: outboxWamid(seq), adopted: false };
  }

  get(seq: number): OutboxRow | null {
    const row = this.sql.exec(`SELECT ${COLUMNS} FROM app_outbox WHERE seq = ?`, seq)[0];
    return row ? toRow(row) : null;
  }

  /** The reply to one client message, if it has been written. */
  replyTo(messageId: string): OutboxRow | null {
    const row = this.sql.exec(
      `SELECT ${COLUMNS} FROM app_outbox WHERE in_reply_to = ? ORDER BY seq LIMIT 1`,
      messageId,
    )[0];
    return row ? toRow(row) : null;
  }

  /** Oldest first, one page. Expired rows are gone before anything is read. */
  list(): { rows: OutboxRow[]; more: boolean } {
    const rows = this.sql
      .exec(`SELECT ${COLUMNS} FROM app_outbox WHERE expires_at > ? ORDER BY seq LIMIT ?`, this.now(), PAGE_SIZE + 1)
      .map(toRow);
    return { rows: rows.slice(0, PAGE_SIZE), more: rows.length > PAGE_SIZE };
  }

  /**
   * The phone has these. Only the seqs named are touched — never "everything
   * up to" — so a row written while the phone was fetching is not swallowed.
   * Returns the reminders among them, whose calendar stand-in can now go.
   * Must run inside the caller's transaction.
   */
  ack(seqs: readonly number[]): { reminderIds: string[] } {
    const now = this.now();
    const reminderIds: string[] = [];
    for (const seq of new Set(seqs)) {
      const row = this.sql.exec('DELETE FROM app_outbox WHERE seq = ? RETURNING reminder_id', seq)[0];
      if (!row) continue; // acked already, expired, or never ours: nothing to do
      this.repo.applyDeliveryStatus({ wamid: outboxWamid(seq), status: 'delivered', atMs: now });
      const reminderId = row['reminder_id'];
      if (typeof reminderId === 'string') reminderIds.push(reminderId);
    }
    return { reminderIds };
  }

  /** Rows whose next push is due. */
  duePushes(): Array<{ seq: number; kind: OutboxKind; pushes: number }> {
    return this.sql
      .exec(
        'SELECT seq, kind, pushes FROM app_outbox WHERE next_push_at IS NOT NULL AND next_push_at <= ? ORDER BY seq',
        this.now(),
      )
      .map((row) => ({ seq: Number(row['seq']), kind: String(row['kind']) as OutboxKind, pushes: Number(row['pushes']) }));
  }

  /** One push went out for these rows; schedule the next, or stop. */
  markPushed(rows: ReadonlyArray<{ seq: number; kind: OutboxKind; pushes: number }>): void {
    const now = this.now();
    for (const row of rows) {
      const pushes = row.pushes + 1;
      // A reply gets the one push that covers a lost HTTP response, no more.
      const delay = row.kind === 'reply' ? undefined : REPUSH_AFTER_MS[pushes - 1];
      this.sql.exec(
        'UPDATE app_outbox SET pushes = ?, next_push_at = ? WHERE seq = ?',
        pushes,
        delay === undefined ? null : now + delay,
        row.seq,
      );
    }
  }

  /**
   * Rows nobody fetched in time. Each is deleted and its outbound record marked
   * failed; the reminders among them are returned for `retireSent`, which the
   * caller runs in the same transaction.
   */
  expireDue(): { reminderIds: string[]; expired: number } {
    const now = this.now();
    const rows = this.sql.exec('DELETE FROM app_outbox WHERE expires_at <= ? RETURNING seq, reminder_id', now);
    const reminderIds: string[] = [];
    for (const row of rows) {
      const failed = this.repo.applyDeliveryStatus({
        wamid: outboxWamid(Number(row['seq'])),
        status: 'failed',
        atMs: now,
        errorCode: 'E_APP_UNACKED',
      });
      if (failed.failedReminderId) reminderIds.push(failed.failedReminderId);
    }
    return { reminderIds, expired: rows.length };
  }

  /**
   * `/pair off`: nothing may wait for a phone that is no longer ours. Every row
   * goes; the reminders among them are returned so the caller can put them back
   * in the queue, in the same transaction, for whichever phone pairs next.
   */
  clearForRevoke(): { reminderIds: string[] } {
    const now = this.now();
    const rows = this.sql.exec('DELETE FROM app_outbox RETURNING seq, reminder_id');
    const reminderIds: string[] = [];
    for (const row of rows) {
      this.repo.applyDeliveryStatus({
        wamid: outboxWamid(Number(row['seq'])),
        status: 'failed',
        atMs: now,
        errorCode: 'E_APP_REVOKED',
      });
      const reminderId = row['reminder_id'];
      if (typeof reminderId === 'string') reminderIds.push(reminderId);
    }
    return { reminderIds };
  }

  /** When the alarm must next look: a push or an expiry. */
  nextWakeAt(): number | null {
    const row = this.sql.exec(
      'SELECT MIN(next_push_at) AS push, MIN(expires_at) AS expiry FROM app_outbox',
    )[0];
    const push = typeof row?.['push'] === 'number' ? (row['push'] as number) : null;
    const expiry = typeof row?.['expiry'] === 'number' ? (row['expiry'] as number) : null;
    if (push === null) return expiry;
    if (expiry === null) return push;
    return Math.min(push, expiry);
  }

  /** The next expiry alone — what the alarm waits for when pushes are off. */
  nextExpiryAt(): number | null {
    const at = this.sql.exec('SELECT MIN(expires_at) AS at FROM app_outbox')[0]?.['at'];
    return typeof at === 'number' ? at : null;
  }

  size(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM app_outbox')[0]?.['n'] ?? 0);
  }
}

const COLUMNS = 'seq, kind, in_reply_to, text, buttons_json, created_at';

function toRow(row: Record<string, unknown>): OutboxRow {
  let buttons: OutboundButton[] = [];
  if (typeof row['buttons_json'] === 'string') {
    try {
      const parsed: unknown = JSON.parse(row['buttons_json']);
      if (Array.isArray(parsed)) {
        buttons = parsed.filter(
          (b): b is OutboundButton =>
            typeof b === 'object' && b !== null && typeof b.id === 'string' && typeof b.title === 'string',
        );
      }
    } catch {
      buttons = [];
    }
  }
  return {
    seq: Number(row['seq']),
    kind: String(row['kind']) as OutboxKind,
    inReplyTo: typeof row['in_reply_to'] === 'string' ? row['in_reply_to'] : null,
    text: String(row['text']),
    buttons,
    createdAt: Number(row['created_at']),
  };
}

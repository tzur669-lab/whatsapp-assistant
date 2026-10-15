/**
 * Proactive calendar suggestions' store (block L, L3, 2026-10-15).
 *
 * One row per event per day it was suggested; `UNIQUE (principal, event_id,
 * day)` makes a rerun of the daily job a no-op. The job reads the calendar
 * first, then inserts its rows and queues their notices in one transaction
 * (`offer`): a crash before it changes nothing, after it the outbox delivers.
 *
 * A tap on "ok" needs the network (the event is read again), so it holds a
 * two-minute lease: `open → checking` with a fresh `claim_token`, and every
 * move out of `checking` names that token. A tap whose lease was taken over
 * changes nothing and creates no card. A lease left by a crash expires and the
 * next tap claims the row again. The card itself is issued in the same
 * transaction that moves the row to `used`; a later tap on a `used` row whose
 * card is still live replaces that card, never adds a second one.
 */
import type { SqlDriver, SqlRow } from '../core/sql.js';
import { sha256Hex } from '../confirm/pending.js';

/** How long a notice's buttons work. */
export const SUGGESTION_TAP_MS = 48 * 60 * 60 * 1000;
/** How long one tap may hold a row while it reads the event. */
export const SUGGESTION_LEASE_MS = 2 * 60 * 1000;
/** At most this many suggestions a day. */
export const MAX_SUGGESTIONS_PER_DAY = 3;
export const SUGGESTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type Suggestion = { id: string; eventId: string; status: 'open' | 'checking' | 'used' | 'dismissed'; pendingId: string | null };

export type ClaimOutcome =
  | { kind: 'claimed'; eventId: string; token: string }
  /** `used`, and its card may be re-sent: the caller supersedes and re-issues through `reissue`. */
  | { kind: 'used'; pendingId: string | null }
  /** Wrong nonce or owner, too old, dismissed, or held by another tap right now. */
  | { kind: 'gone' };

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function nonceHash(nonce: string): string {
  return sha256Hex(new TextEncoder().encode(`suggest:${nonce}`));
}

function suggestionOf(row: SqlRow): Suggestion {
  return {
    id: String(row['id']),
    eventId: String(row['event_id']),
    status: String(row['status']) as Suggestion['status'],
    pendingId: typeof row['pending_id'] === 'string' ? row['pending_id'] : null,
  };
}

export class SuggestionStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** The events already suggested for this day, whatever became of them. */
  suggestedOn(principal: string, day: string): Set<string> {
    return new Set(
      this.sql.exec('SELECT event_id FROM suggestions WHERE principal = ? AND day = ?', principal, day).map((row) => String(row['event_id'])),
    );
  }

  /**
   * Insert the day's suggestions and queue their notices, in one transaction.
   * `guard` runs first inside it (the caller checks and marks its day there);
   * false aborts with nothing written. `notice` runs only for rows this call
   * inserted (a rerun inserts none), with the row id and its button nonce.
   * Returns how many were inserted.
   */
  offer(
    principal: string,
    day: string,
    eventIds: readonly string[],
    notice: (eventId: string, id: string, nonce: string) => void,
    guard: () => boolean = () => true,
  ): number {
    return this.sql.transaction(() => {
      if (!guard()) return 0;
      const now = this.now();
      let inserted = 0;
      for (const eventId of eventIds.slice(0, MAX_SUGGESTIONS_PER_DAY)) {
        const id = randomHex(16);
        const nonce = randomHex(16);
        const added = this.sql.exec(
          `INSERT INTO suggestions (id, principal, event_id, day, status, nonce_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?)
           ON CONFLICT (principal, event_id, day) DO NOTHING
           RETURNING id`,
          id,
          principal,
          eventId,
          day,
          nonceHash(nonce),
          now,
          now,
        ).length;
        if (added === 1) {
          notice(eventId, id, nonce);
          inserted++;
        }
      }
      return inserted;
    });
  }

  /**
   * An "ok" tap: nonce, owner and age checked, then `open → checking` (or a
   * `checking` row whose lease expired) with a fresh token, one conditional UPDATE.
   */
  claim(principal: string, id: string, nonce: string): ClaimOutcome {
    const now = this.now();
    const row = this.sql.exec(
      'SELECT * FROM suggestions WHERE id = ? AND principal = ? AND nonce_hash = ? AND created_at > ?',
      id,
      principal,
      nonceHash(nonce),
      now - SUGGESTION_TAP_MS,
    )[0];
    if (!row) return { kind: 'gone' };
    const current = suggestionOf(row);
    if (current.status === 'used') return { kind: 'used', pendingId: current.pendingId };
    const token = randomHex(16);
    const claimed = this.sql.exec(
      `UPDATE suggestions SET status = 'checking', claim_token = ?, claimed_at = ?, updated_at = ?
       WHERE id = ? AND (status = 'open' OR (status = 'checking' AND claimed_at < ?))
       RETURNING event_id`,
      token,
      now,
      now,
      id,
      now - SUGGESTION_LEASE_MS,
    )[0];
    return claimed ? { kind: 'claimed', eventId: String(claimed['event_id']), token } : { kind: 'gone' };
  }

  /**
   * The tap read the event and has a card to issue: `checking → used` and the
   * card, in one transaction, only while the lease is still this tap's. Null
   * when it was taken over: nothing is issued.
   */
  complete<T extends { pendingId: string }>(id: string, token: string, issue: () => T): T | null {
    return this.sql.transaction(() => {
      const moved = this.sql.exec(
        "SELECT 1 FROM suggestions WHERE id = ? AND status = 'checking' AND claim_token = ?",
        id,
        token,
      ).length;
      if (moved !== 1) return null;
      const card = issue();
      this.sql.exec(
        "UPDATE suggestions SET status = 'used', pending_id = ?, claim_token = NULL, updated_at = ? WHERE id = ? AND claim_token = ?",
        card.pendingId,
        this.now(),
        id,
        token,
      );
      return card;
    });
  }

  /**
   * A `used` row's card re-issued after a lost reply: the old card is
   * superseded and a new one issued, in one transaction; null when the old
   * card already ran or expired (nothing to replace).
   */
  reissue<T extends { pendingId: string }>(id: string, pendingId: string, supersede: (pendingId: string) => boolean, issue: () => T): T | null {
    return this.sql.transaction(() => {
      if (!supersede(pendingId)) return null;
      const card = issue();
      this.sql.exec("UPDATE suggestions SET pending_id = ?, updated_at = ? WHERE id = ? AND status = 'used'", card.pendingId, this.now(), id);
      return card;
    });
  }

  /** The tap could not read the event: back to `open`, only while the lease is this tap's. */
  release(id: string, token: string): boolean {
    return (
      this.sql.exec(
        "UPDATE suggestions SET status = 'open', claim_token = NULL, claimed_at = NULL, updated_at = ? WHERE id = ? AND status = 'checking' AND claim_token = ? RETURNING id",
        this.now(),
        id,
        token,
      ).length === 1
    );
  }

  /** The event is gone or too late: closed, only while the lease is this tap's. */
  close(id: string, token: string): boolean {
    return (
      this.sql.exec(
        "UPDATE suggestions SET status = 'dismissed', claim_token = NULL, updated_at = ? WHERE id = ? AND status = 'checking' AND claim_token = ? RETURNING id",
        this.now(),
        id,
        token,
      ).length === 1
    );
  }

  /** A "no" tap: nonce, owner and age checked, `open → dismissed`. */
  dismiss(principal: string, id: string, nonce: string): boolean {
    const now = this.now();
    return (
      this.sql.exec(
        `UPDATE suggestions SET status = 'dismissed', updated_at = ?
         WHERE id = ? AND principal = ? AND nonce_hash = ? AND status = 'open' AND created_at > ?
         RETURNING id`,
        now,
        id,
        principal,
        nonceHash(nonce),
        now - SUGGESTION_TAP_MS,
      ).length === 1
    );
  }

  purge(): number {
    return this.sql.exec('DELETE FROM suggestions WHERE created_at < ? RETURNING id', this.now() - SUGGESTION_RETENTION_MS).length;
  }
}

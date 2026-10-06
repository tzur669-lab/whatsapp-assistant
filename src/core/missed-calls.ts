/**
 * Missed calls for the morning digest (ROADMAP #20, 2026-10-06).
 *
 * The phone holds the call log; the server only ever sees what the phone sent
 * in answer to one ask: names (or none, for a number not in the contacts) and
 * times, never a number. The life of a row is one digest:
 *
 *   ask      at the digest hour, after the digest is marked done; an empty push
 *   accept   the phone's signed report, only within ASK_WINDOW_MS of the ask
 *   since    what the digest reads: calls in the day before the ask
 *   clear    right after the digest is built, whatever it decided — and the
 *            ask with it, so a late report is refused, not kept
 *
 * Names are message content: stored for minutes, never logged.
 */
import type { SqlDriver } from './sql.js';

/** A report is accepted this long after the ask, and no longer. */
export const ASK_WINDOW_MS = 60_000;
/** The digest shows a day of missed calls. */
export const MISSED_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Anything older is dropped by maintenance, in case a clear never ran. */
const RETENTION_MS = 36 * 60 * 60 * 1000;
export const MAX_REPORTED_CALLS = 20;
const MAX_NAME_CHARS = 60;
const ASK_KEY = 'missed_calls_ask_at';
const ANSWERED_KEY = 'missed_calls_answered';

export type MissedCall = { name: string | null; at: number };

export class MissedCallStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** The digest is about to ask the phone. Returns the ask's time. */
  ask(): number {
    const at = this.now();
    this.setValue(ASK_KEY, String(at));
    return at;
  }

  private askedAt(): number | null {
    const value = this.sql.exec('SELECT value FROM settings WHERE key = ?', ASK_KEY)[0]?.['value'];
    const at = Number(value);
    return typeof value === 'string' && Number.isFinite(at) ? at : null;
  }

  /**
   * The phone's report. Refused unless an ask is open: names nobody asked for
   * are names not kept. Replaces any earlier report, in one transaction.
   */
  accept(principal: string, calls: readonly MissedCall[]): boolean {
    return this.sql.transaction(() => {
      const askedAt = this.askedAt();
      const now = this.now();
      if (askedAt === null || now < askedAt || now - askedAt > ASK_WINDOW_MS) return false;
      this.sql.exec('DELETE FROM missed_calls WHERE principal = ?', principal);
      for (const call of calls.slice(0, MAX_REPORTED_CALLS)) {
        if (call.at > now || call.at < askedAt - MISSED_WINDOW_MS) continue;
        const name = call.name?.trim().slice(0, MAX_NAME_CHARS) || null;
        this.sql.exec(
          'INSERT INTO missed_calls (principal, name, at, received_at) VALUES (?, ?, ?, ?)',
          principal,
          name,
          call.at,
          now,
        );
      }
      this.setValue(ANSWERED_KEY, String(askedAt));
      return true;
    });
  }

  private setValue(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  /** Whether the phone answered the ask at `askedAt`, calls or none. Read from SQL each time. */
  answered(askedAt: number): boolean {
    return this.sql.exec('SELECT value FROM settings WHERE key = ?', ANSWERED_KEY)[0]?.['value'] === String(askedAt);
  }

  /** The calls the digest shows: the day before the ask, oldest first. */
  since(principal: string, askedAt: number): MissedCall[] {
    return this.sql
      .exec(
        'SELECT name, at FROM missed_calls WHERE principal = ? AND received_at >= ? AND at >= ? ORDER BY at ASC LIMIT ?',
        principal,
        askedAt,
        askedAt - MISSED_WINDOW_MS,
        MAX_REPORTED_CALLS,
      )
      .map((row) => ({ name: typeof row['name'] === 'string' ? row['name'] : null, at: Number(row['at']) }));
  }

  /** After the digest: every row, and the ask, so nothing waits and nothing late is kept. */
  clear(): void {
    this.sql.transaction(() => {
      this.sql.exec('DELETE FROM missed_calls');
      this.sql.exec('DELETE FROM settings WHERE key IN (?, ?)', ASK_KEY, ANSWERED_KEY);
    });
  }

  /** Maintenance: anything older than a day and a half. */
  purge(): void {
    this.sql.exec('DELETE FROM missed_calls WHERE received_at < ?', this.now() - RETENTION_MS);
  }
}

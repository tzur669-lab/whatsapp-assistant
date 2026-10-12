/**
 * One agent turn per sender at a time (plan C3).
 *
 * A Durable Object serializes storage, not awaits: while a turn waits on the
 * model, another request for the same sender can run. Two interleaved turns
 * would both read the same history and could each make "the one write" of a
 * message. The lock is taken synchronously when the agent step starts, so the
 * check and the take cannot be split by an await, and it is released when the
 * turn ends. It expires on its own, so an object evicted mid-turn cannot leave a
 * sender locked out — but only after anything the turn started has ended.
 */
import type { SqlDriver } from '../core/sql.js';
import { LOCK_TTL_MS } from './limits.js';

/** Derived from the turn deadline and the longest write (`limits.ts`). */
export { LOCK_TTL_MS };

export class AgentLock {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** True when this turn now holds the lock. Synchronous on purpose. */
  acquire(principal: string, turnId: string): boolean {
    const now = this.now();
    return this.sql.transaction(() => {
      this.sql.exec('DELETE FROM agent_lock WHERE principal = ? AND expires_at <= ?', principal, now);
      this.sql.exec(
        `INSERT INTO agent_lock (principal, turn_id, started_at, expires_at)
         VALUES (?, ?, ?, ?) ON CONFLICT(principal) DO NOTHING`,
        principal,
        turnId,
        now,
        now + LOCK_TTL_MS,
      );
      const row = this.sql.exec('SELECT turn_id FROM agent_lock WHERE principal = ?', principal)[0];
      return row?.['turn_id'] === turnId;
    });
  }

  release(principal: string, turnId: string): void {
    this.sql.exec('DELETE FROM agent_lock WHERE principal = ? AND turn_id = ?', principal, turnId);
  }

  /** Whether a turn is running for this sender now. Synchronous. */
  isHeld(principal: string): boolean {
    const row = this.sql.exec(
      'SELECT 1 AS held FROM agent_lock WHERE principal = ? AND expires_at > ?',
      principal,
      this.now(),
    )[0];
    return row !== undefined;
  }

  /**
   * Whether this turn holds the lock now. Synchronous. An expired row is not
   * held: rows are deleted only in `acquire`, so the expiry is checked here.
   * What tells a live resumed turn (`running`, its lock under its wamid) from
   * one an eviction left behind (Improvement plan §3 T8).
   */
  heldBy(principal: string, turnId: string): boolean {
    const row = this.sql.exec(
      'SELECT 1 AS held FROM agent_lock WHERE principal = ? AND turn_id = ? AND expires_at > ?',
      principal,
      turnId,
      this.now(),
    )[0];
    return row !== undefined;
  }

  /**
   * When the lock held for this sender expires, or null when none is held.
   * The screen agent waits this long, clamped, before it asks again (PLAN §6.28).
   */
  expiresAt(principal: string): number | null {
    const row = this.sql.exec(
      'SELECT expires_at FROM agent_lock WHERE principal = ? AND expires_at > ?',
      principal,
      this.now(),
    )[0];
    return typeof row?.['expires_at'] === 'number' ? row['expires_at'] : null;
  }

  wipe(principal: string): void {
    this.sql.exec('DELETE FROM agent_lock WHERE principal = ?', principal);
  }
}

/**
 * One agent turn per sender at a time (plan C3).
 *
 * A Durable Object serializes storage, not awaits: while a turn waits on the
 * model, another request for the same sender can run. Two interleaved turns
 * would both read the same history and could each make "the one write" of a
 * message. The lock is taken synchronously when the agent step starts, so the
 * check and the take cannot be split by an await, and it is released when the
 * turn ends. It expires on its own, so an object evicted mid-turn cannot leave a
 * sender locked out.
 */
import type { SqlDriver } from '../core/sql.js';

export const LOCK_TTL_MS = 60_000;

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

  wipe(principal: string): void {
    this.sql.exec('DELETE FROM agent_lock WHERE principal = ?', principal);
  }
}

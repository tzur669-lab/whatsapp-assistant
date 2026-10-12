/**
 * One agent turn per sender at a time (plan C3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { AgentLock, LOCK_TTL_MS } from '../../../src/agent/lock.js';
import { GOOGLE_CALL_MAX_MS, MAX_WRITE_CALLS, MAX_WRITE_MS, TURN_DEADLINE_MS } from '../../../src/agent/limits.js';
import { TIMEOUT_MS } from '../../../src/google/api.js';
import { TOKEN_TIMEOUT_MS } from '../../../src/google/oauth.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

describe('AgentLock', () => {
  let driver: TestSqlDriver;
  let now: number;
  let lock: AgentLock;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = 1_000_000;
    lock = new AgentLock(driver, () => now);
  });
  afterEach(() => driver.close());

  it('lets one turn in and keeps a second out', () => {
    expect(lock.acquire('p', 't1')).toBe(true);
    expect(lock.acquire('p', 't2')).toBe(false);
  });

  it('is per sender', () => {
    expect(lock.acquire('p', 't1')).toBe(true);
    expect(lock.acquire('q', 't2')).toBe(true);
  });

  it('opens again once released', () => {
    lock.acquire('p', 't1');
    lock.release('p', 't1');
    expect(lock.acquire('p', 't2')).toBe(true);
  });

  it('cannot be released by a turn that does not hold it', () => {
    lock.acquire('p', 't1');
    lock.release('p', 't2');
    expect(lock.acquire('p', 't3')).toBe(false);
  });

  it('says which turn holds it, and an expired row holds nothing (T8)', () => {
    lock.acquire('p', 'wamid.1');
    expect(lock.heldBy('p', 'wamid.1')).toBe(true);
    expect(lock.heldBy('p', 'wamid.2')).toBe(false);
    expect(lock.heldBy('q', 'wamid.1')).toBe(false);
    now += LOCK_TTL_MS - 1;
    expect(lock.heldBy('p', 'wamid.1')).toBe(true);
    now += 1;
    // Still in the table (only `acquire` deletes), but no longer held.
    expect(lock.heldBy('p', 'wamid.1')).toBe(false);
  });

  it('expires, so an evicted turn cannot lock a sender out', () => {
    lock.acquire('p', 't1');
    now += LOCK_TTL_MS + 1;
    expect(lock.acquire('p', 't2')).toBe(true);
  });

  it('outlives a write started just before the turn deadline (Improvement plan §3 T3)', () => {
    // Fails when a constant changes without the TTL following it.
    expect(GOOGLE_CALL_MAX_MS).toBeGreaterThanOrEqual(2 * (TOKEN_TIMEOUT_MS + TIMEOUT_MS));
    expect(MAX_WRITE_MS).toBeGreaterThanOrEqual(MAX_WRITE_CALLS * GOOGLE_CALL_MAX_MS);
    expect(LOCK_TTL_MS).toBeGreaterThan(TURN_DEADLINE_MS + MAX_WRITE_MS);
  });

  it('is still held when that write ends', () => {
    lock.acquire('p', 't1');
    now += TURN_DEADLINE_MS + MAX_WRITE_MS;
    expect(lock.isHeld('p')).toBe(true);
    expect(lock.acquire('p', 't2')).toBe(false);
  });
});

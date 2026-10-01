/**
 * One agent turn per sender at a time (plan C3).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { AgentLock, LOCK_TTL_MS } from '../../../src/agent/lock.js';
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

  it('expires, so an evicted turn cannot lock a sender out', () => {
    lock.acquire('p', 't1');
    now += LOCK_TTL_MS + 1;
    expect(lock.acquire('p', 't2')).toBe(true);
  });
});

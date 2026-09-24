/**
 * Counters and the pause switch (PLAN §6.8, §6.9).
 *
 * The monthly counter is what stands between the assistant and Meta's 1,000
 * free messages running out silently, so it has to survive a restart and roll
 * over on the right day — in Israel, not in UTC.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';

describe('Repository.monthKey', () => {
  it('uses the local month, not UTC', () => {
    // 31.10.2026 23:30 UTC is already 1 November in Jerusalem (+02:00).
    expect(Repository.monthKey(Date.parse('2026-10-31T23:30:00Z'))).toBe('2026-11');
  });

  it('formats as YYYY-MM', () => {
    expect(Repository.monthKey(Date.parse('2026-09-24T18:00:00Z'))).toBe('2026-09');
  });

  it('handles a year boundary', () => {
    expect(Repository.monthKey(Date.parse('2026-12-31T23:00:00Z'))).toBe('2027-01');
  });
});

describe('counters', () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
  });
  afterEach(() => driver.close());

  it('starts at zero for an unseen month', () => {
    expect(repo.counters('2026-09')).toEqual({
      waSent: 0,
      llmCalls: 0,
      llmTokens: 0,
      fallbacks: 0,
    });
  });

  it('creates the row on the first bump', () => {
    expect(repo.bumpCounter('2026-09', 'wa_sent')).toBe(1);
  });

  it('accumulates', () => {
    repo.bumpCounter('2026-09', 'wa_sent');
    repo.bumpCounter('2026-09', 'wa_sent');
    expect(repo.bumpCounter('2026-09', 'wa_sent')).toBe(3);
  });

  it('adds a batch in one go, for token counts', () => {
    expect(repo.bumpCounter('2026-09', 'llm_tokens', 1200)).toBe(1200);
  });

  it('keeps months apart', () => {
    repo.bumpCounter('2026-09', 'wa_sent', 5);
    repo.bumpCounter('2026-10', 'wa_sent', 2);
    expect(repo.counters('2026-09').waSent).toBe(5);
    expect(repo.counters('2026-10').waSent).toBe(2);
  });

  it('keeps fields apart', () => {
    repo.bumpCounter('2026-09', 'wa_sent', 3);
    repo.bumpCounter('2026-09', 'fallbacks', 7);
    expect(repo.counters('2026-09')).toMatchObject({ waSent: 3, fallbacks: 7 });
  });
});

describe('pause', () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
  });
  afterEach(() => driver.close());

  it('starts unpaused', () => {
    expect(repo.isPaused()).toBe(false);
  });

  it('pauses and resumes', () => {
    repo.setPaused(true);
    expect(repo.isPaused()).toBe(true);
    repo.setPaused(false);
    expect(repo.isPaused()).toBe(false);
  });

  it('persists, so a redeploy cannot silently unpause', () => {
    repo.setPaused(true);
    expect(new Repository(driver).isPaused()).toBe(true);
  });
});

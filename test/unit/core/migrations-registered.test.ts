/**
 * Every file in `migrations/` is registered in `src/platform/migrations.ts`
 * under its own number and with its own text, so a Worker bundle never
 * misses one (HANDOFF §4, "a migration").
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const dir = new URL('../../../migrations/', import.meta.url);
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .sort();

describe('migrations', () => {
  it('registers every file, in order, under its own number', () => {
    expect(MIGRATIONS.map((m) => m.id)).toEqual(files.map((name) => Number(name.slice(0, 4))));
    files.forEach((name, index) => {
      expect(MIGRATIONS[index]!.sql, name).toBe(readFileSync(new URL(name, dir), 'utf8'));
    });
  });

  it('creates the per-day request count for request-limited models (0026)', () => {
    const driver = new TestSqlDriver();
    try {
      new Repository(driver).migrate(MIGRATIONS);
      const columns = driver.exec('PRAGMA table_info(model_day_requests)').map((row) => row['name']);
      expect(columns).toEqual(['day', 'model', 'count']);
    } finally {
      driver.close();
    }
  });

  it('tells a consent turn from a phone turn, every older row a phone one (0027)', () => {
    const driver = new TestSqlDriver();
    try {
      const repo = new Repository(driver);
      repo.migrate(MIGRATIONS.filter((m) => m.id < 27));
      driver.exec(
        `INSERT INTO agent_turns (query_id, principal, wamid, ciphertext, status, created_at, expires_at)
         VALUES ('q1', 'p', 'w', 'c', 'waiting', 1, 2)`,
      );
      repo.migrate(MIGRATIONS);
      const columns = driver.exec('PRAGMA table_info(agent_turns)').map((row) => row['name']);
      expect(columns).toEqual(expect.arrayContaining(['kind', 'nonce_hash', 'source', 'conversation']));
      expect(driver.exec('SELECT kind FROM agent_turns')).toEqual([{ kind: 'phone' }]);
      expect(() =>
        driver.exec(
          `INSERT INTO agent_turns (query_id, principal, wamid, status, created_at, expires_at, kind)
           VALUES ('q2', 'p', 'w', 'waiting', 1, 2, 'other')`,
        ),
      ).toThrow();
    } finally {
      driver.close();
    }
  });
});

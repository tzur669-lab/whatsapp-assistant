import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const MIGRATIONS = [
  { id: 1, sql: readFileSync(new URL('../../../migrations/0001_init.sql', import.meta.url), 'utf8') },
];

/** `recordInbound` numbers messages in arrival order: 0022 adds the column (§6.23). */
const WITH_SEQ = [
  ...MIGRATIONS,
  { id: 22, sql: readFileSync(new URL('../../../migrations/0022_misses.sql', import.meta.url), 'utf8') },
];

const PRINCIPAL = 'p_000000000000';

describe('Repository.migrate', () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
  });
  afterEach(() => driver.close());

  it('applies migrations and records the schema version', () => {
    expect(repo.schemaVersion()).toBe(0);
    expect(repo.migrate(MIGRATIONS)).toBe(1);
    expect(repo.schemaVersion()).toBe(1);
  });

  it('is idempotent across restarts', () => {
    repo.migrate(MIGRATIONS);
    expect(() => repo.migrate(MIGRATIONS)).not.toThrow();
    expect(repo.schemaVersion()).toBe(1);
  });

  it('creates every Phase 1 table', () => {
    repo.migrate(MIGRATIONS);
    const names = driver
      .exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .map((r) => r['name']);
    for (const table of [
      'settings',
      'inbound_messages',
      'outbound_messages',
      'audit_log',
      'counters',
      'window_state',
    ]) {
      expect(names).toContain(table);
    }
  });

  it('stores no column that could hold message text', () => {
    repo.migrate(MIGRATIONS);
    const cols = driver.exec("PRAGMA table_info('inbound_messages')").map((r) => r['name']);
    expect(cols).not.toContain('body');
    expect(cols).not.toContain('text');
  });
});

describe('Repository dedupe and window state', () => {
  let driver: TestSqlDriver;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(WITH_SEQ);
  });
  afterEach(() => driver.close());

  const record = (wamid: string, receivedAt = 1_000) => ({
    wamid,
    principal: PRINCIPAL,
    receivedAt,
    sentAt: receivedAt - 500,
    kind: 'text',
  });

  it('accepts a wamid once', () => {
    expect(repo.recordInbound(record('wamid.A'))).toBe(true);
  });

  it('rejects a replayed wamid', () => {
    repo.recordInbound(record('wamid.A'));
    expect(repo.recordInbound(record('wamid.A'))).toBe(false);
  });

  it('keeps the first record when a duplicate arrives', () => {
    repo.recordInbound(record('wamid.A', 1_000));
    repo.recordInbound(record('wamid.A', 9_999));
    expect(repo.getInbound('wamid.A')).toMatchObject({ received_at: 1_000 });
  });

  it('records an outcome without touching identity fields', () => {
    repo.recordInbound(record('wamid.A'));
    repo.markInboundOutcome('wamid.A', { intent: 'reminders.create', decision: 'ALLOW' });
    expect(repo.getInbound('wamid.A')).toMatchObject({
      intent: 'reminders.create',
      decision: 'ALLOW',
      principal: PRINCIPAL,
    });
  });

  it('purges records past the retention cutoff and keeps newer ones', () => {
    repo.recordInbound(record('wamid.OLD', 1_000));
    repo.recordInbound(record('wamid.NEW', 5_000));
    repo.purgeInboundBefore(2_000);
    expect(repo.getInbound('wamid.OLD')).toBeNull();
    expect(repo.getInbound('wamid.NEW')).not.toBeNull();
  });

  it('tracks the 24h window open time and never moves it backwards', () => {
    repo.touchWindow(PRINCIPAL, 5_000);
    repo.touchWindow(PRINCIPAL, 1_000);
    expect(repo.lastInboundAt(PRINCIPAL)).toBe(5_000);
    repo.touchWindow(PRINCIPAL, 9_000);
    expect(repo.lastInboundAt(PRINCIPAL)).toBe(9_000);
  });

  it('returns null for an unknown principal', () => {
    expect(repo.lastInboundAt('p_unknown')).toBeNull();
  });

  it('appends audit entries', () => {
    repo.audit({ ts: 1, principal: PRINCIPAL, decision: 'DENY', outcome: 'not_allowed' });
    const rows = driver.exec('SELECT * FROM audit_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: 'DENY', outcome: 'not_allowed' });
  });
});

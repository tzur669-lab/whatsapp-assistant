/**
 * Retention of settled rows (Improvement plan §3 T11, Batch 14; D3 = 90 days).
 *
 * What is pinned: only reminders in a final state, due and last touched more
 * than 90 days ago, are deleted — never one still scheduled or being sent, and
 * never the occurrence a repeating series will fire next. Audit rows older than
 * 90 days go; the last 24 hours, which rate limits read, always stay.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReminderStore, SETTLED_RETENTION_MS } from '../../../src/tools/reminder-store.js';
import { AUDIT_RETENTION_MS, Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-09-24T09:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const PRINCIPAL = 'p_retention';

describe('retention of settled rows (D3: 90 days)', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let store: ReminderStore;
  let clock: number;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    clock = NOW;
    store = new ReminderStore(driver, () => clock);
  });
  afterEach(() => driver.close());

  const make = (text: string, dueAtUtc: number, status: string, updatedAt = dueAtUtc) => {
    const r = store.schedule({ principal: PRINCIPAL, text, dueAtUtc, localWallTime: '2026-01-01T09:00', tz: 'Asia/Jerusalem' });
    driver.exec('UPDATE reminders SET status = ?, updated_at = ? WHERE id = ?', status, updatedAt, r.id);
    return r.id;
  };
  const ids = () => driver.exec('SELECT id FROM reminders').map((row) => String(row['id']));

  it('is 90 days', () => {
    expect(SETTLED_RETENTION_MS).toBe(90 * DAY);
    expect(AUDIT_RETENTION_MS).toBe(90 * DAY);
  });

  it('deletes final reminders older than 90 days, and nothing else', () => {
    const old = NOW - 91 * DAY;
    const gone = ['sent', 'done', 'failed', 'cancelled'].map((status) => make(status, old, status));
    const kept = [
      make('scheduled', old, 'scheduled'),
      make('sending', old, 'sending'),
      make('recent', NOW - 10 * DAY, 'done'),
      // Due long ago, but touched recently (a late failure report): kept.
      make('touched', old, 'failed', NOW - 1 * DAY),
    ];

    expect(store.purgeSettledBefore(NOW - SETTLED_RETENTION_MS)).toBe(4);
    expect(ids().sort()).toEqual(kept.sort());
    for (const id of gone) expect(store.byId(id)).toBeNull();
  });

  it("never touches a repeating series' next occurrence, which keeps firing after the purge", () => {
    clock = NOW - 200 * DAY;
    const first = store.schedule({
      principal: PRINCIPAL,
      text: 'לקחת תרופה',
      dueAtUtc: clock + 1_000,
      localWallTime: '2026-03-08T12:00',
      tz: 'Asia/Jerusalem',
      rule: { freq: 'daily', hour: 12, minute: 0 },
    });
    clock += 2_000;
    expect(store.claimDue().map((r) => r.id)).toEqual([first.id]);
    store.markSent(first.id, 'wamid.r1');
    const next = driver.exec(`SELECT id FROM reminders WHERE status = 'scheduled'`).map((row) => String(row['id']));
    expect(next).toHaveLength(1);

    clock = NOW;
    store.purgeSettledBefore(NOW - SETTLED_RETENTION_MS);
    expect(store.byId(first.id)).toBeNull();
    expect(store.byId(next[0]!)?.status).toBe('scheduled');
    // The series still runs.
    expect(driver.exec(`SELECT status FROM reminder_series`)).toEqual([{ status: 'active' }]);
  });

  it('deletes audit rows older than 90 days and keeps the last day that rate limits read', () => {
    const row = (ts: number) => repo.audit({ ts, principal: PRINCIPAL, tool: 'reminders.create', tier: 1, decision: 'ALLOW', outcome: 'ok', externalRef: null });
    row(NOW - 100 * DAY);
    row(NOW - 91 * DAY);
    row(NOW - 89 * DAY);
    row(NOW - 60_000);

    expect(repo.purgeAuditBefore(NOW - AUDIT_RETENTION_MS)).toBe(2);
    expect(driver.exec('SELECT ts FROM audit_log ORDER BY ts').map((r) => Number(r['ts']))).toEqual([NOW - 89 * DAY, NOW - 60_000]);
    expect(repo.toolUsage(PRINCIPAL, 'reminders.create', NOW)).toEqual({ perHour: 1, perDay: 1 });
  });
});

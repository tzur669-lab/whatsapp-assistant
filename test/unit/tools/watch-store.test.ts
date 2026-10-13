/**
 * The watch store (block J, J4, PLAN §6.30): a fire claims once and schedules
 * a due-now reminder in the same transaction; expired, cancelled, spent and
 * cooling-down watches claim nothing; the mail query is code's own.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import {
  MAIL_OVERLAP_MS,
  MAX_ACTIVE_WATCHES,
  WATCH_COOLDOWN_MS,
  WATCH_RETENTION_MS,
  WatchStore,
  mailQuery,
} from '../../../src/tools/watch-store.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-10-13T09:00:00Z');
const P = 'p_watch';
const DAY = 24 * 60 * 60 * 1000;

describe('WatchStore', () => {
  let driver: TestSqlDriver;
  let clock: number;
  let watches: WatchStore;
  let reminders: ReminderStore;

  const create = (overrides: Partial<Parameters<WatchStore['create']>[0]> = {}) => {
    const made = watches.create({
      principal: P,
      source: 'notification',
      said: ['חבילה'],
      text: 'לאסוף את החבילה',
      repeat: false,
      expiresAt: clock + 30 * DAY,
      ...overrides,
    });
    if (!made.ok) throw new Error('full');
    return made.id;
  };
  const scheduled = () => driver.exec("SELECT text, due_at_utc FROM reminders WHERE status = 'scheduled'");

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    clock = NOW;
    watches = new WatchStore(driver, () => clock);
    reminders = new ReminderStore(driver, () => clock);
  });
  afterEach(() => driver.close());

  it('stores the keywords normalized for the phone, and as said', () => {
    create({ said: ['DHL', 'חבילה!'] });
    const [watch] = watches.active(P);
    expect(watch).toMatchObject({ keywords: ['dhl', 'חבילה'], said: ['DHL', 'חבילה!'], firesLeft: 1 });
  });

  it('a fire claims once and schedules the reminder due now', () => {
    const id = create();
    expect(watches.fire(P, id, reminders)).toBe('claimed');
    expect(scheduled()).toEqual([{ text: 'לאסוף את החבילה', due_at_utc: NOW }]);
    expect(watches.fire(P, id, reminders)).toBe('none');
    expect(scheduled()).toHaveLength(1);
    expect(watches.active(P)).toHaveLength(0);
  });

  it('two fires racing give one reminder', () => {
    const id = create();
    const outcomes = [watches.fire(P, id, reminders), watches.fire(P, id, reminders)];
    expect(outcomes.sort()).toEqual(['claimed', 'none']);
    expect(scheduled()).toHaveLength(1);
  });

  it("never fires another principal's watch", () => {
    const id = create();
    expect(watches.fire('p_other', id, reminders)).toBe('none');
    expect(scheduled()).toHaveLength(0);
  });

  it('never fires a cancelled or expired watch', () => {
    const cancelled = create();
    expect(watches.cancel(P, cancelled)).toBe(true);
    expect(watches.fire(P, cancelled, reminders)).toBe('none');
    const expiring = create({ expiresAt: clock + 1_000 });
    clock += 1_000;
    expect(watches.fire(P, expiring, reminders)).toBe('none');
    expect(watches.active(P)).toHaveLength(0);
    expect(scheduled()).toHaveLength(0);
  });

  it('a repeating watch fires up to five times, an hour apart', () => {
    const id = create({ repeat: true });
    let fired = 0;
    for (let i = 0; i < 12; i++) {
      if (watches.fire(P, id, reminders) === 'claimed') fired++;
      expect(watches.fire(P, id, reminders)).toBe('none'); // cooling down
      clock += WATCH_COOLDOWN_MS;
    }
    expect(fired).toBe(5);
  });

  it(`keeps at most ${MAX_ACTIVE_WATCHES} active`, () => {
    for (let i = 0; i < MAX_ACTIVE_WATCHES; i++) create();
    expect(watches.create({ principal: P, source: 'sms', said: ['x'], text: 't', repeat: false, expiresAt: clock + DAY })).toEqual({
      ok: false,
      reason: 'full',
    });
  });

  it('records a mail check only on a watch still active', () => {
    const id = create({ source: 'mail' });
    watches.cancel(P, id);
    watches.recordMailCheck(id, clock, ['m1']);
    expect(driver.exec('SELECT last_checked FROM watches WHERE id = ?', id)[0]?.['last_checked']).toBeNull();
  });

  it('keeps the newest 50 seen ids', () => {
    const id = create({ source: 'mail' });
    watches.recordMailCheck(id, clock, Array.from({ length: 60 }, (_, i) => `m${i}`));
    const [watch] = watches.mailWatches(P);
    expect(watch!.seen).toHaveLength(50);
    expect(watch!.seen[0]).toBe('m10');
  });

  it('purges ended watches after 90 days', () => {
    const id = create();
    watches.fire(P, id, reminders);
    clock += WATCH_RETENTION_MS + 1;
    expect(watches.purge()).toBe(1);
  });
});

describe('mailQuery', () => {
  const created = NOW;

  it('a new watch looks back no further than its own creation', () => {
    expect(mailQuery({ said: ['DHL'], sender: null, createdAt: created, lastChecked: null })).toBe(
      `after:${Math.floor(created / 1000)} "DHL"`,
    );
  });

  it('a later tick looks back 15 minutes past its last check', () => {
    const last = created + 3 * 60 * 60 * 1000;
    expect(mailQuery({ said: ['חבילה'], sender: null, createdAt: created, lastChecked: last })).toBe(
      `after:${Math.floor((last - MAIL_OVERLAP_MS) / 1000)} "חבילה"`,
    );
  });

  it('strips anything Gmail would read as an operator', () => {
    expect(mailQuery({ said: ['a" OR from:x', 'b)'], sender: 'דני (בנק)', createdAt: created, lastChecked: null })).toBe(
      `after:${Math.floor(created / 1000)} from:(דני בנק) "a OR from x" "b"`,
    );
  });
});

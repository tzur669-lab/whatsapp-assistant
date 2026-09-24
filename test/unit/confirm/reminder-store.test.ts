/**
 * Reminder storage and the claim/lease protocol (PLAN §6.7).
 *
 * The failure this guards against is the one users actually notice: a reminder
 * that fires twice, or one that silently never fires because a crash left it
 * marked as in-flight. Every case here is about that boundary.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';

const NOW = Date.UTC(2026, 8, 24, 18, 0, 0);
const MINUTE = 60_000;
const SENDER = 'p_sender000000';
const OTHER = 'p_other0000000';

describe('ReminderStore', () => {
  let driver: TestSqlDriver;
  let store: ReminderStore;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    store = new ReminderStore(driver, () => now);
  });
  afterEach(() => driver.close());

  const schedule = (dueInMinutes: number, text = 'להתקשר לאבא', principal = SENDER) =>
    store.schedule({
      principal,
      text,
      dueAtUtc: NOW + dueInMinutes * MINUTE,
      localWallTime: '2026-09-24 21:30',
      tz: 'Asia/Jerusalem',
    });

  describe('scheduling', () => {
    it('stores a reminder as scheduled', () => {
      const reminder = schedule(60);
      expect(reminder.status).toBe('scheduled');
      expect(reminder.id).toMatch(/^[0-9a-f]+$/);
    });

    it('keeps the local wall time alongside the instant, for DST-safe echoes', () => {
      const reminder = schedule(60);
      const row = driver.exec('SELECT * FROM reminders WHERE id = ?', reminder.id)[0]!;
      expect(row['local_wall_time']).toBe('2026-09-24 21:30');
      expect(row['tz']).toBe('Asia/Jerusalem');
    });

    it('lists only this principal’s upcoming reminders, soonest first', () => {
      schedule(120, 'later');
      schedule(60, 'sooner');
      schedule(30, 'other person', OTHER);

      const list = store.listUpcoming(SENDER);
      expect(list.map((r) => r.text)).toEqual(['sooner', 'later']);
    });

    it('leaves past reminders out of the upcoming list', () => {
      schedule(-60, 'already gone');
      schedule(60, 'still coming');
      expect(store.listUpcoming(SENDER).map((r) => r.text)).toEqual(['still coming']);
    });
  });

  describe('claiming due reminders', () => {
    it('claims one that is due', () => {
      const reminder = schedule(10);
      now = NOW + 10 * MINUTE;
      const claimed = store.claimDue();
      expect(claimed.map((r) => r.id)).toEqual([reminder.id]);
    });

    it('does not claim one that is not due yet', () => {
      schedule(10);
      now = NOW + 9 * MINUTE;
      expect(store.claimDue()).toEqual([]);
    });

    it('does not claim the same row twice while the lease holds', () => {
      schedule(10);
      now = NOW + 10 * MINUTE;
      expect(store.claimDue()).toHaveLength(1);
      // A second alarm firing immediately must find nothing to do.
      expect(store.claimDue()).toEqual([]);
    });

    it('reclaims after the lease expires, so a crash loses nothing', () => {
      schedule(10);
      now = NOW + 10 * MINUTE;
      expect(store.claimDue()).toHaveLength(1);

      now = NOW + 12 * MINUTE; // lease is 60s
      expect(store.claimDue()).toHaveLength(1);
    });

    it('counts an attempt on every claim', () => {
      schedule(10);
      now = NOW + 10 * MINUTE;
      store.claimDue();
      now = NOW + 12 * MINUTE;
      const second = store.claimDue();
      expect(second[0]?.attempts).toBe(2);
    });

    it('gives up after five attempts and says so', () => {
      const reminder = schedule(10);
      now = NOW + 10 * MINUTE;
      for (let i = 0; i < 5; i++) {
        store.claimDue();
        now += 2 * MINUTE;
      }
      expect(store.claimDue()).toEqual([]);

      const row = driver.exec('SELECT status FROM reminders WHERE id = ?', reminder.id)[0]!;
      expect(row['status']).toBe('failed');
    });

    it('claims several due reminders at once', () => {
      schedule(5);
      schedule(10);
      now = NOW + 15 * MINUTE;
      expect(store.claimDue()).toHaveLength(2);
    });

    it('never claims a cancelled reminder', () => {
      const reminder = schedule(10);
      store.cancel(reminder.id, SENDER);
      now = NOW + 10 * MINUTE;
      expect(store.claimDue()).toEqual([]);
    });
  });

  describe('completing a send', () => {
    it('marks sent and records the message id', () => {
      const reminder = schedule(10);
      now = NOW + 10 * MINUTE;
      store.claimDue();
      store.markSent(reminder.id, 'wamid.OUT');

      const row = driver.exec('SELECT * FROM reminders WHERE id = ?', reminder.id)[0]!;
      expect(row['status']).toBe('sent');
      expect(row['wamid']).toBe('wamid.OUT');
    });

    it('does not re-send a reminder already marked sent', () => {
      const reminder = schedule(10);
      now = NOW + 10 * MINUTE;
      store.claimDue();
      store.markSent(reminder.id, 'wamid.OUT');

      now = NOW + 30 * MINUTE;
      expect(store.claimDue()).toEqual([]);
    });

    it('returns a failed send to scheduled so it is retried', () => {
      const reminder = schedule(10);
      now = NOW + 10 * MINUTE;
      store.claimDue();
      store.markFailed(reminder.id);

      const row = driver.exec('SELECT status, lease_until FROM reminders WHERE id = ?', reminder.id)[0]!;
      expect(row['status']).toBe('scheduled');
      expect(row['lease_until']).toBeNull();
    });

    it('lets a returned reminder be claimed again immediately', () => {
      const reminder = schedule(10);
      now = NOW + 10 * MINUTE;
      store.claimDue();
      store.markFailed(reminder.id);
      expect(store.claimDue().map((r) => r.id)).toEqual([reminder.id]);
    });
  });

  describe('cancelling', () => {
    it('cancels one belonging to this principal', () => {
      const reminder = schedule(60);
      expect(store.cancel(reminder.id, SENDER)).toBe(true);
      expect(store.listUpcoming(SENDER)).toEqual([]);
    });

    it('refuses to cancel another principal’s reminder', () => {
      const reminder = schedule(60);
      expect(store.cancel(reminder.id, OTHER)).toBe(false);
      expect(store.listUpcoming(SENDER)).toHaveLength(1);
    });

    it('returns false for an unknown id', () => {
      expect(store.cancel('nope', SENDER)).toBe(false);
    });
  });

  describe('the next alarm time', () => {
    it('is the earliest pending due time', () => {
      schedule(120);
      schedule(45);
      schedule(90);
      expect(store.nextDueAt()).toBe(NOW + 45 * MINUTE);
    });

    it('is null when nothing is pending', () => {
      expect(store.nextDueAt()).toBeNull();
    });

    it('ignores cancelled and sent reminders', () => {
      const cancelled = schedule(30);
      store.cancel(cancelled.id, SENDER);
      schedule(90);
      expect(store.nextDueAt()).toBe(NOW + 90 * MINUTE);
    });

    it('includes a leased row, so a lost lease still gets an alarm', () => {
      schedule(10);
      now = NOW + 10 * MINUTE;
      store.claimDue();
      expect(store.nextDueAt()).not.toBeNull();
    });
  });

  describe('lateness', () => {
    it('reports how late a delivery is', () => {
      schedule(10);
      now = NOW + 25 * MINUTE;
      const claimed = store.claimDue();
      expect(claimed[0]?.lateByMs).toBe(15 * MINUTE);
    });

    it('reports zero when on time', () => {
      schedule(10);
      now = NOW + 10 * MINUTE;
      expect(store.claimDue()[0]?.lateByMs).toBe(0);
    });
  });
});

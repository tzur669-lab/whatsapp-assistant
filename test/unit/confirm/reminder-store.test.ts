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

  describe('recurring series (B6)', () => {
    // NOW is 2026-09-24 21:00 local. Every day at 21:30.
    const RULE = { freq: 'daily' as const, hour: 21, minute: 30 };
    const DAY = 24 * 60 * MINUTE;

    const scheduleSeries = () =>
      store.schedule({
        principal: SENDER,
        text: 'תרופה',
        dueAtUtc: NOW + 30 * MINUTE,
        localWallTime: '2026-09-24T21:30',
        tz: 'Asia/Jerusalem',
        rule: RULE,
      });

    const scheduledDues = () =>
      driver
        .exec(`SELECT due_at_utc FROM reminders WHERE status = 'scheduled' ORDER BY due_at_utc`)
        .map((row) => Number(row['due_at_utc']));

    it('lists an occurrence with its rule', () => {
      const first = scheduleSeries();
      const listed = store.listUpcoming(SENDER)[0]!;
      expect(listed.seriesId).toBe(first.seriesId);
      expect(listed.rule).toEqual(RULE);
    });

    it('writes the next occurrence when the current one is claimed', () => {
      scheduleSeries();
      now = NOW + 30 * MINUTE;
      expect(store.claimDue()).toHaveLength(1);
      expect(scheduledDues()).toEqual([NOW + 30 * MINUTE + DAY]);
    });

    it('writes it once, even when the claim is retried', () => {
      const first = scheduleSeries();
      now = NOW + 30 * MINUTE;
      store.claimDue();
      store.markFailed(first.id);
      store.claimDue();
      // The retried occurrence is `sending` again; one successor is waiting.
      expect(scheduledDues()).toEqual([NOW + 30 * MINUTE + DAY]);
    });

    it('carries on after a send that was given up on', () => {
      const first = scheduleSeries();
      now = NOW + 30 * MINUTE;
      store.claimDue();
      store.abandon(first.id);
      expect(scheduledDues()).toEqual([NOW + 30 * MINUTE + DAY]);
    });

    it('skips to the next one still ahead after a late delivery', () => {
      scheduleSeries();
      now = NOW + 30 * MINUTE + 3 * DAY + MINUTE;
      store.claimDue();
      expect(scheduledDues()).toEqual([NOW + 30 * MINUTE + 4 * DAY]);
    });

    it('cancelling any occurrence ends the series', () => {
      const first = scheduleSeries();
      now = NOW + 30 * MINUTE;
      store.claimDue();
      store.markSent(first.id, 'wamid.1');

      // The user cancels the occurrence they were shown, which has since fired.
      expect(store.cancel(first.id, SENDER)).toBe(true);
      expect(scheduledDues()).toEqual([]);
    });

    it('a cancelled series is not revived by a late failure report', () => {
      const first = scheduleSeries();
      now = NOW + 30 * MINUTE;
      store.claimDue();
      store.markSent(first.id, 'wamid.1');
      store.cancel(first.id, SENDER);

      expect(store.reopenForRetry(first.id)).toEqual({ retrying: false });
      expect(store.byId(first.id)?.status).toBe('cancelled');
      expect(store.claimDue()).toHaveLength(0);
      expect(scheduledDues()).toEqual([]);
    });

    it('only the owner may cancel a series', () => {
      const first = scheduleSeries();
      expect(store.cancel(first.id, OTHER)).toBe(false);
      expect(scheduledDues()).toHaveLength(1);
    });

    it('moves one waiting occurrence, and only a waiting one', () => {
      const first = scheduleSeries();
      expect(store.reschedule(first.id, SENDER, NOW + 90 * MINUTE, '2026-09-24T22:30')).toBe(true);
      expect(store.byId(first.id)?.dueAtUtc).toBe(NOW + 90 * MINUTE);

      now = NOW + 90 * MINUTE;
      store.claimDue();
      expect(store.reschedule(first.id, SENDER, NOW + DAY, 'x')).toBe(false);
    });
  });
});

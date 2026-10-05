/**
 * The reminder tools added on 2026-10-05: `reminders.repeat` (B6),
 * `reminders.move` (B8) and `reminders.at_rest`.
 *
 * Same contract as the first three: nothing defaulted, every time computed by
 * code, targets found in code, and an Undo or a cancel that means the series.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  remindersAtRest,
  remindersCancel,
  remindersList,
  remindersMove,
  remindersRepeat,
} from '../../../src/tools/reminders.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { upcomingRestTimes } from '../../../src/time/shabbat.js';

/** Thursday 2026-09-24, 12:00 local (09:00Z). */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_test';
const MINUTE = 60_000;

const at = (hour: number, minute = 0, extra: Partial<{ meridiem: string; part_of_day: string }> = {}) => ({
  hour,
  minute,
  meridiem: 'unspecified',
  part_of_day: 'unspecified',
  ...extra,
});

describe('reminders added 2026-10-05', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let ctx: ToolContext;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => now);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
    };
  });
  afterEach(() => driver.close());

  const plain = (text: string) => stripIsolates(text);
  const ready = <T>(outcome: ReturnType<typeof remindersRepeat.resolve>): T => {
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') throw new Error('not ready');
    return outcome.input as T;
  };

  // -- repeat -----------------------------------------------------------------

  describe('reminders.repeat', () => {
    type Input = { text: string; dueAtUtc: number; localWallTime: string; rule: Record<string, unknown> };

    it('"every Sunday at 8": a weekly rule, first on the coming Sunday', () => {
      const input = ready<Input>(
        remindersRepeat.resolve({ text: 'לשים זבל', time: at(8), weekdays: [0] }, ctx),
      );
      expect(input.rule).toEqual({ freq: 'weekly', hour: 8, minute: 0, weekdays: [0] });
      expect(input.localWallTime).toBe('2026-09-27T08:00');
    });

    it('"every day at 7": daily, first tomorrow when today\'s has passed', () => {
      const input = ready<Input>(remindersRepeat.resolve({ text: 'כדור', time: at(7), every: 'day' }, ctx));
      expect(input.rule).toEqual({ freq: 'daily', hour: 7, minute: 0 });
      expect(input.localWallTime).toBe('2026-09-25T07:00');
    });

    it('all seven days is every day', () => {
      const input = ready<Input>(
        remindersRepeat.resolve({ text: 'כדור', time: at(20), weekdays: [6, 0, 1, 2, 3, 4, 5] }, ctx),
      );
      expect(input.rule).toEqual({ freq: 'daily', hour: 20, minute: 0 });
    });

    it('monthly on a stated day', () => {
      const input = ready<Input>(
        remindersRepeat.resolve({ text: 'שכר דירה', time: at(9), every: 'month', day_of_month: 1 }, ctx),
      );
      expect(input.rule).toEqual({ freq: 'monthly', hour: 9, minute: 0, day: 1 });
      expect(input.localWallTime).toBe('2026-10-01T09:00');
    });

    it('asks for a time rather than defaulting one (R3)', () => {
      expect(remindersRepeat.resolve({ text: 'כדור', every: 'day' }, ctx)).toMatchObject({
        kind: 'clarify',
        clarify: { code: 'time', detail: { rule: 'R3' } },
      });
    });

    it('asks how often when nothing says', () => {
      expect(remindersRepeat.resolve({ text: 'כדור', time: at(8) }, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'date' },
      });
      expect(remindersRepeat.resolve({ text: 'כדור', time: at(8), every: 'week' }, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'date' },
      });
    });

    it('asks about a bare small-hours time (R5)', () => {
      expect(remindersRepeat.resolve({ text: 'x', time: at(3), every: 'day' }, ctx)).toMatchObject({
        clarify: { code: 'time', detail: { rule: 'R5' } },
      });
    });

    it('asks now about a time a coming clock change repeats (R2)', () => {
      // 01:30 happens twice on 2026-10-25.
      expect(
        remindersRepeat.resolve({ text: 'x', time: at(1, 30, { part_of_day: 'night' }), every: 'day' }, ctx),
      ).toMatchObject({ clarify: { code: 'time', detail: { rule: 'R2', reason: 'recurring_dst' } } });
    });

    it('confirms the rule and the first one in the reply, and lists it with 🔁', async () => {
      const input = ready<Input>(remindersRepeat.resolve({ text: 'לשים זבל', time: at(8), weekdays: [0] }, ctx));
      const result = await remindersRepeat.execute(input, ctx);
      expect(plain(result.text)).toContain('נקבעה תזכורת חוזרת: כל יום א׳ · 08:00');
      expect(plain(result.text)).toContain('הראשונה: יום א׳ 27.9 · 08:00');

      const listed = await remindersList.execute({}, ctx);
      expect(plain(listed.text)).toContain('🔁 כל יום א׳ · 08:00');
    });

    it('Undo ends the series, even after the first one has fired', async () => {
      const input = ready<Input>(remindersRepeat.resolve({ text: 'כדור', time: at(13), every: 'day' }, ctx));
      const result = await remindersRepeat.execute(input, ctx);

      now = NOW + 61 * MINUTE; // 13:01: the first fires, the next is written.
      expect(reminders.claimDue()).toHaveLength(1);
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);

      await remindersRepeat.undo!(result.compensating, ctx);
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('a cancel of one occurrence previews and ends the whole series', async () => {
      const input = ready<Input>(remindersRepeat.resolve({ text: 'כדור', time: at(20), every: 'day' }, ctx));
      await remindersRepeat.execute(input, ctx);

      const cancel = remindersCancel.resolve({ query_variants: ['כדור'] }, ctx);
      expect(cancel.kind).toBe('ready');
      if (cancel.kind !== 'ready') return;
      expect(plain(remindersCancel.preview(cancel.input, 'he'))).toContain('כולל כל הפעמים הבאות');

      await remindersCancel.execute(cancel.input, ctx);
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });
  });

  // -- move -------------------------------------------------------------------

  describe('reminders.move', () => {
    type Input = { reminderId: string; dueAtUtc: number; localWallTime: string; recurring: boolean };

    const doctor = () =>
      reminders.schedule({
        principal: PRINCIPAL,
        text: 'רופא',
        dueAtUtc: Date.parse('2026-09-25T05:00:00Z'), // Fri 08:00
        localWallTime: '2026-09-25T08:00',
        tz: 'Asia/Jerusalem',
      });

    it('"to 17:00" keeps the day', () => {
      const target = doctor();
      const input = ready<Input>(
        remindersMove.resolve({ query_variants: ['רופא'], to_time: at(17) }, ctx),
      );
      expect(input.reminderId).toBe(target.id);
      expect(input.localWallTime).toBe('2026-09-25T17:00');
    });

    it('"to Sunday" keeps the hour', () => {
      doctor();
      const input = ready<Input>(
        remindersMove.resolve(
          { query_variants: ['רופא'], to_date: { kind: 'weekday', weekday: 0, qualifier: 'unspecified' } },
          ctx,
        ),
      );
      expect(input.localWallTime).toBe('2026-09-27T08:00');
    });

    it('asks when to, rather than guessing', () => {
      doctor();
      expect(remindersMove.resolve({ query_variants: ['רופא'] }, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'time' },
      });
    });

    it('says nothing matched rather than moving something near enough', () => {
      doctor();
      expect(remindersMove.resolve({ query_variants: ['חלב'], to_time: at(17) }, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'not_found' },
      });
    });

    it('previews both times, moves it, and reports honestly once it is gone', async () => {
      const target = doctor();
      const input = ready<Input>(remindersMove.resolve({ query_variants: ['רופא'], to_time: at(17) }, ctx));
      expect(plain(remindersMove.preview(input, 'he'))).toBe(
        'הזזת התזכורת מיום ו׳ 25.9 · 08:00 ליום ו׳ 25.9 · 17:00\nרופא',
      );

      const moved = await remindersMove.execute(input, ctx);
      expect(plain(moved.text)).toBe('התזכורת הוזזה ליום ו׳ 25.9 · 17:00.');
      expect(reminders.byId(target.id)?.localWallTime).toBe('2026-09-25T17:00');

      reminders.cancel(target.id, PRINCIPAL);
      const again = await remindersMove.execute(input, ctx);
      expect(again.text).toContain('כבר לא ממתינה');
    });

    it('a recurring one moves this time only, and the preview says so', async () => {
      const input = ready<{ text: string }>(
        remindersRepeat.resolve({ text: 'כדור', time: at(20), every: 'day' }, ctx),
      );
      await remindersRepeat.execute(input, ctx);
      const move = ready<Input>(remindersMove.resolve({ query_variants: ['כדור'], to_time: at(21) }, ctx));
      expect(move.recurring).toBe(true);
      expect(plain(remindersMove.preview(move, 'he'))).toContain('רק הפעם הזאת');
    });
  });

  // -- at_rest ----------------------------------------------------------------

  describe('reminders.at_rest', () => {
    type Input = { dueAtUtc: number; held: boolean };
    const shabbat = () => upcomingRestTimes(NOW, 'shabbat').next().value!;

    it('"an hour before Shabbat" is candle lighting less an hour', () => {
      const input = ready<Input>(
        remindersAtRest.resolve({ text: 'להדליק נרות', event: 'shabbat_start', minutes: 60 }, ctx),
      );
      expect(input.dueAtUtc).toBe(shabbat().startUtc - 60 * MINUTE);
      expect(input.held).toBe(false);
    });

    it('"at candle lighting" is a minute before, never inside Shabbat', () => {
      const input = ready<Input>(remindersAtRest.resolve({ text: 'נרות', event: 'shabbat_start' }, ctx));
      expect(input.dueAtUtc).toBe(shabbat().startUtc - MINUTE);
    });

    it('"half an hour after Shabbat" is nightfall plus thirty minutes', () => {
      const input = ready<Input>(
        remindersAtRest.resolve({ text: 'להחזיר את המכונית', event: 'shabbat_end', minutes: 30 }, ctx),
      );
      expect(input.dueAtUtc).toBe(shabbat().endUtc + 30 * MINUTE);
    });

    it('asks which, when the event is missing', () => {
      expect(remindersAtRest.resolve({ text: 'נרות' }, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'date' },
      });
    });

    it('says it will arrive late when the hold is on and the time is inside a chag', async () => {
      // Shabbat 12.9.2026 runs into the second day of Rosh Hashana.
      repo.setRestHold(true);
      const early = { ...ctx, nowMs: Date.parse('2026-09-07T09:00:00Z') };
      const input = ready<Input>(
        remindersAtRest.resolve({ text: 'x', event: 'shabbat_end', minutes: 10 }, early),
      );
      expect(input.held).toBe(true);
      const result = await remindersAtRest.execute(input, early);
      expect(result.text).toContain('תגיע בצאת השבת או החג');
      expect(result.compensating).toMatchObject({ reminderId: expect.any(String) });
    });
  });
});

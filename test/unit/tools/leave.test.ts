/**
 * "Time to leave" on request (ROADMAP #5, 2026-10-06): the event is found in
 * code, the reminder is set the travel time before it, a calendar title taints,
 * and the place rides along to the delivery. No network.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_TRAVEL_MINUTES, remindersLeave, remindersList } from '../../../src/tools/reminders.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { Repository } from '../../../src/core/repo.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { CalendarClient, CalendarEvent } from '../../../src/google/calendar.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const MIGRATIONS = ['0001_init.sql', '0002_confirm.sql', '0003_reminders.sql', '0017_recurring.sql', '0018_scheduled_reads.sql', '0021_reminder_place.sql'].map(
  (file, index) => ({ id: index + 1, sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8') }),
);

/** Tuesday 2026-10-06, 09:00 local. */
const NOW = Date.parse('2026-10-06T06:00:00Z');
const HOUR = 3_600_000;

const event = (title: string, startUtc: number, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: title,
  title,
  startUtc,
  endUtc: startUtc + HOUR,
  allDay: false,
  createdByAssistant: false,
  etag: null,
  ...extra,
});

function calendarWith(events: CalendarEvent[]): CalendarClient {
  return { listAllEvents: async () => ({ ok: true, value: events }) } as unknown as CalendarClient;
}

describe('reminders.leave', () => {
  let driver: TestSqlDriver;
  let reminders: ReminderStore;
  let repo: Repository;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
  });
  afterEach(() => driver.close());

  const ctx = (calendar?: CalendarClient): ToolContext =>
    ({
      principal: 'p',
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
      ...(calendar ? { calendar } : {}),
    }) as unknown as ToolContext;

  it('sets it the travel time before the event, keeps the place, and taints', async () => {
    const calendar = calendarWith([
      event('קפה עם יוסי', NOW + 2 * HOUR),
      event('רופא שיניים', NOW + 5 * HOUR, { location: 'הרצל 10, רחובות' }),
    ]);
    const out = await remindersLeave.resolveAsync!({ event: ['רופא'], minutes: 45 }, ctx(calendar));
    expect(out).toMatchObject({ kind: 'ready', tainting: true, input: { dueAtUtc: NOW + 5 * HOUR - 45 * 60_000, place: 'הרצל 10, רחובות' } });
    if (out.kind !== 'ready') throw new Error('expected ready');

    const result = await remindersLeave.execute(out.input, ctx(calendar));
    expect(result.tainting).toBe(true);
    expect(stripIsolates(result.text)).toBe(
      'נקבעה תזכורת יציאה ליום ג׳ 6.10 · 13:15, 45 דקות לפני תחילת האירוע (14:00).\nלצאת ל־רופא שיניים\nבזמן התזכורת יופיע גם כפתור ניווט ב־Waze.',
    );
    const [stored] = reminders.listUpcoming('p');
    expect(stored).toMatchObject({ text: 'לצאת ל־רופא שיניים', place: 'הרצל 10, רחובות' });
  });

  it('takes half an hour when no travel time is said, and the next timed event when none is named', async () => {
    const calendar = calendarWith([
      event('חג', NOW + HOUR, { allDay: true }),
      event('ישיבה', NOW + 3 * HOUR),
    ]);
    const out = await remindersLeave.resolveAsync!({ next_event: true }, ctx(calendar));
    expect(out).toMatchObject({ kind: 'ready', input: { dueAtUtc: NOW + 3 * HOUR - DEFAULT_TRAVEL_MINUTES * 60_000, minutes: 30 } });
    if (out.kind !== 'ready') throw new Error('expected ready');
    expect((out.input as { place?: string }).place).toBeUndefined();
    expect(stripIsolates(remindersLeave.preview(out.input, 'he'))).not.toContain('Waze');
  });

  it('asks rather than guesses', async () => {
    const calendar = calendarWith([event('ישיבה', NOW + 20 * 60_000)]);
    expect(await remindersLeave.resolveAsync!({}, ctx(calendar))).toEqual({ kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } });
    expect(await remindersLeave.resolveAsync!({ event: [], minutes: 60 }, ctx(calendar))).toEqual({
      kind: 'clarify',
      clarify: { code: 'missing_slot', slot: 'target' },
    });
    expect(await remindersLeave.resolveAsync!({ event: ['טיסה'] }, ctx(calendar))).toEqual({ kind: 'clarify', clarify: { code: 'not_found' } });
    expect(await remindersLeave.resolveAsync!({ next_event: true }, ctx())).toEqual({ kind: 'clarify', clarify: { code: 'not_connected' } });
    // Twenty minutes away and half an hour to travel: too late.
    expect(await remindersLeave.resolveAsync!({ event: ['ישיבה'] }, ctx(calendar))).toEqual({
      kind: 'clarify',
      clarify: { code: 'leave_too_late' },
      tainting: true,
    });
    expect(remindersLeave.inputSchema.safeParse({}).success).toBe(false);
  });

  it('caps a long title so the stored text fits a reminder', async () => {
    const calendar = calendarWith([event('א'.repeat(400), NOW + 5 * HOUR)]);
    const out = await remindersLeave.resolveAsync!({ next_event: true }, ctx(calendar));
    if (out.kind !== 'ready') throw new Error('expected ready');
    expect((out.input as { text: string }).text.length).toBe(200);
    await remindersLeave.execute(out.input, ctx(calendar));
  });

  it('is undone like any reminder', async () => {
    const calendar = calendarWith([event('ישיבה', NOW + 3 * HOUR)]);
    const out = await remindersLeave.resolveAsync!({ next_event: true }, ctx(calendar));
    if (out.kind !== 'ready') throw new Error('expected ready');
    const result = await remindersLeave.execute(out.input, ctx(calendar));
    await remindersLeave.undo!(result.compensating, ctx(calendar));
    expect(reminders.listUpcoming('p')).toHaveLength(0);
  });

  it('makes the reminder list taint when it shows one', async () => {
    reminders.schedule({ principal: 'p', text: 'להתקשר לאבא', dueAtUtc: NOW + HOUR, localWallTime: '', tz: 'Asia/Jerusalem' });
    expect((await remindersList.execute({}, ctx())).tainting).toBeUndefined();
    reminders.schedule({ principal: 'p', text: 'לצאת ל־ישיבה', dueAtUtc: NOW + 2 * HOUR, localWallTime: '', tz: 'Asia/Jerusalem', place: 'x' });
    expect((await remindersList.execute({}, ctx())).tainting).toBe(true);
  });
});

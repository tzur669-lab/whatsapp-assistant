/**
 * The `reminders.*` tools (PLAN §6.4, §6.7, §11.3).
 *
 * The contract under test: nothing is defaulted, every date comes from the time
 * resolver, targets are found in code from `query_variants`, and an input that
 * survives a confirmation round trip is re-validated before it runs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  remindersCreate,
  remindersList,
  remindersCancel,
  matchReminders,
} from '../../../src/tools/reminders.js';
import { ToolInputError } from '../../../src/tools/types.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { FREE_MESSAGES_PER_MONTH } from '../../../src/policy/window.js';
import type { Reminder } from '../../../src/tools/reminder-store.js';

const MIGRATION_FILES = ['0001_init.sql', '0002_confirm.sql', '0003_reminders.sql'];
const MIGRATIONS = MIGRATION_FILES.map((file, index) => ({
  id: index + 1,
  sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
}));

/** Thursday 2026-09-24, 12:00 local (09:00Z). */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_test';

const AT_EIGHT_TOMORROW = {
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

describe('reminders tools', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let ctx: ToolContext;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
    };
  });
  afterEach(() => driver.close());

  const plain = (text: string) => stripIsolates(text);

  // -- create -----------------------------------------------------------------

  describe('reminders.create', () => {
    it('resolves text and time into an instant', () => {
      const outcome = remindersCreate.resolve(
        { text: 'להתקשר לאבא', ...AT_EIGHT_TOMORROW },
        ctx,
      );
      expect(outcome.kind).toBe('ready');
      if (outcome.kind !== 'ready') return;

      const input = outcome.input as { text: string; dueAtUtc: number; localWallTime: string };
      expect(input.text).toBe('להתקשר לאבא');
      expect(input.localWallTime).toBe('2026-09-25T08:00');
      expect(new Date(input.dueAtUtc).toISOString()).toBe('2026-09-25T05:00:00.000Z');
    });

    it('asks what to remind about rather than inventing a subject', () => {
      const outcome = remindersCreate.resolve(AT_EIGHT_TOMORROW, ctx);
      expect(outcome).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'text' },
      });
    });

    it('asks for a time rather than defaulting one', () => {
      // The single most consequential refusal in the system (R11).
      const outcome = remindersCreate.resolve(
        { text: 'להתקשר לאבא', date: { kind: 'relative_days', offset: 1 } },
        ctx,
      );
      expect(outcome.kind).toBe('clarify');
      if (outcome.kind !== 'clarify') return;
      expect(outcome.clarify.code).toBe('time');
    });

    it('passes a far-future reminder through, but marked for confirmation', () => {
      const outcome = remindersCreate.resolve(
        {
          text: 'חידוש דרכון',
          date: { kind: 'absolute', day: 24, month: 9, year: 2028 },
          time: { hour: 10, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
        },
        ctx,
      );
      expect(outcome).toMatchObject({ kind: 'ready', needsConfirm: true });
    });

    it('schedules it and echoes the day, date and time back', async () => {
      const outcome = remindersCreate.resolve({ text: 'להתקשר לאבא', ...AT_EIGHT_TOMORROW }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const result = await remindersCreate.execute(outcome.input, ctx);
      expect(plain(result.text)).toContain('יום ו׳ 25.9 · 08:00');
      expect(plain(result.text)).toContain('להתקשר לאבא');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('says the reminder will come through the calendar when the window will be shut', async () => {
      const outcome = remindersCreate.resolve(
        {
          text: 'תשלום ארנונה',
          date: { kind: 'relative_days', offset: 5 },
          time: { hour: 9, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
        },
        ctx,
      );
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const result = await remindersCreate.execute(outcome.input, ctx);
      expect(plain(result.text)).toContain('יומן');
    });

    it('routes to the calendar once the monthly message budget is gone', async () => {
      const outcome = remindersCreate.resolve({ text: 'בדיקה', ...AT_EIGHT_TOMORROW }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const result = await remindersCreate.execute(outcome.input, {
        ...ctx,
        monthlySent: FREE_MESSAGES_PER_MONTH,
      });
      expect(plain(result.text)).toContain('יומן');
    });

    it('offers an Undo that removes the reminder it just made', async () => {
      const outcome = remindersCreate.resolve({ text: 'בדיקה', ...AT_EIGHT_TOMORROW }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const created = await remindersCreate.execute(outcome.input, ctx);
      expect(created.compensating).toBeDefined();

      await remindersCreate.undo?.(created.compensating, ctx);
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('refuses to execute an input that does not match its schema', async () => {
      // What a tampered or stale stored row would look like after a confirmation.
      await expect(remindersCreate.execute({ text: 'x' }, ctx)).rejects.toThrow(ToolInputError);
      await expect(
        remindersCreate.execute({ text: 'x', dueAtUtc: -1, localWallTime: 'y', tz: 'Z' }, ctx),
      ).rejects.toThrow(ToolInputError);
    });

    it('asks for a time when the clock is in the small hours and the day is relative', () => {
      const afterMidnight = Date.parse('2026-09-24T23:30:00Z'); // 02:30 local
      const outcome = remindersCreate.resolve(
        { text: 'בדיקה', date: { kind: 'relative_days', offset: 1 }, time: AT_EIGHT_TOMORROW.time },
        { ...ctx, nowMs: afterMidnight },
      );
      expect(outcome.kind).toBe('clarify');
    });
  });

  // -- list -------------------------------------------------------------------

  describe('reminders.list', () => {
    const schedule = (text: string, iso: string) =>
      reminders.schedule({
        principal: PRINCIPAL,
        text,
        dueAtUtc: Date.parse(iso),
        localWallTime: 'x',
        tz: 'Asia/Jerusalem',
      });

    it('says so plainly when there is nothing scheduled', async () => {
      const outcome = remindersList.resolve({}, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');
      const result = await remindersList.execute(outcome.input, ctx);
      expect(result.text).toBe('אין תזכורות ממתינות.');
    });

    it('numbers them in time order with the day and time of each', async () => {
      schedule('שני', '2026-09-26T09:00:00Z');
      schedule('ראשון', '2026-09-25T05:00:00Z');

      const result = await remindersList.execute({}, ctx);
      const text = plain(result.text);
      expect(text.indexOf('ראשון')).toBeLessThan(text.indexOf('שני'));
      expect(text).toContain('1. יום ו׳ 25.9 · 08:00');
    });

    it('filters to the weekend when asked for it', async () => {
      schedule('בשבוע', '2026-09-24T12:00:00Z'); // Thursday
      schedule('בסופש', '2026-09-25T09:00:00Z'); // Friday

      const result = await remindersList.execute({ range: 'weekend' }, ctx);
      expect(plain(result.text)).toContain('בסופש');
      expect(plain(result.text)).not.toContain('בשבוע');
    });

    it('never lists a reminder that has already fired', async () => {
      schedule('אתמול', '2026-09-23T09:00:00Z');
      const result = await remindersList.execute({}, ctx);
      expect(result.text).toBe('אין תזכורות ממתינות.');
    });

    it('ignores an unreadable range rather than asking about it', () => {
      // A read changes nothing, so a bad range degrades to "everything".
      expect(remindersList.resolve({ range: 'fortnight' }, ctx)).toEqual({
        kind: 'ready',
        input: {},
      });
    });
  });

  // -- cancel -----------------------------------------------------------------

  describe('reminders.cancel', () => {
    const schedule = (text: string, iso: string) =>
      reminders.schedule({
        principal: PRINCIPAL,
        text,
        dueAtUtc: Date.parse(iso),
        localWallTime: 'x',
        tz: 'Asia/Jerusalem',
      });

    it('says there is nothing to cancel when nothing is scheduled', () => {
      expect(remindersCancel.resolve({ query_variants: ['אבא'] }, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'nothing_scheduled' },
      });
    });

    it('finds the one reminder a description refers to', () => {
      const wanted = schedule('להתקשר לאבא', '2026-09-25T05:00:00Z');
      schedule('לקנות חלב', '2026-09-26T05:00:00Z');

      const outcome = remindersCancel.resolve({ query_variants: ['אבא'] }, ctx);
      expect(outcome).toMatchObject({ kind: 'ready' });
      if (outcome.kind !== 'ready') return;
      expect((outcome.input as { reminderId: string }).reminderId).toBe(wanted.id);
    });

    it('asks which one when the description matches several', () => {
      schedule('להתקשר לאבא בבוקר', '2026-09-25T05:00:00Z');
      schedule('להתקשר לאבא בערב', '2026-09-25T15:00:00Z');

      const outcome = remindersCancel.resolve({ query_variants: ['אבא'] }, ctx);
      expect(outcome.kind).toBe('clarify');
      if (outcome.kind !== 'clarify' || outcome.clarify.code !== 'ambiguous') {
        throw new Error('expected ambiguous');
      }
      expect(outcome.clarify.choices).toHaveLength(2);
      expect(outcome.clarify.choices[0]?.label).toContain('25.9');
    });

    it('says nothing matched rather than cancelling something near enough', () => {
      schedule('לקנות חלב', '2026-09-25T05:00:00Z');
      expect(remindersCancel.resolve({ query_variants: ['רופא שיניים'] }, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'not_found' },
      });
    });

    it('takes the only pending reminder when no description was given', () => {
      const only = schedule('לקנות חלב', '2026-09-25T05:00:00Z');
      const outcome = remindersCancel.resolve({}, ctx);
      expect(outcome).toMatchObject({ kind: 'ready' });
      if (outcome.kind !== 'ready') return;
      expect((outcome.input as { reminderId: string }).reminderId).toBe(only.id);
    });

    it('asks which one when there are several and no description', () => {
      schedule('א', '2026-09-25T05:00:00Z');
      schedule('ב', '2026-09-26T05:00:00Z');
      expect(remindersCancel.resolve({}, ctx)).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'target' },
      });
    });

    it('previews exactly what will be cancelled', () => {
      const target = schedule('להתקשר לאבא', '2026-09-25T05:00:00Z');
      const outcome = remindersCancel.resolve({ query_variants: ['אבא'] }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const preview = plain(remindersCancel.preview(outcome.input, 'he'));
      expect(preview).toContain('להתקשר לאבא');
      expect(preview).toContain('יום ו׳ 25.9 · 08:00');
      expect(target.id).toBeDefined();
    });

    it('cancels the stored target, and says so', async () => {
      schedule('להתקשר לאבא', '2026-09-25T05:00:00Z');
      const outcome = remindersCancel.resolve({ query_variants: ['אבא'] }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const result = await remindersCancel.execute(outcome.input, ctx);
      expect(result.text).toBe('התזכורת בוטלה.');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it('reports honestly when the reminder went away between preview and tap', async () => {
      const target = schedule('להתקשר לאבא', '2026-09-25T05:00:00Z');
      const outcome = remindersCancel.resolve({ query_variants: ['אבא'] }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      reminders.cancel(target.id, PRINCIPAL); // fired or cancelled elsewhere
      const result = await remindersCancel.execute(outcome.input, ctx);
      expect(result.text).not.toBe('התזכורת בוטלה.');
    });

    it('cannot cancel another principal’s reminder', async () => {
      const mine = schedule('שלי', '2026-09-25T05:00:00Z');
      const result = await remindersCancel.execute(
        { reminderId: mine.id, text: 'שלי', dueAtUtc: Date.parse('2026-09-25T05:00:00Z'), tz: 'Asia/Jerusalem' },
        { ...ctx, principal: 'p_someone_else' },
      );
      expect(result.text).not.toBe('התזכורת בוטלה.');
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });
  });
});

describe('matchReminders', () => {
  const reminder = (text: string): Reminder => ({
    id: text,
    principal: 'p',
    text,
    dueAtUtc: 0,
    localWallTime: '',
    tz: 'Asia/Jerusalem',
    status: 'scheduled',
    attempts: 0,
  });

  const ids = (texts: string[], variants: string[]) =>
    matchReminders(texts.map(reminder), variants).map((r) => r.id);

  it('matches a fragment of the reminder', () => {
    expect(ids(['להתקשר לאבא', 'לקנות חלב'], ['אבא'])).toEqual(['להתקשר לאבא']);
  });

  it('matches when the user says more than the reminder does', () => {
    expect(ids(['לאבא'], ['להתקשר לאבא בערב'])).toEqual(['לאבא']);
  });

  it('folds final letters, so a suffix does not break the match', () => {
    // ם and מ are the same letter in different positions.
    expect(ids(['להתקשר לאמא'], ['אמ'])).toEqual(['להתקשר לאמא']);
    expect(ids(['לשלם חשבון'], ['לשלם'])).toEqual(['לשלם חשבון']);
  });

  it('ignores nikud, which the user will not type', () => {
    expect(ids(['לְהִתְקַשֵּׁר לְאַבָּא'], ['להתקשר'])).toHaveLength(1);
  });

  it('matches English case-insensitively', () => {
    expect(ids(['Call the dentist'], ['DENTIST'])).toEqual(['Call the dentist']);
  });

  it('returns everything that matches, never a best guess', () => {
    expect(ids(['אבא בבוקר', 'אבא בערב'], ['אבא'])).toHaveLength(2);
  });

  it('returns nothing for an empty or whitespace-only description', () => {
    expect(ids(['משהו'], [''])).toEqual([]);
    expect(ids(['משהו'], ['   '])).toEqual([]);
  });
});

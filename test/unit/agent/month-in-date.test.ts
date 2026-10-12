/**
 * A whole month sent inside `date` (2026-10-12).
 *
 * gpt-oss-120b sent "מה היה לי ביומן במרץ 2024" as `date: {month: 3, year:
 * 2024}`, and strict Zod rejected it. The shape is unambiguous: no `kind`, no
 * day, a month. Code moves it to the `month`/`year` slots before strict Zod,
 * for `calendar.list_events` only, and never over a slot that was sent.
 */
import { describe, expect, it } from 'vitest';
import { liftMonthFromDate } from '../../../src/agent/tools.js';
import { validateIntentDraft } from '../../../src/nlu/intent-schema.js';

const valid = (tool: string, slots: unknown) =>
  validateIntentDraft({ intent: tool, slots, language: 'he', missing: [], ambiguities: [] }).ok;

describe('liftMonthFromDate', () => {
  it('moves a month and year out of date, and the call then validates', () => {
    const out = liftMonthFromDate('calendar.list_events', { date: { month: 3, year: 2024 } });
    expect(out).toEqual({ month: 3, year: 2024 });
    expect(valid('calendar.list_events', out)).toBe(true);
  });

  it('moves a month without a year', () => {
    expect(liftMonthFromDate('calendar.list_events', { date: { month: 3 } })).toEqual({ month: 3 });
  });

  it('leaves a real DateSpec alone', () => {
    const args = { date: { kind: 'absolute', day: 3, month: 5, year: 2024 } };
    expect(liftMonthFromDate('calendar.list_events', args)).toBe(args);
  });

  it('leaves a date with a day, or any other key, alone: strict Zod decides', () => {
    for (const date of [{ day: 3, month: 5 }, { month: 3, year: 2024, note: 'x' }, { year: 2024 }, { month: '3' }]) {
      const args = { date };
      expect(liftMonthFromDate('calendar.list_events', args)).toBe(args);
    }
  });

  it('never overwrites a month or year that was sent', () => {
    const args = { date: { month: 3, year: 2024 }, month: 4 };
    expect(liftMonthFromDate('calendar.list_events', args)).toBe(args);
  });

  it('is for calendar.list_events only', () => {
    const args = { text: 'x', date: { month: 3, year: 2024 } };
    expect(liftMonthFromDate('reminders.create', args)).toBe(args);
  });

  it('never mutates its input', () => {
    const args = { date: { month: 3, year: 2024 } };
    liftMonthFromDate('calendar.list_events', args);
    expect(args).toEqual({ date: { month: 3, year: 2024 } });
  });
});

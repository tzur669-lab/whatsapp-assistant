/**
 * The weekday a message names against the weekday its draft names (PLAN §6.2).
 *
 * The model is a parser, and a parser can miscount: qwen v5 read "ביום שני" as
 * Tuesday. The words are in code's hands too, so where they name a day and the
 * draft names another, the draft's day is not used.
 */
import { describe, expect, it } from 'vitest';
import { checkNamedWeekdays } from '../../../src/nlu/weekday-check.js';
import type { IntentDraft } from '../../../src/nlu/intent-schema.js';

const onWeekday = (weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6) =>
  ({ kind: 'weekday', weekday, qualifier: 'unspecified' }) as const;

const EIGHT = { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } as const;

function reminder(date: unknown): IntentDraft {
  return {
    intent: 'reminders.create',
    language: 'he',
    slots: { text: 'להתקשר לאבא', date, time: EIGHT },
    missing: [],
    ambiguities: [],
  } as IntentDraft;
}

function repeating(weekdays: number[]): IntentDraft {
  return {
    intent: 'reminders.repeat',
    language: 'he',
    slots: { text: 'לשים זבל', time: EIGHT, weekdays },
    missing: [],
    ambiguities: [],
  } as IntentDraft;
}

describe('checkNamedWeekdays on a recurring reminder (B6)', () => {
  it('passes days the message named', () => {
    const draft = repeating([0, 2]);
    expect(checkNamedWeekdays(draft, 'כל יום ראשון ושלישי ב-8 תזכיר לי לשים זבל').mismatched).toEqual([]);
  });

  it('reads a list with commas and a closing ו', () => {
    const draft = repeating([1, 3, 4]);
    expect(checkNamedWeekdays(draft, 'בימי שני, רביעי וחמישי ב-8 תזכיר לי').mismatched).toEqual([]);
  });

  it('drops the list when any day in it was not named', () => {
    // Counting Sunday as 1, the classic slip.
    const result = checkNamedWeekdays(repeating([1]), 'כל יום ראשון ב-8 תזכיר לי לשים זבל');
    expect(result.mismatched).toEqual(['weekdays']);
    expect(result.draft.slots).toEqual({ text: 'לשים זבל', time: EIGHT });
  });

  it('leaves it alone when the message names no day', () => {
    expect(checkNamedWeekdays(repeating([0, 1, 2, 3, 4]), 'בימי חול ב-8 תזכיר לי').mismatched).toEqual([]);
  });
});

describe('checkNamedWeekdays', () => {
  it('flags a weekday the message did not name, and drops it', () => {
    const result = checkNamedWeekdays(reminder(onWeekday(2)), 'תזכיר לי ביום שני ב-8');
    expect(result.mismatched).toEqual(['date']);
    expect(result.draft.slots).toEqual({ text: 'להתקשר לאבא', time: EIGHT });
  });

  it('passes a weekday the message named', () => {
    const draft = reminder(onWeekday(1));
    const result = checkNamedWeekdays(draft, 'תזכיר לי ביום שני ב-8');
    expect(result.mismatched).toEqual([]);
    expect(result.draft).toBe(draft);
  });

  it('has nothing to check against when the message names no day', () => {
    expect(checkNamedWeekdays(reminder(onWeekday(2)), 'תזכיר לי ב-8').mismatched).toEqual([]);
  });

  it('leaves a date that is not a weekday alone', () => {
    const tomorrow = reminder({ kind: 'relative_days', offset: 1 });
    expect(checkNamedWeekdays(tomorrow, 'מחר, יום שני, ב-8').mismatched).toEqual([]);
  });

  it('checks each date slot of a move on its own', () => {
    const move = {
      intent: 'calendar.move_event',
      language: 'he',
      slots: { query_variants: ['פגישה'], from_date: onWeekday(1), to_date: onWeekday(3) },
      missing: [],
      ambiguities: [],
    } as IntentDraft;
    const result = checkNamedWeekdays(move, 'תזיז את הפגישה מיום שני לשלישי');
    expect(result.mismatched).toEqual(['to_date']);
    expect(result.draft.slots).toEqual({ query_variants: ['פגישה'], from_date: onWeekday(1) });
  });

  it('reads English days for an English message', () => {
    const draft = { ...reminder(onWeekday(3)), language: 'en' } as IntentDraft;
    expect(checkNamedWeekdays(draft, 'remind me Tuesday at 8').mismatched).toEqual(['date']);
  });

  it('does not touch an unsupported draft', () => {
    const draft = {
      intent: 'unsupported',
      language: 'he',
      slots: { date: onWeekday(2) },
      missing: [],
      ambiguities: [],
    } as IntentDraft;
    expect(checkNamedWeekdays(draft, 'מה מזג האוויר ביום שני').mismatched).toEqual([]);
  });

  it('does not mutate the draft it was given', () => {
    const draft = reminder(onWeekday(2));
    const before = JSON.stringify(draft);
    checkNamedWeekdays(draft, 'ביום שני');
    expect(JSON.stringify(draft)).toBe(before);
  });
});

/**
 * PLAN §11.1 lexicon cases. The lexicon must either be right or return
 * nothing — a half-parse that reaches the resolver is the failure mode this
 * guards against.
 */
import { describe, expect, it } from 'vitest';
import { normalizeHebrew, parseHebrewWhen } from '../../../src/time/hebrew-lexicon.js';

describe('normalizeHebrew', () => {
  it('strips nikud', () => {
    expect(normalizeHebrew('שָׁלוֹם')).toBe('שלום');
  });

  it('unifies geresh, gershayim and maqaf', () => {
    expect(normalizeHebrew('יום ו׳')).toBe("יום ו'");
    expect(normalizeHebrew('אחה״צ')).toBe('אחה"צ');
    expect(normalizeHebrew('ב־8')).toBe('ב-8');
  });

  it('collapses whitespace', () => {
    expect(normalizeHebrew('  מחר   ב-8  ')).toBe('מחר ב-8');
  });
});

describe('relative days', () => {
  it('reads מחר', () => {
    expect(parseHebrewWhen('תזכיר לי מחר ב-8').date).toEqual({ kind: 'relative_days', offset: 1 });
  });

  it('reads מחרתיים and does not confuse it with מחר', () => {
    expect(parseHebrewWhen('מחרתיים ב-10').date).toEqual({ kind: 'relative_days', offset: 2 });
  });

  it('reads היום', () => {
    expect(parseHebrewWhen('היום ב-18:00').date).toEqual({ kind: 'relative_days', offset: 0 });
  });

  it('reads הערב as today', () => {
    expect(parseHebrewWhen('הערב ב-9').date).toEqual({ kind: 'relative_days', offset: 0 });
  });
});

describe('weekdays, including attached prefixes', () => {
  it('reads "יום ראשון"', () => {
    expect(parseHebrewWhen('יום ראשון ב-9').date).toMatchObject({ kind: 'weekday', weekday: 0 });
  });

  it('reads it with the ב prefix attached', () => {
    expect(parseHebrewWhen('ביום שלישי ב-9').date).toMatchObject({ kind: 'weekday', weekday: 2 });
  });

  it('reads שבת', () => {
    expect(parseHebrewWhen('בשבת ב-11').date).toMatchObject({ kind: 'weekday', weekday: 6 });
  });

  it('marks הבא as the next qualifier', () => {
    expect(parseHebrewWhen('יום ראשון הבא ב-9').date).toMatchObject({
      kind: 'weekday',
      weekday: 0,
      qualifier: 'next',
    });
  });
});

describe('numeric dates, day first', () => {
  it('reads 25.9', () => {
    expect(parseHebrewWhen('ב-25.9 בשעה 14:00').date).toEqual({ kind: 'absolute', day: 25, month: 9 });
  });

  it('reads 25/9/2026 with a four-digit year', () => {
    expect(parseHebrewWhen('25/9/2026 ב-14:00').date).toEqual({
      kind: 'absolute',
      day: 25,
      month: 9,
      year: 2026,
    });
  });

  it('expands a two-digit year', () => {
    expect(parseHebrewWhen('25.9.26 ב-14:00').date).toMatchObject({ year: 2026 });
  });
});

describe('clock times', () => {
  it('reads HH:MM', () => {
    expect(parseHebrewWhen('מחר ב-14:30')).toMatchObject({ time: { hour: 14, minute: 30 } });
  });

  it('reads a bare hour behind the ב prefix', () => {
    expect(parseHebrewWhen('מחר ב-8')).toMatchObject({ time: { hour: 8, minute: 0 } });
  });

  it('reads בשעה', () => {
    expect(parseHebrewWhen('מחר בשעה 20')).toMatchObject({ time: { hour: 20, minute: 0 } });
  });

  it('reads an hour written as a word', () => {
    expect(parseHebrewWhen('מחר בשמונה')).toMatchObject({ time: { hour: 8, minute: 0 } });
  });

  it('reads שמונה וחצי as 08:30', () => {
    expect(parseHebrewWhen('מחר בשמונה וחצי')).toMatchObject({ time: { hour: 8, minute: 30 } });
  });

  it('reads שמונה ורבע as 08:15', () => {
    expect(parseHebrewWhen('מחר בשמונה ורבע')).toMatchObject({ time: { hour: 8, minute: 15 } });
  });

  it('reads רבע לתשע as 08:45 — the hour before the one named', () => {
    expect(parseHebrewWhen('מחר רבע לתשע')).toMatchObject({ time: { hour: 8, minute: 45 } });
  });

  it('reads עשרה לשמונה as 07:50', () => {
    expect(parseHebrewWhen('מחר 10 לשמונה')).toMatchObject({ time: { hour: 7, minute: 50 } });
  });

  it('wraps רבע לאחת back to noon, not to -1', () => {
    expect(parseHebrewWhen('מחר רבע לאחת')).toMatchObject({ time: { hour: 0, minute: 45 } });
  });
});

describe('parts of day', () => {
  it('reads בערב', () => {
    expect(parseHebrewWhen('מחר ב-8 בערב')).toMatchObject({
      time: { hour: 8, part_of_day: 'evening' },
    });
  });

  it('reads בבוקר', () => {
    expect(parseHebrewWhen('מחר ב-8 בבוקר')).toMatchObject({
      time: { hour: 8, part_of_day: 'morning' },
    });
  });

  it('reads בלילה', () => {
    expect(parseHebrewWhen('מחר ב-2 בלילה')).toMatchObject({
      time: { hour: 2, part_of_day: 'night' },
    });
  });

  it('reads אחר הצהריים', () => {
    expect(parseHebrewWhen('מחר ב-4 אחר הצהריים')).toMatchObject({
      time: { part_of_day: 'afternoon' },
    });
  });

  it('reads the אחה"צ abbreviation in either geresh form', () => {
    expect(parseHebrewWhen('מחר ב-4 אחה״צ')).toMatchObject({ time: { part_of_day: 'afternoon' } });
    expect(parseHebrewWhen('מחר ב-4 אחה"צ')).toMatchObject({ time: { part_of_day: 'afternoon' } });
  });
});

describe('durations', () => {
  it('reads בעוד שעתיים as the dual form, not as 2', () => {
    expect(parseHebrewWhen('תזכיר לי בעוד שעתיים').date).toEqual({
      kind: 'in_duration',
      minutes: 120,
    });
  });

  it('reads בעוד חצי שעה', () => {
    expect(parseHebrewWhen('בעוד חצי שעה').date).toEqual({ kind: 'in_duration', minutes: 30 });
  });

  it('reads בעוד רבע שעה', () => {
    expect(parseHebrewWhen('בעוד רבע שעה').date).toEqual({ kind: 'in_duration', minutes: 15 });
  });

  it('reads a numeric count of minutes', () => {
    expect(parseHebrewWhen('בעוד 20 דקות').date).toEqual({ kind: 'in_duration', minutes: 20 });
  });

  it('reads a written count of hours', () => {
    expect(parseHebrewWhen('בעוד שלוש שעות').date).toEqual({ kind: 'in_duration', minutes: 180 });
  });

  it('reads בעוד יומיים', () => {
    expect(parseHebrewWhen('בעוד יומיים').date).toEqual({ kind: 'in_duration', minutes: 2880 });
  });

  it('takes precedence over any clock reading in the same sentence', () => {
    expect(parseHebrewWhen('בעוד שעתיים')).toEqual({ date: { kind: 'in_duration', minutes: 120 } });
  });
});

describe('returns nothing rather than guessing', () => {
  it('yields no time when none was stated', () => {
    expect(parseHebrewWhen('תזכיר לי מחר להתקשר לאבא').time).toBeUndefined();
  });

  it('yields nothing at all for a sentence with no time expression', () => {
    expect(parseHebrewWhen('מה שלומך')).toEqual({});
  });

  it('does not read a phone number as a date or a time', () => {
    const res = parseHebrewWhen('תתקשר למספר 0500000000');
    expect(res.date).toBeUndefined();
    expect(res.time).toBeUndefined();
  });

  it('does not invent a time from a bare "בעוד" with no unit', () => {
    expect(parseHebrewWhen('נדבר בעוד').date).toBeUndefined();
  });
});

describe('end-to-end phrasing from the brief', () => {
  it('reads "תזכיר לי מחר ב-8 להתקשר לאבא"', () => {
    expect(parseHebrewWhen('תזכיר לי מחר ב-8 להתקשר לאבא')).toMatchObject({
      date: { kind: 'relative_days', offset: 1 },
      time: { hour: 8, minute: 0 },
    });
  });

  it('reads "תקבע פגישה עם יוסי מחר ב-14:00"', () => {
    expect(parseHebrewWhen('תקבע פגישה עם יוסי מחר ב-14:00')).toMatchObject({
      date: { kind: 'relative_days', offset: 1 },
      time: { hour: 14, minute: 0 },
    });
  });
});

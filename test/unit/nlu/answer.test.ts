/**
 * Reading a clarification answer (PLAN §6.11, §11.1).
 *
 * The rule under test is that context changes what counts as an answer. A bare
 * "8" inside a request is a number in a sentence and reading it as an hour
 * would be a guess; as the reply to "באיזו שעה?" it is the hour and nothing
 * else. These cases pin both halves of that — what is now accepted, and what is
 * still refused because accepting it would mean defaulting something nobody
 * said (R11).
 */
import { describe, expect, it } from 'vitest';
import { applyAnswer, canAnswer, parseAnswer } from '../../../src/nlu/answer.js';

const TOMORROW = { kind: 'relative_days', offset: 1 } as const;

describe('a time answer', () => {
  it('reads a bare hour, which only a question makes unambiguous', () => {
    const out = parseAnswer('time', '8');
    expect(out).toEqual({
      kind: 'filled',
      patch: { time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
    });
  });

  it.each([
    ['20:30', 20, 30],
    ['8:05', 8, 5],
    ['ב-9', 9, 0],
    ['בשעה 14', 14, 0],
    ['בשמונה', 8, 0],
    ['שמונה וחצי', 8, 30],
    ['רבע ל-9', 8, 45],
  ])('reads %s as %i:%i', (text, hour, minute) => {
    const out = parseAnswer('time', text);
    expect(out.kind).toBe('filled');
    if (out.kind !== 'filled') return;
    expect(out.patch.time?.hour).toBe(hour);
    expect(out.patch.time?.minute).toBe(minute);
  });

  it('keeps the part of day, so 8 in the evening is not 8 in the morning', () => {
    const out = parseAnswer('time', '8 בערב');
    expect(out.kind).toBe('filled');
    if (out.kind !== 'filled') return;
    expect(out.patch.time).toEqual({
      hour: 8,
      minute: 0,
      meridiem: 'unspecified',
      part_of_day: 'evening',
    });
  });

  it('reads an English answer with its meridiem', () => {
    const out = parseAnswer('time', '8 pm');
    expect(out.kind).toBe('filled');
    if (out.kind !== 'filled') return;
    expect(out.patch.time?.meridiem).toBe('pm');
  });

  it('asks again for a part of day alone, which names no hour (R11)', () => {
    expect(parseAnswer('time', 'בערב').kind).toBe('incomplete');
    expect(parseAnswer('time', 'בבוקר').kind).toBe('incomplete');
    expect(parseAnswer('time', 'in the evening').kind).toBe('incomplete');
  });

  it('accepts a duration, because "בעוד שעה" does name a moment (R1)', () => {
    const out = parseAnswer('time', 'בעוד שעה');
    expect(out).toEqual({ kind: 'filled', patch: { date: { kind: 'in_duration', minutes: 60 } } });
  });

  it('refuses a number buried in prose, where it is not the answer', () => {
    expect(parseAnswer('time', 'אני לא בטוח אולי נדבר על זה בפעם הבאה ב 3 מילים').kind).toBe(
      'not_an_answer',
    );
  });

  it('refuses an hour that is not one', () => {
    expect(parseAnswer('time', '99').kind).toBe('not_an_answer');
  });
});

describe('a date answer', () => {
  it.each([
    ['מחר', { kind: 'relative_days', offset: 1 }],
    ['מחרתיים', { kind: 'relative_days', offset: 2 }],
    ['היום', { kind: 'relative_days', offset: 0 }],
    ['ביום ראשון', { kind: 'weekday', weekday: 0, qualifier: 'unspecified' }],
    ['25.9', { kind: 'absolute', day: 25, month: 9 }],
    ['tomorrow', { kind: 'relative_days', offset: 1 }],
    ['monday', { kind: 'weekday', weekday: 1, qualifier: 'unspecified' }],
  ])('reads %s', (text, expected) => {
    expect(parseAnswer('date', text)).toEqual({ kind: 'filled', patch: { date: expected } });
  });

  it('does not invent a day out of something that names none', () => {
    expect(parseAnswer('date', 'כשאני אגיע הביתה').kind).toBe('not_an_answer');
  });
});

describe('a "when" answer', () => {
  it('takes a day and an hour together', () => {
    const out = parseAnswer('when', 'מחר ב-9');
    expect(out.kind).toBe('filled');
    if (out.kind !== 'filled') return;
    expect(out.patch.date).toEqual(TOMORROW);
    expect(out.patch.time?.hour).toBe(9);
  });

  it('takes either one on its own', () => {
    expect(parseAnswer('when', 'מחר').kind).toBe('filled');
    expect(parseAnswer('when', '9').kind).toBe('filled');
  });
});

describe('a duration answer', () => {
  it.each([
    ['שעה', 60],
    ['חצי שעה', 30],
    ['שעתיים', 120],
    ['שעה וחצי', 90],
    ['45 דקות', 45],
    ['2 שעות', 120],
    ['30', 30],
    ['half an hour', 30],
    ['90 minutes', 90],
  ])('reads %s as %i minutes', (text, minutes) => {
    expect(parseAnswer('duration', text)).toEqual({
      kind: 'filled',
      patch: { durationMinutes: minutes },
    });
  });

  it('asks again for a number that could be either minutes or hours', () => {
    // "2" is far more likely to mean two hours than two minutes, and there is
    // no way to tell — so it is asked again rather than resolved either way.
    expect(parseAnswer('duration', '2').kind).toBe('incomplete');
  });
});

describe('a phrase answer', () => {
  it('takes the whole message as the reminder body', () => {
    expect(parseAnswer('text', 'להתקשר לאבא')).toEqual({
      kind: 'filled',
      patch: { text: 'להתקשר לאבא' },
    });
  });

  it('takes it as the event title when that is what was asked', () => {
    expect(parseAnswer('title', 'פגישה עם יוסי')).toEqual({
      kind: 'filled',
      patch: { title: 'פגישה עם יוסי' },
    });
  });

  it('takes it as a description to match against, when a target was asked', () => {
    expect(parseAnswer('target', 'הפגישה עם רואה החשבון')).toEqual({
      kind: 'filled',
      patch: { target: ['הפגישה עם רואה החשבון'] },
    });
  });

  it('asks again rather than storing a single character', () => {
    expect(parseAnswer('text', 'א').kind).toBe('incomplete');
  });
});

describe('what is not an answer at all', () => {
  it('reads a request of its own as a request, whatever was asked', () => {
    // Otherwise a user who changes their mind mid-question has their new
    // request mined for slots it was never meant to fill.
    expect(parseAnswer('time', 'תזכיר לי מחר לקנות חלב').kind).toBe('not_an_answer');
    expect(parseAnswer('text', 'מה יש לי ביומן').kind).toBe('not_an_answer');
  });

  it('ends the exchange on a refusal', () => {
    for (const word of ['לא', 'בטל', 'ביטול', 'cancel', 'no']) {
      expect(parseAnswer('time', word).kind, word).toBe('cancelled');
    }
  });

  it('does not read a sentence that merely starts with "לא" as a refusal', () => {
    expect(parseAnswer('time', 'לא בטוח, אולי 8').kind).not.toBe('cancelled');
  });

  it('refuses an empty message', () => {
    expect(parseAnswer('time', '   ').kind).toBe('not_an_answer');
  });
});

describe('applying an answer to a tool', () => {
  it('puts the hour where the tool that asked keeps it', () => {
    expect(
      applyAnswer('reminders.create', { text: 'א' }, { time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } }),
    ).toEqual({ text: 'א', time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } });
  });

  it('knows a move keeps its new time under a different name', () => {
    const merged = applyAnswer(
      'calendar.move_event',
      { query_variants: ['סטנדאפ'] },
      { time: { hour: 9, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
    );
    expect(merged).toHaveProperty('to_time');
    expect(merged).not.toHaveProperty('time');
  });

  it('lets the answer win, because it is the later statement', () => {
    expect(applyAnswer('reminders.create', { text: 'ישן' }, { text: 'חדש' })).toEqual({
      text: 'חדש',
    });
  });

  it('drops an hour that a duration answer has made meaningless (R1)', () => {
    const merged = applyAnswer(
      'reminders.create',
      { text: 'א', time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
      { date: { kind: 'in_duration', minutes: 60 } },
    );
    expect(merged).not.toHaveProperty('time');
    expect(merged).toHaveProperty('date');
  });

  it('refuses a patch the tool has nowhere to put', () => {
    expect(applyAnswer('reminders.list', {}, { text: 'א' })).toBeNull();
    expect(applyAnswer('reminders.create', {}, { durationMinutes: 30 })).toBeNull();
  });
});

describe('which questions a tool can be asked', () => {
  it('knows a reminder has no duration and a list has no body', () => {
    expect(canAnswer('reminders.create', 'time')).toBe(true);
    expect(canAnswer('reminders.create', 'duration')).toBe(false);
    expect(canAnswer('calendar.create_event', 'duration')).toBe(true);
    expect(canAnswer('reminders.list', 'time')).toBe(false);
  });

  it('opens no question for a tool nobody has mapped', () => {
    // A tool added later without thinking about clarification holds no
    // question, which is the right default.
    expect(canAnswer('some.future_tool', 'time')).toBe(false);
  });
});

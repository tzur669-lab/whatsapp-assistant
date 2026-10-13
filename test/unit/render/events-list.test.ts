import { describe, expect, it } from 'vitest';
import { eventText } from '../../../src/render/events.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { CalendarEvent } from '../../../src/google/calendar.js';

// 2026-10-13 is a Tuesday; Israel is UTC+3 until 2026-10-25.
const NOW = Date.UTC(2026, 9, 13, 5, 0); // 08:00 local
const at = (day: number, hour: number) => Date.UTC(2026, 9, day, hour - 3, 0);

function event(title: string, start: number, end: number, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  return { id: `id-${title}`, title, startUtc: start, endUtc: end, allDay: false, ...extra } as CalendarEvent;
}

const plain = (text: string) => stripIsolates(text).replace(/\u200F/g, '');

describe('eventText.list', () => {
  it('groups by day, time first, with today and tomorrow', () => {
    const text = eventText.list(
      [
        event('Team sync', at(14, 12), at(14, 13), { calendarName: 'Work' }),
        event('פגישה', at(13, 9), at(13, 10)),
        event('רופא שיניים', at(13, 14), at(13, 15)),
        event('יום הולדת', Date.UTC(2026, 9, 13, 21), Date.UTC(2026, 9, 14, 21), { allDay: true }),
      ],
      'he',
      NOW,
    );
    expect(plain(text)).toBe(
      [
        'ביומן:',
        '',
        'היום · יום ג׳ 13.10',
        '09:00–10:00 · פגישה',
        '14:00–15:00 · רופא שיניים',
        '',
        'מחר · יום ד׳ 14.10',
        'כל היום · יום הולדת',
        '12:00–13:00 · Team sync (Work)',
      ].join('\n'),
    );
  });

  it('keeps every Hebrew event line right-to-left', () => {
    const text = eventText.list([event('Gym', at(13, 7), at(13, 8))], 'he', NOW);
    expect(text.split('\n')[3]?.startsWith('\u200F')).toBe(true);
  });

  it('names a day further away by weekday and date only', () => {
    const text = eventText.list([event('א', at(16, 10), at(16, 11))], 'he', NOW);
    expect(plain(text).split('\n')[2]).toBe('יום ו׳ 16.10');
  });

  it('shows a multi-day all-day event with its last day', () => {
    const text = eventText.list(
      [event('חופשה', Date.UTC(2026, 9, 14, 21), Date.UTC(2026, 9, 17, 21), { allDay: true })],
      'he',
      NOW,
    );
    expect(plain(text).split('\n')[3]).toBe('כל היום, עד שבת 17.10 · חופשה');
  });

  it('shows an event that ends on another day with its end', () => {
    const text = eventText.list([event('טיסה', at(13, 22), at(14, 6))], 'he', NOW);
    expect(plain(text).split('\n')[3]).toBe('22:00 עד יום ד׳ 14.10 · 06:00 · טיסה');
  });

  it('works without a clock and in English', () => {
    const text = eventText.list([event('Lunch', at(13, 12), at(13, 13))], 'en');
    expect(plain(text)).toBe(['On your calendar:', '', 'Tue 13 Oct', '12:00–13:00 · Lunch'].join('\n'));
  });
});

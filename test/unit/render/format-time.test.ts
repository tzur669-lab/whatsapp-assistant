import { describe, expect, it } from 'vitest';
import { formatWhen, formatDuration, formatRange } from '../../../src/render/format-time.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { ZONE, localPartsOf } from '../../../src/time/tz.js';

const at = (iso: string) => Date.parse(iso);
const parts = (iso: string) => localPartsOf(at(iso), ZONE);

describe('formatWhen', () => {
  it('renders weekday, date and time in Hebrew', () => {
    // Friday 25.9.2026 14:00 Jerusalem.
    expect(stripIsolates(formatWhen(parts('2026-09-25T11:00:00Z'), 'he'))).toBe('יום ו׳ 25.9 · 14:00');
  });

  it('renders Saturday with its own name, not a letter', () => {
    expect(stripIsolates(formatWhen(parts('2026-09-26T11:00:00Z'), 'he'))).toBe('שבת 26.9 · 14:00');
  });

  it('renders English', () => {
    expect(stripIsolates(formatWhen(parts('2026-09-25T11:00:00Z'), 'en'))).toBe('Fri 25 Sep · 14:00');
  });

  it('pads the minute but not the day or month', () => {
    expect(stripIsolates(formatWhen(parts('2026-01-03T06:05:00Z'), 'he'))).toBe('שבת 3.1 · 08:05');
  });

  it('uses the 24-hour clock past noon', () => {
    expect(stripIsolates(formatWhen(parts('2026-09-25T20:30:00Z'), 'he'))).toContain('23:30');
  });

  it('bidi-isolates the date and time so they cannot be reordered', () => {
    const out = formatWhen(parts('2026-09-25T11:00:00Z'), 'he');
    expect(out).not.toBe(stripIsolates(out));
    expect(out).toContain('⁦'); // LRI around the numeric runs
  });
});

describe('formatDuration — Hebrew one/two/other', () => {
  it('uses the singular', () => {
    expect(stripIsolates(formatDuration(1, 'hour', 'he'))).toBe('שעה');
    expect(stripIsolates(formatDuration(1, 'day', 'he'))).toBe('יום');
    expect(stripIsolates(formatDuration(1, 'minute', 'he'))).toBe('דקה');
  });

  it('uses the dual form, which is a separate word and not "2 X"', () => {
    expect(stripIsolates(formatDuration(2, 'hour', 'he'))).toBe('שעתיים');
    expect(stripIsolates(formatDuration(2, 'day', 'he'))).toBe('יומיים');
    expect(stripIsolates(formatDuration(2, 'minute', 'he'))).toBe('שתי דקות');
  });

  it('uses the plural with the number', () => {
    expect(stripIsolates(formatDuration(3, 'hour', 'he'))).toBe('3 שעות');
    expect(stripIsolates(formatDuration(10, 'day', 'he'))).toBe('10 ימים');
    expect(stripIsolates(formatDuration(45, 'minute', 'he'))).toBe('45 דקות');
  });

  it('treats round numbers as plural, not a separate category', () => {
    // CLDR removed Hebrew "many" in v42; 20 and 100 resolve to "other".
    expect(stripIsolates(formatDuration(20, 'hour', 'he'))).toBe('20 שעות');
    expect(stripIsolates(formatDuration(100, 'day', 'he'))).toBe('100 ימים');
  });

  it('renders English', () => {
    expect(stripIsolates(formatDuration(1, 'hour', 'en'))).toBe('1 hour');
    expect(stripIsolates(formatDuration(2, 'hour', 'en'))).toBe('2 hours');
  });
});

describe('formatRange', () => {
  it('keeps a same-day range on one date', () => {
    const out = stripIsolates(
      formatRange(parts('2026-09-25T11:00:00Z'), parts('2026-09-25T12:00:00Z'), 'he'),
    );
    expect(out).toBe('יום ו׳ 25.9 · 14:00-15:00');
  });

  it('spells out both ends when the range crosses midnight', () => {
    const out = stripIsolates(
      formatRange(parts('2026-09-25T20:00:00Z'), parts('2026-09-25T22:00:00Z'), 'he'),
    );
    expect(out).toBe('יום ו׳ 25.9 · 23:00 – שבת 26.9 · 01:00');
  });

  it('isolates the range so it does not flip in an RTL paragraph', () => {
    const out = formatRange(parts('2026-09-25T11:00:00Z'), parts('2026-09-25T12:00:00Z'), 'he');
    expect(out).toContain('⁦');
    expect(stripIsolates(out)).toContain('14:00-15:00');
  });
});

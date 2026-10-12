/**
 * Calendar read windows, past and future (2026-10-12). Test-first: `src/time/`.
 *
 * A read may look back as far as asked: "yesterday", "last week", "March
 * 2024". Every boundary is local midnight, resolved through the zone.
 */
import { describe, expect, it } from 'vitest';
import { daysAgoWindow, dayWindowOf, monthWindow, resolveReadSpan, yearWindow } from '../../../src/time/range.js';
import { localPartsOf, ZONE } from '../../../src/time/tz.js';

/** Monday 2026-10-12, 12:00 in Jerusalem (still summer time, +03:00). */
const NOW = Date.parse('2026-10-12T09:00:00Z');

const day = (utc: number) => {
  const p = localPartsOf(utc, ZONE);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${String(p.minute).padStart(2, '0')}`;
};
const span = (w: { startUtc: number; endUtc: number } | null) => (w ? [day(w.startUtc), day(w.endUtc)] : null);

describe('daysAgoWindow', () => {
  it('reads yesterday as the whole of yesterday', () => {
    expect(span(daysAgoWindow(1, NOW))).toEqual(['11.10.2026 0:00', '12.10.2026 0:00']);
  });

  it('has no limit on how far back', () => {
    expect(span(daysAgoWindow(3650, NOW))).toEqual(['14.10.2016 0:00', '15.10.2016 0:00']);
  });

  it('keeps a DST day whole: Sunday 25.10 is 25 hours long', () => {
    const after = Date.parse('2026-10-27T09:00:00Z');
    const w = daysAgoWindow(2, after)!;
    expect(span(w)).toEqual(['25.10.2026 0:00', '26.10.2026 0:00']);
    expect(w.endUtc - w.startUtc).toBe(25 * 60 * 60 * 1000);
  });
});

describe('dayWindowOf', () => {
  it('takes a date with a year as it is, in the past too', () => {
    expect(span(dayWindowOf(3, 5, 2024, NOW))).toEqual(['3.5.2024 0:00', '4.5.2024 0:00']);
  });

  it('reads a date without a year as the nearest one: a past spring', () => {
    expect(span(dayWindowOf(3, 5, undefined, NOW))).toEqual(['3.5.2026 0:00', '4.5.2026 0:00']);
  });

  it('reads a date without a year as the nearest one: a coming December', () => {
    expect(span(dayWindowOf(20, 12, undefined, NOW))).toEqual(['20.12.2026 0:00', '21.12.2026 0:00']);
  });

  it('crosses the year when that is nearer', () => {
    const lateDecember = Date.parse('2026-12-28T10:00:00Z');
    expect(span(dayWindowOf(5, 1, undefined, lateDecember))).toEqual(['5.1.2027 0:00', '6.1.2027 0:00']);
  });

  it('refuses a day that does not exist', () => {
    expect(dayWindowOf(31, 2, 2025, NOW)).toBeNull();
    expect(dayWindowOf(30, 2, undefined, NOW)).toBeNull();
  });
});

describe('monthWindow', () => {
  it('covers a whole month of a given year', () => {
    expect(span(monthWindow(3, 2024, NOW))).toEqual(['1.3.2024 0:00', '1.4.2024 0:00']);
  });

  it('reads a month without a year as the nearest: June is this year, behind', () => {
    expect(span(monthWindow(6, undefined, NOW))).toEqual(['1.6.2026 0:00', '1.7.2026 0:00']);
  });

  it('reads a month without a year as the nearest: January is next year', () => {
    expect(span(monthWindow(1, undefined, NOW))).toEqual(['1.1.2027 0:00', '1.2.2027 0:00']);
  });

  it('breaks a tie toward the past', () => {
    // April: six months back, six ahead.
    expect(span(monthWindow(4, undefined, NOW))).toEqual(['1.4.2026 0:00', '1.5.2026 0:00']);
  });

  it('ends December at the next new year', () => {
    expect(span(monthWindow(12, 2025, NOW))).toEqual(['1.12.2025 0:00', '1.1.2026 0:00']);
  });
});

describe('yearWindow', () => {
  it('covers a whole year', () => {
    expect(span(yearWindow(2023))).toEqual(['1.1.2023 0:00', '1.1.2024 0:00']);
  });
});

describe('resolveReadSpan', () => {
  it('last_week is the Sunday-to-Saturday week before this one', () => {
    expect(span(resolveReadSpan('last_week', NOW))).toEqual(['4.10.2026 0:00', '11.10.2026 0:00']);
  });

  it('this_month is the whole month, the days behind included', () => {
    expect(span(resolveReadSpan('this_month', NOW))).toEqual(['1.10.2026 0:00', '1.11.2026 0:00']);
  });

  it('last_month and next_month', () => {
    expect(span(resolveReadSpan('last_month', NOW))).toEqual(['1.9.2026 0:00', '1.10.2026 0:00']);
    expect(span(resolveReadSpan('next_month', NOW))).toEqual(['1.11.2026 0:00', '1.12.2026 0:00']);
  });

  it('crosses a year boundary', () => {
    const january = Date.parse('2027-01-10T10:00:00Z');
    expect(span(resolveReadSpan('last_month', january))).toEqual(['1.12.2026 0:00', '1.1.2027 0:00']);
  });
});

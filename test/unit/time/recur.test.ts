/**
 * Recurring reminders: the next occurrence (PLAN §6.7, B6).
 *
 * "Every day at 08:00" means the wall clock, so each occurrence is found
 * through the zone and never by adding 24 hours. The DST cases are the point:
 * Israel falls back on 2026-10-25 (02:00 → 01:00) and springs forward on
 * 2027-03-26 (02:00 → 03:00).
 */
import { describe, expect, it } from 'vitest';
import { firstOccurrence, nextOccurrence } from '../../../src/time/recur.js';
import type { RecurRule } from '../../../src/time/recur.js';

const ZONE = 'Asia/Jerusalem';

/** An instant from a local ISO string with an explicit offset. */
const at = (iso: string): number => Date.parse(iso);

const local = (ms: number | null): string =>
  ms === null
    ? 'none'
    : new Intl.DateTimeFormat('sv-SE', {
        timeZone: ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date(ms));

const daily = (hour: number, minute = 0): RecurRule => ({ freq: 'daily', hour, minute });

describe('nextOccurrence', () => {
  it('daily: later today when the time has not passed', () => {
    expect(local(nextOccurrence(daily(8), at('2026-10-05T07:00:00+03:00'), ZONE))).toBe('2026-10-05 08:00');
  });

  it('daily: tomorrow when the time has passed, and strictly after', () => {
    expect(local(nextOccurrence(daily(8), at('2026-10-05T09:00:00+03:00'), ZONE))).toBe('2026-10-06 08:00');
    expect(local(nextOccurrence(daily(8), at('2026-10-05T08:00:00+03:00'), ZONE))).toBe('2026-10-06 08:00');
  });

  it('daily: keeps the wall clock across the fall-back (not +24h)', () => {
    // 2026-10-24 08:00 is +03:00; 2026-10-25 08:00 is +02:00, 25 hours later.
    const first = at('2026-10-24T08:00:00+03:00');
    const next = nextOccurrence(daily(8), first, ZONE);
    expect(local(next)).toBe('2026-10-25 08:00');
    expect(next! - first).toBe(25 * 3_600_000);
  });

  it('daily: keeps the wall clock across the spring-forward', () => {
    const first = at('2027-03-25T08:00:00+02:00');
    const next = nextOccurrence(daily(8), first, ZONE);
    expect(local(next)).toBe('2027-03-26 08:00');
    expect(next! - first).toBe(23 * 3_600_000);
  });

  it('a later occurrence inside the fold takes the earlier instant', () => {
    const next = nextOccurrence(daily(1, 30), at('2026-10-24T02:00:00+03:00'), ZONE);
    expect(next).toBe(at('2026-10-25T01:30:00+03:00'));
  });

  it('a later occurrence inside the gap moves an hour on', () => {
    const next = nextOccurrence(daily(2, 30), at('2027-03-25T03:00:00+02:00'), ZONE);
    expect(local(next)).toBe('2027-03-26 03:30');
  });

  it('weekly: the nearest listed weekday (0 = Sunday)', () => {
    // Monday 2026-10-05. Sunday and Wednesday at 20:00.
    const rule: RecurRule = { freq: 'weekly', hour: 20, minute: 0, weekdays: [0, 3] };
    expect(local(nextOccurrence(rule, at('2026-10-05T10:00:00+03:00'), ZONE))).toBe('2026-10-07 20:00');
    expect(local(nextOccurrence(rule, at('2026-10-07T21:00:00+03:00'), ZONE))).toBe('2026-10-11 20:00');
  });

  it('weekly: the same weekday later today, or next week', () => {
    const rule: RecurRule = { freq: 'weekly', hour: 8, minute: 0, weekdays: [1] };
    expect(local(nextOccurrence(rule, at('2026-10-05T07:00:00+03:00'), ZONE))).toBe('2026-10-05 08:00');
    expect(local(nextOccurrence(rule, at('2026-10-05T08:30:00+03:00'), ZONE))).toBe('2026-10-12 08:00');
  });

  it('monthly: the stated day of the month', () => {
    const rule: RecurRule = { freq: 'monthly', hour: 9, minute: 0, day: 10 };
    expect(local(nextOccurrence(rule, at('2026-10-05T10:00:00+03:00'), ZONE))).toBe('2026-10-10 09:00');
    expect(local(nextOccurrence(rule, at('2026-10-10T10:00:00+03:00'), ZONE))).toBe('2026-11-10 09:00');
  });

  it('monthly: day 31 falls on the last day of a shorter month', () => {
    const rule: RecurRule = { freq: 'monthly', hour: 9, minute: 0, day: 31 };
    expect(local(nextOccurrence(rule, at('2026-10-31T10:00:00+02:00'), ZONE))).toBe('2026-11-30 09:00');
    expect(local(nextOccurrence(rule, at('2027-01-31T10:00:00+02:00'), ZONE))).toBe('2027-02-28 09:00');
  });

  it('a rule that can never match yields null', () => {
    expect(nextOccurrence({ freq: 'weekly', hour: 8, minute: 0, weekdays: [] }, at('2026-10-05T07:00:00+03:00'), ZONE)).toBeNull();
  });
});

describe('firstOccurrence', () => {
  it('reports a fold rather than choosing a side', () => {
    expect(firstOccurrence(daily(1, 30), at('2026-10-25T00:30:00+03:00'), ZONE).kind).toBe('fold');
  });

  it('reports a gap rather than moving the time', () => {
    expect(firstOccurrence(daily(2, 30), at('2027-03-26T00:30:00+02:00'), ZONE).kind).toBe('gap');
  });

  it('asks now about a later occurrence that will land in the fold', () => {
    // First one is tomorrow night and fine; 2026-10-25 01:30 happens twice.
    expect(firstOccurrence(daily(1, 30), at('2026-10-05T10:00:00+03:00'), ZONE).kind).toBe('fold');
    // A weekly rule that never meets the transition day is fine.
    const mondays: RecurRule = { freq: 'weekly', hour: 1, minute: 30, weekdays: [1] };
    expect(firstOccurrence(mondays, at('2026-10-05T10:00:00+03:00'), ZONE).kind).toBe('ok');
  });

  it('otherwise agrees with nextOccurrence', () => {
    const now = at('2026-10-05T10:00:00+03:00');
    const first = firstOccurrence(daily(8), now, ZONE);
    expect(first).toEqual({ kind: 'ok', utcMs: nextOccurrence(daily(8), now, ZONE) });
  });
});

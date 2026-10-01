/**
 * Week ranges (PLAN §6.3). Test-first per CLAUDE.md — this is `src/time/`.
 *
 * The Israeli week (Sunday–Saturday) and the Israeli weekend (Friday–Saturday)
 * are the whole point. Read as Monday–Sunday, every Sunday reminder lands in the
 * wrong week.
 */
import { describe, expect, it } from 'vitest';
import { resolveRange, daysBetween } from '../../../src/time/range.js';
import { localPartsOf, ZONE } from '../../../src/time/tz.js';

/** 2026-09-24 is a Thursday (weekday 4) in Jerusalem. */
const THURSDAY_NOON = Date.parse('2026-09-24T09:00:00Z');

const parts = (utc: number) => localPartsOf(utc, ZONE);

const describeInstant = (utc: number) => {
  const p = parts(utc);
  return `${p.weekday}/${p.day}.${p.month} ${p.hour}:${String(p.minute).padStart(2, '0')}`;
};

describe('this_week', () => {
  it('starts now, not at midnight, so fired reminders are not listed again', () => {
    expect(resolveRange('this_week', THURSDAY_NOON).startUtc).toBe(THURSDAY_NOON);
  });

  it('ends at midnight after Saturday', () => {
    const { endUtc } = resolveRange('this_week', THURSDAY_NOON);
    const end = parts(endUtc);
    // Midnight opening Sunday 27.9.
    expect([end.weekday, end.day, end.hour]).toEqual([0, 27, 0]);
  });

  it('on a Saturday still covers the rest of that Saturday', () => {
    const saturday = Date.parse('2026-09-26T09:00:00Z');
    expect(parts(saturday).weekday).toBe(6);
    const { startUtc, endUtc } = resolveRange('this_week', saturday);
    expect(endUtc).toBeGreaterThan(startUtc);
    expect(parts(endUtc).day).toBe(27);
  });

  it('on a Sunday covers the whole week ahead', () => {
    const sunday = Date.parse('2026-09-27T09:00:00Z');
    expect(parts(sunday).weekday).toBe(0);
    const { endUtc } = resolveRange('this_week', sunday);
    expect(parts(endUtc).day).toBe(4); // midnight opening Sunday 4.10
  });
});

describe('a whole range, for the calendar', () => {
  it('starts this_week at midnight opening Sunday, so earlier meetings are listed', () => {
    const { startUtc, endUtc } = resolveRange('this_week', THURSDAY_NOON, ZONE, { fromStart: true });
    const start = parts(startUtc);
    expect([start.weekday, start.day, start.hour, start.minute]).toEqual([0, 20, 0, 0]);
    expect(endUtc).toBe(resolveRange('this_week', THURSDAY_NOON).endUtc);
  });

  it('starts the weekend at midnight opening Friday, even on Saturday', () => {
    const saturday = Date.parse('2026-09-26T09:00:00Z');
    const start = parts(resolveRange('weekend', saturday, ZONE, { fromStart: true }).startUtc);
    expect([start.weekday, start.day, start.hour]).toEqual([5, 25, 0]);
  });

  it('leaves next_week as it is', () => {
    expect(resolveRange('next_week', THURSDAY_NOON, ZONE, { fromStart: true })).toEqual(
      resolveRange('next_week', THURSDAY_NOON),
    );
  });
});

describe('next_week', () => {
  it('runs Sunday to Saturday of the following week', () => {
    const { startUtc, endUtc } = resolveRange('next_week', THURSDAY_NOON);
    expect(describeInstant(startUtc)).toBe('0/27.9 0:00');
    expect(describeInstant(endUtc)).toBe('0/4.10 0:00');
  });

  it('is exactly seven days long', () => {
    const { startUtc, endUtc } = resolveRange('next_week', THURSDAY_NOON);
    expect((endUtc - startUtc) / (24 * 60 * 60 * 1000)).toBe(7);
  });

  it('never overlaps this week', () => {
    const thisWeek = resolveRange('this_week', THURSDAY_NOON);
    const nextWeek = resolveRange('next_week', THURSDAY_NOON);
    expect(nextWeek.startUtc).toBe(thisWeek.endUtc);
  });

  it('asked on a Saturday, means the week that starts tomorrow', () => {
    const saturday = Date.parse('2026-09-26T09:00:00Z');
    expect(describeInstant(resolveRange('next_week', saturday).startUtc)).toBe('0/27.9 0:00');
  });
});

describe('weekend', () => {
  it('is Friday and Saturday, not Saturday and Sunday', () => {
    const { startUtc, endUtc } = resolveRange('weekend', THURSDAY_NOON);
    expect(describeInstant(startUtc)).toBe('5/25.9 0:00');
    expect(describeInstant(endUtc)).toBe('0/27.9 0:00');
  });

  it('asked on a Friday, means today — not next week', () => {
    const friday = Date.parse('2026-09-25T09:00:00Z');
    expect(parts(friday).weekday).toBe(5);
    const { startUtc, endUtc } = resolveRange('weekend', friday);
    expect(startUtc).toBe(friday); // clamped to now, mid-Friday
    expect(describeInstant(endUtc)).toBe('0/27.9 0:00');
  });

  it('asked on a Saturday, means today — the weekend that is happening', () => {
    const saturday = Date.parse('2026-09-26T09:00:00Z');
    const { startUtc, endUtc } = resolveRange('weekend', saturday);
    expect(startUtc).toBe(saturday);
    expect(describeInstant(endUtc)).toBe('0/27.9 0:00');
  });

  it('never starts in the past', () => {
    for (const day of ['21', '22', '23', '24', '25', '26', '27']) {
      const now = Date.parse(`2026-09-${day}T09:00:00Z`);
      expect(resolveRange('weekend', now).startUtc).toBeGreaterThanOrEqual(now);
    }
  });
});

describe('across a DST change', () => {
  // Israel falls back 2026-10-25 02:00 -> 01:00 (a Sunday).
  const beforeFallBack = Date.parse('2026-10-22T09:00:00Z'); // Thursday

  it('keeps a week seven calendar days long, not 7x24 hours', () => {
    const { startUtc, endUtc } = resolveRange('next_week', beforeFallBack);
    const hours = (endUtc - startUtc) / (60 * 60 * 1000);
    // The week containing the fall-back has an extra hour in it.
    expect(hours).toBe(169);
    expect(describeInstant(startUtc)).toBe('0/25.10 0:00');
    expect(describeInstant(endUtc)).toBe('0/1.11 0:00');
  });

  it('still lands both boundaries on local midnight', () => {
    const { startUtc, endUtc } = resolveRange('next_week', beforeFallBack);
    expect(parts(startUtc).hour).toBe(0);
    expect(parts(endUtc).hour).toBe(0);
  });
});

describe('daysBetween', () => {
  it('counts calendar days, not elapsed hours', () => {
    const late = Date.parse('2026-09-24T20:00:00Z'); // 23:00 local
    const early = Date.parse('2026-09-25T04:00:00Z'); // 07:00 local next day
    expect(daysBetween(late, early)).toBe(1);
  });

  it('is zero within one local day', () => {
    expect(daysBetween(THURSDAY_NOON, THURSDAY_NOON + 60_000)).toBe(0);
  });

  it('stays whole across the fall-back', () => {
    const before = Date.parse('2026-10-24T09:00:00Z');
    const after = Date.parse('2026-10-26T09:00:00Z');
    expect(daysBetween(before, after)).toBe(2);
  });
});

/**
 * Past days, for expenses (ROADMAP #10, 2026-10-05).
 *
 * The scheduling resolver looks forward: "Sunday" is the coming one and a date
 * without a year is the next such date. A spending happened, so here every
 * reading looks back, and a day still to come is a question, never a guess.
 */
import { describe, expect, it } from 'vitest';
import { expensePeriodDays, resolvePastDay } from '../../../src/time/past-day.js';

const TZ = 'Asia/Jerusalem';
/** Monday 2026-10-05, 10:00 local. */
const MONDAY = Date.parse('2026-10-05T07:00:00Z');
/** Monday 2026-10-05, 00:30 local — still Sunday in UTC. */
const JUST_AFTER_MIDNIGHT = Date.parse('2026-10-04T21:30:00Z');

describe('resolvePastDay', () => {
  it('today and yesterday', () => {
    expect(resolvePastDay({ kind: 'days_ago', days: 0 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2026-10-05' });
    expect(resolvePastDay({ kind: 'days_ago', days: 1 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2026-10-04' });
  });

  it('reads the local day, not the UTC one', () => {
    expect(resolvePastDay({ kind: 'days_ago', days: 0 }, JUST_AFTER_MIDNIGHT, TZ)).toEqual({ kind: 'ok', iso: '2026-10-05' });
  });

  it('a weekday is the latest such day, today included', () => {
    expect(resolvePastDay({ kind: 'weekday', weekday: 1 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2026-10-05' });
    expect(resolvePastDay({ kind: 'weekday', weekday: 0 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2026-10-04' });
    expect(resolvePastDay({ kind: 'weekday', weekday: 2 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2026-09-29' });
  });

  it('a date without a year is the latest past one, across New Year', () => {
    expect(resolvePastDay({ kind: 'absolute', day: 1, month: 10 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2026-10-01' });
    expect(resolvePastDay({ kind: 'absolute', day: 20, month: 12 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2025-12-20' });
    expect(resolvePastDay({ kind: 'absolute', day: 5, month: 10 }, MONDAY, TZ)).toEqual({ kind: 'ok', iso: '2026-10-05' });
  });

  it('29 February without a year goes back to the last leap year it fits, within a year or asks', () => {
    // 2026-02-29 does not exist and 2024-02-29 is more than a year back.
    expect(resolvePastDay({ kind: 'absolute', day: 29, month: 2 }, MONDAY, TZ)).toEqual({ kind: 'clarify', reason: 'invalid_date' });
  });

  it('asks about a day that does not exist', () => {
    expect(resolvePastDay({ kind: 'absolute', day: 31, month: 9, year: 2026 }, MONDAY, TZ)).toEqual({
      kind: 'clarify',
      reason: 'invalid_date',
    });
  });

  it('asks about a day still to come, never moves it back a year when the year was said', () => {
    expect(resolvePastDay({ kind: 'absolute', day: 6, month: 10, year: 2026 }, MONDAY, TZ)).toEqual({
      kind: 'clarify',
      reason: 'future',
    });
  });

  it('asks about a day more than a year back', () => {
    expect(resolvePastDay({ kind: 'days_ago', days: 366 }, MONDAY, TZ)).toEqual({ kind: 'clarify', reason: 'too_old' });
    expect(resolvePastDay({ kind: 'absolute', day: 1, month: 1, year: 2025 }, MONDAY, TZ)).toEqual({
      kind: 'clarify',
      reason: 'too_old',
    });
  });
});

describe('expensePeriodDays', () => {
  it('today', () => {
    expect(expensePeriodDays('today', MONDAY, TZ)).toEqual({ from: '2026-10-05', to: '2026-10-05' });
  });

  it('weeks run Sunday to Saturday', () => {
    expect(expensePeriodDays('this_week', MONDAY, TZ)).toEqual({ from: '2026-10-04', to: '2026-10-05' });
    expect(expensePeriodDays('last_week', MONDAY, TZ)).toEqual({ from: '2026-09-27', to: '2026-10-03' });
  });

  it('months, including the one before across a year', () => {
    expect(expensePeriodDays('this_month', MONDAY, TZ)).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(expensePeriodDays('last_month', MONDAY, TZ)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    const january = Date.parse('2027-01-10T10:00:00Z');
    expect(expensePeriodDays('last_month', january, TZ)).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });

  it('the year so far, and everything', () => {
    expect(expensePeriodDays('this_year', MONDAY, TZ)).toEqual({ from: '2026-01-01', to: '2026-10-05' });
    expect(expensePeriodDays('all', MONDAY, TZ)).toEqual({ from: '0000-01-01', to: '2026-10-05' });
  });
});

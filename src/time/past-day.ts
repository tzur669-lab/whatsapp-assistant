/**
 * Past days, for expenses (ROADMAP #10, 2026-10-05).
 *
 * `resolve.ts` looks forward, because everything it schedules is still to come:
 * "Sunday" is the coming Sunday and "20.12" the next 20 December. A spending
 * has already happened, so here each reading looks back — the latest such day,
 * today included — and a day that has not come yet is a question, never moved.
 *
 * Days only, as `YYYY-MM-DD` in the local calendar: an expense is on a day, and
 * a day needs no instant, so no clock change can move it.
 */
import { isRealDate, localPartsOf } from './tz.js';

export type SpentDateSpec =
  | { kind: 'days_ago'; days: number }
  | { kind: 'weekday'; weekday: number }
  | { kind: 'absolute'; day: number; month: number; year?: number | undefined };

export type PastDay =
  | { kind: 'ok'; iso: string }
  | { kind: 'clarify'; reason: 'future' | 'too_old' | 'invalid_date' };

/** Further back than this is more likely a misheard year than a spending. */
export const MAX_DAYS_BACK = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolvePastDay(spec: SpentDateSpec, nowMs: number, zone: string): PastDay {
  const today = todayOf(nowMs, zone);

  switch (spec.kind) {
    case 'days_ago':
      return withinReach(today - spec.days * DAY_MS, today);
    case 'weekday': {
      const back = (new Date(today).getUTCDay() - spec.weekday + 7) % 7;
      return withinReach(today - back * DAY_MS, today);
    }
    case 'absolute': {
      if (spec.year !== undefined) {
        if (!isRealDate(spec.year, spec.month, spec.day)) return { kind: 'clarify', reason: 'invalid_date' };
        return withinReach(Date.UTC(spec.year, spec.month - 1, spec.day), today);
      }
      // No year: this year's, or last year's when this year's is still ahead.
      const year = new Date(today).getUTCFullYear();
      for (const candidate of [year, year - 1]) {
        if (!isRealDate(candidate, spec.month, spec.day)) continue;
        const at = Date.UTC(candidate, spec.month - 1, spec.day);
        if (at <= today) return withinReach(at, today);
      }
      return { kind: 'clarify', reason: 'invalid_date' };
    }
  }
}

export type ExpensePeriod = 'today' | 'this_week' | 'last_week' | 'this_month' | 'last_month' | 'this_year' | 'all';

/**
 * The local days a period covers, both ends included. Weeks run Sunday to
 * Saturday, as the Israeli week does; "this" periods end today.
 */
export function expensePeriodDays(period: ExpensePeriod, nowMs: number, zone: string): { from: string; to: string } {
  const today = todayOf(nowMs, zone);
  const date = new Date(today);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const sunday = today - date.getUTCDay() * DAY_MS;

  switch (period) {
    case 'today':
      return { from: iso(today), to: iso(today) };
    case 'this_week':
      return { from: iso(sunday), to: iso(today) };
    case 'last_week':
      return { from: iso(sunday - 7 * DAY_MS), to: iso(sunday - DAY_MS) };
    case 'this_month':
      return { from: iso(Date.UTC(year, month, 1)), to: iso(today) };
    case 'last_month':
      return { from: iso(Date.UTC(year, month - 1, 1)), to: iso(Date.UTC(year, month, 1) - DAY_MS) };
    case 'this_year':
      return { from: iso(Date.UTC(year, 0, 1)), to: iso(today) };
    case 'all':
      return { from: '0000-01-01', to: iso(today) };
  }
}

/** Today in the zone, as midnight UTC of that calendar date. */
function todayOf(nowMs: number, zone: string): number {
  const local = localPartsOf(nowMs, zone);
  return Date.UTC(local.year, local.month - 1, local.day);
}

function withinReach(at: number, today: number): PastDay {
  if (at > today) return { kind: 'clarify', reason: 'future' };
  if (today - at > MAX_DAYS_BACK * DAY_MS) return { kind: 'clarify', reason: 'too_old' };
  return { kind: 'ok', iso: iso(at) };
}

function iso(utcMidnight: number): string {
  return new Date(utcMidnight).toISOString().slice(0, 10);
}

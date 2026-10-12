/**
 * Multi-day ranges (PLAN §6.3, §6.4).
 *
 * The LLM emits `this_week` / `next_week` / `weekend` and code turns them into
 * instants — the same division as everywhere else: the model says what was said,
 * code decides what it means.
 *
 * Two things here are Israeli rather than generic, and both are load-bearing:
 * the week runs **Sunday to Saturday**, and the weekend is **Friday and
 * Saturday**. Reading "this week" as Monday-to-Sunday would put Sunday's
 * reminders in the wrong week every single time.
 *
 * Boundaries are midnight local, resolved through the zone rather than computed
 * in UTC, so a range that spans a DST change is still exactly seven days long.
 */
import { ZONE, addDays, isRealDate, localPartsOf, wallTimeToUtc } from './tz.js';
import type { WallTime } from './tz.js';

export type RangeName = 'this_week' | 'next_week' | 'weekend';

export type ResolvedRange = {
  /**
   * Inclusive. Never earlier than `nowMs`, so a list never looks backwards —
   * unless `fromStart` asked for the whole range.
   */
  startUtc: number;
  /** Exclusive: midnight at the start of the day after the range. */
  endUtc: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const FRIDAY = 5;
const SATURDAY = 6;

export type RangeOptions = {
  /**
   * Start at the range's first midnight rather than now. A calendar asked about
   * "this week" means the meetings already behind too; a reminder list does not
   * want the ones that already fired.
   */
  fromStart?: boolean;
};

export function resolveRange(
  range: RangeName,
  nowMs: number,
  zone: string = ZONE,
  options: RangeOptions = {},
): ResolvedRange {
  const now = localPartsOf(nowMs, zone);
  const today: WallTime = { ...now, hour: 0, minute: 0 };
  const fromStart = options.fromStart === true;

  switch (range) {
    case 'this_week': {
      // From now to the end of Saturday. Starting at midnight would list
      // reminders that have already fired.
      const endsAfter = SATURDAY - now.weekday;
      return {
        startUtc: fromStart ? midnightUtc(addDays(today, -now.weekday), zone) : nowMs,
        endUtc: midnightUtc(addDays(today, endsAfter + 1), zone),
      };
    }

    case 'next_week': {
      const nextSunday = addDays(today, 7 - now.weekday);
      return {
        startUtc: midnightUtc(nextSunday, zone),
        endUtc: midnightUtc(addDays(nextSunday, 7), zone),
      };
    }

    case 'weekend': {
      // Friday and Saturday. Asked on one of those two days it means this one,
      // not the next: "what's on this weekend" on a Friday is about today.
      const daysToFriday = now.weekday === SATURDAY ? -1 : FRIDAY - now.weekday;
      const friday = addDays(today, daysToFriday);
      const start = midnightUtc(friday, zone);
      return {
        startUtc: fromStart ? start : Math.max(start, nowMs),
        endUtc: midnightUtc(addDays(friday, 2), zone),
      };
    }
  }
}

/**
 * Midnight local, as an instant.
 *
 * Israel's DST transitions happen at 02:00, so local midnight always exists and
 * always happens once. The fallbacks are there so a zone where that is not true
 * degrades to an hour's error rather than to `NaN`.
 */
function midnightUtc(wall: WallTime, zone: string): number {
  const resolved = wallTimeToUtc({ ...wall, hour: 0, minute: 0 }, zone);
  if (resolved.kind === 'ok') return resolved.utcMs;
  if (resolved.kind === 'fold') return Math.min(...resolved.utcMsCandidates);
  // A gap at midnight: the day starts when the clock reaches 01:00.
  const oneAm = wallTimeToUtc({ ...wall, hour: 1, minute: 0 }, zone);
  return oneAm.kind === 'ok' ? oneAm.utcMs - 60 * 60 * 1000 : Date.UTC(wall.year, wall.month - 1, wall.day);
}

/** Whole days between two instants, for "in 3 days" style phrasing. */
export function daysBetween(fromUtc: number, toUtc: number, zone: string = ZONE): number {
  const from = localPartsOf(fromUtc, zone);
  const to = localPartsOf(toUtc, zone);
  const fromMidnight = midnightUtc({ ...from, hour: 0, minute: 0 }, zone);
  const toMidnight = midnightUtc({ ...to, hour: 0, minute: 0 }, zone);
  return Math.round((toMidnight - fromMidnight) / DAY_MS);
}

/**
 * The last instant of the local day containing `atMs` (PLAN §6.12).
 *
 * Resolved through the zone rather than by adding 24 hours, for the same reason
 * every boundary here is: on a DST day the local day is 23 or 25 hours long, and
 * a digest that stops an hour early on the last Sunday in October is a digest
 * that quietly drops an evening's events.
 */
export function endOfLocalDay(atMs: number, zone: string = ZONE): number {
  const local = localPartsOf(atMs, zone);
  const tomorrow = addDays({ ...local, hour: 0, minute: 0 }, 1);
  const midnight = wallTimeToUtc({ ...tomorrow, hour: 0, minute: 0 }, zone);

  if (midnight.kind === 'ok') return midnight.utcMs - 1;
  // A midnight that is ambiguous or missing is not something Israel's rules
  // produce, but the earliest candidate is the safe reading either way.
  if (midnight.kind === 'fold') return Math.min(...midnight.utcMsCandidates) - 1;
  return Date.UTC(tomorrow.year, tomorrow.month - 1, tomorrow.day) - 1;
}

// -- calendar reads, past and future (2026-10-12) ------------------------------
//
// A read may look back as far as asked. These never return an instant inside a
// day: every window is whole local days, midnight to midnight, so a DST day is
// 23 or 25 hours and still whole.

export type ReadSpan = 'last_week' | 'this_month' | 'last_month' | 'next_month';

const wall = (year: number, month: number, day: number): WallTime => ({ year, month, day, hour: 0, minute: 0 });

function daysWindow(first: WallTime, days: number, zone: string): ResolvedRange {
  return { startUtc: midnightUtc(first, zone), endUtc: midnightUtc(addDays(first, days), zone) };
}

function monthsWindow(year: number, month: number, zone: string): ResolvedRange {
  const next = month === 12 ? wall(year + 1, 1, 1) : wall(year, month + 1, 1);
  return { startUtc: midnightUtc(wall(year, month, 1), zone), endUtc: midnightUtc(next, zone) };
}

/** The whole local day `days` days before today. No limit on how far back. */
export function daysAgoWindow(days: number, nowMs: number, zone: string = ZONE): ResolvedRange {
  const now = localPartsOf(nowMs, zone);
  return daysWindow(addDays(wall(now.year, now.month, now.day), -days), 1, zone);
}

/**
 * One day. With a year, that day, behind or ahead. Without one, the nearest
 * such date — a tie goes to the past. Null when the date does not exist.
 */
export function dayWindowOf(
  day: number,
  month: number,
  year: number | undefined,
  nowMs: number,
  zone: string = ZONE,
): ResolvedRange | null {
  if (year !== undefined) return isRealDate(year, month, day) ? daysWindow(wall(year, month, day), 1, zone) : null;

  const now = localPartsOf(nowMs, zone);
  const today = Date.UTC(now.year, now.month - 1, now.day);
  let best: number | undefined;
  for (const candidate of [now.year - 1, now.year, now.year + 1]) {
    if (!isRealDate(candidate, month, day)) continue;
    const distance = Math.abs(Date.UTC(candidate, month - 1, day) - today);
    const bestDistance = best === undefined ? Infinity : Math.abs(Date.UTC(best, month - 1, day) - today);
    if (distance < bestDistance) best = candidate;
  }
  return best === undefined ? null : daysWindow(wall(best, month, day), 1, zone);
}

/** A whole month. Without a year, the nearest such month — a tie goes to the past. */
export function monthWindow(month: number, year: number | undefined, nowMs: number, zone: string = ZONE): ResolvedRange {
  if (year !== undefined) return monthsWindow(year, month, zone);
  const now = localPartsOf(nowMs, zone);
  const here = now.year * 12 + now.month;
  let best = now.year - 1;
  for (const candidate of [now.year, now.year + 1]) {
    if (Math.abs(candidate * 12 + month - here) < Math.abs(best * 12 + month - here)) best = candidate;
  }
  return monthsWindow(best, month, zone);
}

/** A whole year. */
export function yearWindow(year: number, zone: string = ZONE): ResolvedRange {
  return { startUtc: midnightUtc(wall(year, 1, 1), zone), endUtc: midnightUtc(wall(year + 1, 1, 1), zone) };
}

/** The spans only a read asks about. Weeks run Sunday to Saturday. */
export function resolveReadSpan(span: ReadSpan, nowMs: number, zone: string = ZONE): ResolvedRange {
  const now = localPartsOf(nowMs, zone);
  switch (span) {
    case 'last_week':
      return daysWindow(addDays(wall(now.year, now.month, now.day), -now.weekday - 7), 7, zone);
    case 'this_month':
      return monthsWindow(now.year, now.month, zone);
    case 'last_month':
      return now.month === 1 ? monthsWindow(now.year - 1, 12, zone) : monthsWindow(now.year, now.month - 1, zone);
    case 'next_month':
      return now.month === 12 ? monthsWindow(now.year + 1, 1, zone) : monthsWindow(now.year, now.month + 1, zone);
  }
}

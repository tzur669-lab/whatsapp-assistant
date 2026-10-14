/**
 * Habits, from timestamps and numbers only (block K, K2, PLAN §6.31).
 *
 * Pure: no store, no clock, no zone math beyond `localPartsOf`. Each function
 * abstains (null) rather than guess: a proposal the user did not earn is worse
 * than none. Nothing here ever fills a missing time (invariant 4); a result is
 * only ever offered on a button that calls the same setter as a command.
 */
import { addDays, localPartsOf, ZONE } from '../time/tz.js';

/** A "day" for first messages runs 04:00–04:00 local, so a 00:15 night owl stays one day. */
const DAY_SHIFT_MIN = 4 * 60;
const MIN_DAYS = 7;
const CONSISTENT_SHARE = 0.7;
const CONSISTENT_WINDOW_MIN = 60;
/** The proposed digest hour must fall here, as wall clock. Outside it: abstain, never clamp. */
const EARLIEST_DIGEST_MIN = 5 * 60;
const LATEST_DIGEST_MIN = 12 * 60 - 1;

/**
 * Each day's first message, as minutes since that day's 04:00 local (0–1439).
 * Wall clock, so a DST change moves the UTC offset and never the bucket.
 */
export function firstMessageMinutes(timestamps: readonly number[]): number[] {
  const byDay = new Map<string, number>();
  for (const ms of timestamps) {
    const local = localPartsOf(ms, ZONE);
    let minutes = local.hour * 60 + local.minute - DAY_SHIFT_MIN;
    let date = { year: local.year, month: local.month, day: local.day };
    if (minutes < 0) {
      minutes += 24 * 60;
      const before = addDays({ ...date, hour: 0, minute: 0 }, -1);
      date = { year: before.year, month: before.month, day: before.day };
    }
    const key = `${date.year}-${date.month}-${date.day}`;
    const seen = byDay.get(key);
    if (seen === undefined || minutes < seen) byDay.set(key, minutes);
  }
  return [...byDay.values()];
}

/** The lower middle: always one of the observations. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/**
 * The digest hour the first messages suggest, or null. At least 7 days, 70%
 * of them within an hour of the median, the median between 05:00 and 11:59
 * wall clock, and a different hour from the current one. Off digest → null.
 */
export function digestHourCandidate(timestamps: readonly number[], currentHour: number | null): number | null {
  if (currentHour === null) return null;
  const days = firstMessageMinutes(timestamps);
  if (days.length < MIN_DAYS) return null;
  const middle = median(days)!;
  const near = days.filter((minutes) => Math.abs(minutes - middle) <= CONSISTENT_WINDOW_MIN).length;
  if (near / days.length < CONSISTENT_SHARE) return null;
  const wall = (middle + DAY_SHIFT_MIN) % (24 * 60);
  if (wall < EARLIEST_DIGEST_MIN || wall > LATEST_DIGEST_MIN) return null;
  const hour = Math.floor(wall / 60);
  return hour === currentHour ? null : hour;
}

/** The travel time the user keeps saying, or null: 3 or more, and not today's default. */
export function leaveMinutesCandidate(
  stated: readonly number[],
  current: number,
  bounds: { min: number; max: number },
): number | null {
  if (stated.length < 3) return null;
  const middle = median(stated)!;
  if (middle < bounds.min || middle > bounds.max) return null;
  return middle === current ? null : middle;
}

/** Per 100 messages, one decimal; null for a week with no messages. */
export function ratePer100(count: number, messages: number): number | null {
  if (messages <= 0) return null;
  return Math.round((count / messages) * 1000) / 10;
}

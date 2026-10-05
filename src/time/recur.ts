/**
 * Recurring reminders: when the next one is due (PLAN §6.7, B6).
 *
 * A rule is a wall-clock time plus which days. "Every day at 08:00" means 08:00
 * on the clock, so every occurrence is found through the zone — adding 24 hours
 * would drift by an hour twice a year.
 *
 * Only one occurrence is ever stored. The store asks for the next one when the
 * current one is claimed, which keeps the work per alarm constant rather than
 * expanding a rule into a calendar (B6).
 *
 * DST (R2). A rule is asked about at creation if any occurrence in the next 400
 * days falls in a gap or a fold — the user is there to answer then, and not
 * when a later one comes due. Past that horizon, which a running rule does
 * reach, a skipped wall time is delivered an hour on and a repeated one once,
 * at the earlier instant. Only 00:00–02:59 is affected in Israel.
 */
import { addDays, localPartsOf, wallTimeToUtc } from './tz.js';
import type { WallTime } from './tz.js';

export type RecurRule = {
  freq: 'daily' | 'weekly' | 'monthly';
  hour: number;
  minute: number;
  /** Weekly: 0 = Sunday … 6 = Saturday. */
  weekdays?: number[] | undefined;
  /** Monthly: 1–31. Past the month's end it falls on the last day. */
  day?: number | undefined;
};

export type FirstOccurrence =
  | { kind: 'ok'; utcMs: number }
  | { kind: 'gap' }
  | { kind: 'fold' }
  | { kind: 'never' };

/** Far enough for any monthly rule; a weekly one matches within 7 days. */
const MAX_DAYS_AHEAD = 400;

/**
 * The first occurrence after `afterMs`, for creating a rule. A wall time in a
 * DST gap or fold is reported, never resolved (R2).
 */
export function firstOccurrence(rule: RecurRule, afterMs: number, zone: string): FirstOccurrence {
  let first: number | null = null;
  for (const wall of candidateDays(rule, afterMs, zone)) {
    const resolved = wallTimeToUtc(wall, zone);
    if (resolved.kind === 'gap') return { kind: 'gap' };
    if (resolved.kind === 'fold') {
      if (resolved.utcMsCandidates[1] <= afterMs) continue;
      return { kind: 'fold' };
    }
    if (resolved.utcMs <= afterMs) continue;
    first ??= resolved.utcMs;
    // A later occurrence cannot ask, so one that would land in a gap or a fold
    // is asked about now (R2). Israel changes its clocks at 02:00, so only a
    // small-hours rule needs the whole year walked.
    if (rule.hour >= DST_HOURS_END) break;
  }
  return first === null ? { kind: 'never' } : { kind: 'ok', utcMs: first };
}

/** Wall times from this hour on are never in a DST gap or fold in Israel. */
const DST_HOURS_END = 4;

/**
 * The first occurrence strictly after `afterMs`, for a rule already running.
 * Null only for a rule that can never match.
 */
export function nextOccurrence(rule: RecurRule, afterMs: number, zone: string): number | null {
  for (const wall of candidateDays(rule, afterMs, zone)) {
    const utcMs = deliverableInstant(wall, zone);
    if (utcMs !== null && utcMs > afterMs) return utcMs;
  }
  return null;
}

/**
 * A fold is delivered once, at the earlier instant: if that one has passed, the
 * day is over for this rule, even though the clock shows the time again.
 */
function deliverableInstant(wall: WallTime, zone: string): number | null {
  const resolved = wallTimeToUtc(wall, zone);
  if (resolved.kind === 'ok') return resolved.utcMs;
  if (resolved.kind === 'fold') return resolved.utcMsCandidates[0];

  const later = wallTimeToUtc({ ...wall, hour: wall.hour + 1 }, zone);
  return later.kind === 'ok' ? later.utcMs : null;
}

/** The rule's wall times, day by day, starting with the local day of `afterMs`. */
function* candidateDays(rule: RecurRule, afterMs: number, zone: string): Generator<WallTime> {
  const today = localPartsOf(afterMs, zone);
  const start: WallTime = { year: today.year, month: today.month, day: today.day, hour: 12, minute: 0 };

  for (let offset = 0; offset <= MAX_DAYS_AHEAD; offset++) {
    const day = addDays(start, offset);
    if (matches(rule, day)) yield { ...day, hour: rule.hour, minute: rule.minute };
  }
}

function matches(rule: RecurRule, day: WallTime): boolean {
  switch (rule.freq) {
    case 'daily':
      return true;
    case 'weekly': {
      const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
      return (rule.weekdays ?? []).includes(weekday);
    }
    case 'monthly': {
      const wanted = rule.day ?? 0;
      const lastDay = new Date(Date.UTC(day.year, day.month, 0)).getUTCDate();
      return day.day === Math.min(wanted, lastDay);
    }
  }
}

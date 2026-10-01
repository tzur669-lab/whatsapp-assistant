/**
 * Time resolution — the accuracy core (PLAN §6.3, rules R1–R12).
 *
 * The LLM never computes a date. It emits a `DateSpec` and a `TimeSpec`
 * describing what the user literally said, and this module turns that into a
 * UTC instant or a CLARIFY. Nothing here reads the clock: `nowMs` is supplied
 * by the caller so every rule is testable against a frozen time.
 *
 * The bias throughout is to refuse rather than guess. A wrong reminder time is
 * worse than one extra question.
 */
import { ZONE, addDays, isRealDate, localPartsOf, wallTimeToUtc } from './tz.js';
import type { LocalParts, WallTime } from './tz.js';

// -- Specs emitted by the LLM -------------------------------------------------

export type DateSpec =
  | { kind: 'relative_days'; offset: number } // today = 0, מחר = 1, מחרתיים = 2
  | { kind: 'weekday'; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; qualifier: 'this' | 'next' | 'unspecified' }
  // `year` is explicitly `| undefined`: under exactOptionalPropertyTypes that is
  // what a Zod `.optional()` produces, and the drift guard in
  // `src/nlu/slot-schemas.ts` holds the two shapes together.
  | { kind: 'absolute'; day: number; month: number; year?: number | undefined }
  | { kind: 'in_duration'; minutes: number }; // "בעוד שעתיים" — carries its own time

export type TimeSpec = {
  hour: number;
  minute: number;
  meridiem: 'am' | 'pm' | 'unspecified';
  part_of_day: 'morning' | 'noon' | 'afternoon' | 'evening' | 'night' | 'unspecified';
};

export type WhenDraft = {
  date?: DateSpec | undefined;
  time?: TimeSpec | undefined;
};

// -- Settings -----------------------------------------------------------------

export type TimeSettings = {
  /** R5. Off means a bare hour is always read literally on the 24-hour clock. */
  unlikelyHourGuard: boolean;
  /** R5 window, inclusive start and exclusive end, in local hours. */
  unlikelyHourStart: number;
  unlikelyHourEnd: number;
  /** R6 window: a relative date stated before this local hour is ambiguous. */
  smallHoursUntil: number;
  /** R9. False (default) means "יום ראשון הבא" is the nearest future Sunday. */
  nextWeekdayMeansFollowingWeek: boolean;
  /** R8 horizon, in days. Beyond it a write needs confirmation. */
  confirmHorizonDays: number;
  /** R10. A yearless date further out than this is ambiguous. */
  yearlessHorizonDays: number;
  /** R7 grace for clock skew and typing latency. */
  pastGraceSeconds: number;
};

/**
 * Defaults settled in PLAN §13 on 2026-09-24.
 *
 * R5 covers 00:00–05:59: "תעיר אותי ב-6" is a normal request and should not
 * cost a round trip, while anything earlier is more likely a misread hour.
 */
export const DEFAULT_TIME_SETTINGS: TimeSettings = {
  unlikelyHourGuard: true,
  unlikelyHourStart: 0,
  unlikelyHourEnd: 6,
  smallHoursUntil: 4,
  nextWeekdayMeansFollowingWeek: false,
  confirmHorizonDays: 365,
  yearlessHorizonDays: 300,
  pastGraceSeconds: 60,
};

// -- Results ------------------------------------------------------------------

export type ResolveRule =
  | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6'
  | 'R7' | 'R8' | 'R9' | 'R10' | 'R11' | 'R12';

export type ResolvedTime = {
  kind: 'resolved';
  utcMs: number;
  local: LocalParts;
  offsetMinutes: number;
  zone: string;
  /** R8: far-future writes still execute, but only after a confirmation. */
  needsConfirm: boolean;
  rule?: ResolveRule;
};

export type ClarifyTime = {
  kind: 'clarify';
  rule: ResolveRule;
  /** Stable reason code. User-facing wording lives in `src/render/`. */
  reason: string;
  /** What the bot can offer instead, when there is an obvious candidate. */
  suggestion?: { utcMs: number; local: LocalParts; offsetMinutes: number };
  /** Both instants of a DST fold, so the reply can offer a choice. */
  options?: { utcMs: number; local: LocalParts; offsetMinutes: number }[];
};

export type ResolveResult = ResolvedTime | ClarifyTime;

export type ResolveContext = {
  nowMs: number;
  settings?: TimeSettings;
  zone?: string;
};

// -- Entry point --------------------------------------------------------------

export function resolveWhen(draft: WhenDraft, ctx: ResolveContext): ResolveResult {
  const settings = ctx.settings ?? DEFAULT_TIME_SETTINGS;
  const zone = ctx.zone ?? ZONE;
  const { nowMs } = ctx;

  // R1: a duration carries its own time and skips the wall-clock rules entirely.
  if (draft.date?.kind === 'in_duration') {
    return resolveDuration(draft.date.minutes, nowMs, zone, settings);
  }

  // R3: never invent a time. This is the single most important rule here.
  if (!draft.time) {
    return clarify('R3', 'missing_time');
  }

  const adjusted = applyMeridiem(draft.time);
  if (!adjusted) return clarify('R4', 'invalid_time');

  const nowLocal = localPartsOf(nowMs, zone);

  // R5: a bare small-hours number is more often a misread than a real 03:00.
  if (
    settings.unlikelyHourGuard &&
    adjusted.hour >= settings.unlikelyHourStart &&
    adjusted.hour < settings.unlikelyHourEnd &&
    draft.time.part_of_day === 'unspecified' &&
    draft.time.meridiem === 'unspecified'
  ) {
    return clarify('R5', 'unlikely_hour');
  }

  const dateResult = resolveDate(draft.date, nowLocal, settings);
  if (dateResult.kind === 'clarify') return dateResult;

  const wall: WallTime = {
    year: dateResult.date.year,
    month: dateResult.date.month,
    day: dateResult.date.day,
    hour: adjusted.hour,
    minute: adjusted.minute,
  };

  // R2: DST gaps and folds are reported, never resolved by picking a side.
  const resolution = wallTimeToUtc(wall, zone);
  if (resolution.kind === 'gap') {
    return clarify('R2', 'nonexistent_local_time');
  }
  if (resolution.kind === 'fold') {
    return {
      kind: 'clarify',
      rule: 'R2',
      reason: 'ambiguous_local_time',
      options: resolution.utcMsCandidates.map((utcMs) => ({
        utcMs,
        local: localPartsOf(utcMs, zone),
        offsetMinutes: offsetOf(utcMs, wall),
      })),
    };
  }

  // R7: already past. Offer the same wall time tomorrow rather than firing late.
  if (resolution.utcMs < nowMs - settings.pastGraceSeconds * 1000) {
    const tomorrow = wallTimeToUtc(addDays(wall, 1), zone);
    return {
      kind: 'clarify',
      rule: 'R7',
      reason: 'already_past',
      ...(tomorrow.kind === 'ok'
        ? {
            suggestion: {
              utcMs: tomorrow.utcMs,
              local: localPartsOf(tomorrow.utcMs, zone),
              offsetMinutes: tomorrow.offsetMinutes,
            },
          }
        : {}),
    };
  }

  // R8: a year out is usually a typo, so it executes only after confirmation.
  const daysAhead = (resolution.utcMs - nowMs) / 86_400_000;
  const needsConfirm = daysAhead > settings.confirmHorizonDays;

  return {
    kind: 'resolved',
    utcMs: resolution.utcMs,
    local: localPartsOf(resolution.utcMs, zone),
    offsetMinutes: resolution.offsetMinutes,
    zone,
    needsConfirm,
    ...(needsConfirm ? { rule: 'R8' as const } : {}),
    ...(dateResult.rule ? { rule: dateResult.rule } : {}),
  };
}

// -- R1 -----------------------------------------------------------------------

function resolveDuration(
  minutes: number,
  nowMs: number,
  zone: string,
  settings: TimeSettings,
): ResolveResult {
  const MAX_MINUTES = settings.confirmHorizonDays * 24 * 60;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return clarify('R1', 'invalid_duration');
  }
  if (minutes > MAX_MINUTES) {
    return clarify('R1', 'duration_too_long');
  }

  // UTC arithmetic: "in two hours" means two elapsed hours, whatever the wall
  // clock does in between. A DST transition must not stretch or shrink it.
  const utcMs = nowMs + minutes * 60_000;
  const local = localPartsOf(utcMs, zone);

  return {
    kind: 'resolved',
    utcMs,
    local,
    offsetMinutes: offsetOf(utcMs, {
      year: local.year,
      month: local.month,
      day: local.day,
      hour: local.hour,
      minute: local.minute,
    }),
    zone,
    needsConfirm: false,
    rule: 'R1',
  };
}

// -- R4 -----------------------------------------------------------------------

/**
 * Israeli convention is the 24-hour clock, so a bare number is taken literally.
 * `meridiem` and `part_of_day` only ever shift a 1–12 hour into the afternoon.
 */
export function applyMeridiem(time: TimeSpec): { hour: number; minute: number } | null {
  if (!Number.isInteger(time.hour) || !Number.isInteger(time.minute)) return null;
  if (time.hour < 0 || time.hour > 23) return null;
  if (time.minute < 0 || time.minute > 59) return null;

  let hour = time.hour;

  if (time.meridiem === 'pm') {
    if (hour < 12) hour += 12;
    return { hour, minute: time.minute };
  }
  if (time.meridiem === 'am') {
    if (hour === 12) hour = 0;
    return { hour, minute: time.minute };
  }

  // Part-of-day words only disambiguate a 1-11 reading. A number already on the
  // 24-hour clock ("20 בערב") is left exactly as stated.
  switch (time.part_of_day) {
    case 'afternoon':
    case 'evening':
      if (hour >= 1 && hour <= 11) hour += 12;
      break;
    case 'night':
      // "2 בלילה" is 02:00, not 14:00 — the small hours are already night.
      // "11 בלילה" is 23:00, and "12 בלילה" is midnight.
      if (hour >= 6 && hour <= 11) hour += 12;
      else if (hour === 12) hour = 0;
      break;
    case 'morning':
    case 'noon':
    case 'unspecified':
      break;
  }

  return { hour, minute: time.minute };
}

// -- R6, R9, R10, R12 ---------------------------------------------------------

type DateResolution =
  | { kind: 'date'; date: { year: number; month: number; day: number }; rule?: ResolveRule }
  | ClarifyTime;

function resolveDate(
  spec: DateSpec | undefined,
  nowLocal: LocalParts,
  settings: TimeSettings,
): DateResolution {
  const today = { year: nowLocal.year, month: nowLocal.month, day: nowLocal.day, hour: 12, minute: 0 };

  // No date at all means today; R7 catches it if that time has passed.
  if (!spec) {
    return { kind: 'date', date: stripTime(today) };
  }

  if (spec.kind === 'relative_days') {
    if (!Number.isInteger(spec.offset) || spec.offset < 0 || spec.offset > 400) {
      return clarify('R10', 'invalid_offset');
    }
    // R6: at 00:30, "tomorrow" is as likely to mean "later today" as the 25th.
    if (spec.offset > 0 && nowLocal.hour < settings.smallHoursUntil) {
      return clarify('R6', 'small_hours_relative_date');
    }
    return { kind: 'date', date: stripTime(addDays(today, spec.offset)) };
  }

  if (spec.kind === 'weekday') {
    if (!Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6) {
      return clarify('R9', 'invalid_weekday');
    }
    // R9: "on Thursday" said on a Thursday is genuinely ambiguous.
    if (spec.weekday === nowLocal.weekday) {
      return clarify('R9', 'weekday_is_today');
    }
    let delta = (spec.weekday - nowLocal.weekday + 7) % 7;
    if (delta === 0) delta = 7;
    if (spec.qualifier === 'next' && settings.nextWeekdayMeansFollowingWeek) {
      delta += 7;
    }
    return { kind: 'date', date: stripTime(addDays(today, delta)), rule: 'R9' };
  }

  // `in_duration` never reaches here — `resolveWhen` handles it under R1 before
  // any wall-clock work. Narrowing it away explicitly keeps that contract typed.
  if (spec.kind !== 'absolute') {
    return clarify('R1', 'duration_handled_upstream');
  }

  if (spec.year !== undefined) {
    if (!isRealDate(spec.year, spec.month, spec.day)) {
      return clarify('R10', 'nonexistent_date');
    }
    return { kind: 'date', date: { year: spec.year, month: spec.month, day: spec.day } };
  }

  // R10: no year — take the nearest future occurrence, allowing for 29 February.
  const candidate = nearestFutureOccurrence(spec.month, spec.day, nowLocal);
  if (!candidate) return clarify('R10', 'nonexistent_date');

  const daysAway = daysBetween(nowLocal, candidate);
  if (daysAway > settings.yearlessHorizonDays) {
    return clarify('R10', 'yearless_date_far_away');
  }
  return { kind: 'date', date: candidate, rule: 'R10' };
}

function nearestFutureOccurrence(
  month: number,
  day: number,
  nowLocal: LocalParts,
): { year: number; month: number; day: number } | null {
  // Four years is enough to pass a leap year from any starting point.
  for (let year = nowLocal.year; year <= nowLocal.year + 4; year++) {
    if (!isRealDate(year, month, day)) continue;
    if (
      year > nowLocal.year ||
      month > nowLocal.month ||
      (month === nowLocal.month && day >= nowLocal.day)
    ) {
      return { year, month, day };
    }
  }
  return null;
}

// -- helpers ------------------------------------------------------------------

function stripTime(wall: WallTime): { year: number; month: number; day: number } {
  return { year: wall.year, month: wall.month, day: wall.day };
}

function daysBetween(
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number },
): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

function offsetOf(utcMs: number, wall: WallTime): number {
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  return Math.round((wallAsUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

function clarify(rule: ResolveRule, reason: string): ClarifyTime {
  return { kind: 'clarify', rule, reason };
}

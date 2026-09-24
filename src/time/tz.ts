/**
 * Timezone arithmetic on top of native `Intl`. No date library: Workers give
 * 10 ms of CPU per request (PLAN §4), and `Intl.DateTimeFormat` with a fixed
 * zone is both built in and cached by the runtime.
 *
 * Everything here is pure. The caller supplies "now"; nothing reads the clock.
 */

export const ZONE = 'Asia/Jerusalem';

/** Wall-clock fields in a given zone. `weekday` is 0 = Sunday (PLAN R12). */
export type LocalParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0-6, Sunday = 0
};

/** A wall-clock time with no zone attached yet. */
export type WallTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
};

export type WallResolution =
  | { kind: 'ok'; utcMs: number; offsetMinutes: number }
  /** The wall time does not exist — it fell in a spring-forward gap. */
  | { kind: 'gap' }
  /** The wall time happened twice — it fell in a fall-back fold. */
  | { kind: 'fold'; utcMsCandidates: [number, number] };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields for an instant, in the given zone. */
export function localPartsOf(utcMs: number, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';

  // `hour12: false` renders midnight as 24 in some ICU versions.
  const hour = Number(get('hour')) % 24;
  const weekday = WEEKDAYS.indexOf(get('weekday') as (typeof WEEKDAYS)[number]);

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday,
  };
}

/** The zone's UTC offset, in minutes, at a given instant. */
export function offsetMinutesAt(utcMs: number, timeZone: string): number {
  const p = localPartsOf(utcMs, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  // Seconds and milliseconds are not part of LocalParts, so align on the minute.
  return Math.round((asIfUtc - Math.floor(utcMs / 60_000) * 60_000) / 60_000);
}

/**
 * Convert a wall-clock time to a UTC instant, reporting the two DST edge cases
 * explicitly rather than silently picking one (PLAN R2).
 *
 * The candidates are derived from the offsets twelve hours either side of the
 * target, which straddles any transition, and each is kept only if it maps back
 * to exactly the wall time asked for.
 */
export function wallTimeToUtc(wall: WallTime, timeZone: string): WallResolution {
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const HALF_DAY = 12 * 60 * 60 * 1000;

  const offsetBefore = offsetMinutesAt(wallAsUtc - HALF_DAY, timeZone);
  const offsetAfter = offsetMinutesAt(wallAsUtc + HALF_DAY, timeZone);

  const seen = new Set<number>();
  const valid: { utcMs: number; offsetMinutes: number }[] = [];

  for (const offsetMinutes of [offsetBefore, offsetAfter]) {
    const utcMs = wallAsUtc - offsetMinutes * 60_000;
    if (seen.has(utcMs)) continue;
    seen.add(utcMs);

    const back = localPartsOf(utcMs, timeZone);
    if (
      back.year === wall.year &&
      back.month === wall.month &&
      back.day === wall.day &&
      back.hour === wall.hour &&
      back.minute === wall.minute
    ) {
      valid.push({ utcMs, offsetMinutes });
    }
  }

  if (valid.length === 0) return { kind: 'gap' };
  if (valid.length === 1) {
    const only = valid[0]!;
    return { kind: 'ok', utcMs: only.utcMs, offsetMinutes: only.offsetMinutes };
  }

  const sorted = valid.map((v) => v.utcMs).sort((a, b) => a - b);
  return { kind: 'fold', utcMsCandidates: [sorted[0]!, sorted[1]!] };
}

/** Add whole days to a wall-clock date, normalizing month and year rollover. */
export function addDays(wall: WallTime, days: number): WallTime {
  const shifted = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days, wall.hour, wall.minute));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

/** True when the calendar date exists (rejects 31 September, 29 February in a common year). */
export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

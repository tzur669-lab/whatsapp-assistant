/**
 * Reading an iCalendar feed (PLAN §6.15, RFC 5545).
 *
 * A deliberate subset. Full RFC 5545 is a large specification with a great deal
 * in it no personal assistant reads — alarms, attachments, free/busy, journals,
 * per-instance overrides. What a timetable, a university calendar or a shared
 * team feed actually contains is VEVENTs with a start, an end, a title and
 * sometimes a recurrence rule, and that is what this reads.
 *
 * **Recurrences are expanded into a window, not in general.** A general RRULE
 * expander is where this kind of parser goes wrong: it grows BYSETPOS and
 * BYMONTHDAY and WKST and becomes the largest thing in the codebase. Expanding
 * only into the sixty days the assistant will actually ask about turns it into a
 * bounded loop with a hard iteration cap, and the cases it gets wrong are ones
 * nobody would see anyway.
 *
 * **Everything here is untrusted input** — a remote file the user pointed at.
 * Every count is capped, every unknown property is ignored rather than
 * interpreted, and a malformed event is dropped rather than failing the feed.
 * One bad VEVENT in a semester's timetable should cost that one event.
 */
import { addDays, localPartsOf, wallTimeToUtc, ZONE } from '../time/tz.js';
import type { WallTime } from '../time/tz.js';

/** Caps. A feed is a file from the internet; none of these is negotiable. */
export const MAX_EVENTS = 500;
export const MAX_INSTANCES_PER_RULE = 400;
export const MAX_TITLE_CHARS = 200;
const MAX_LINES = 200_000;

export type IcalEvent = {
  /** The feed's own id. Instances of a recurrence share it. */
  uid: string;
  title: string;
  startUtc: number;
  endUtc: number;
  allDay: boolean;
};

export type ParseResult = {
  events: IcalEvent[];
  /** Events that were dropped as unreadable. A count only — never the content. */
  skipped: number;
  /** True when a cap was reached, so the caller can say the feed was truncated. */
  truncated: boolean;
};

/**
 * Parse a feed and expand it into `[windowStart, windowEnd)`.
 *
 * The window is required rather than optional: without one a yearly recurrence
 * with no UNTIL has no answer, and defaulting it would hide that.
 */
export function parseIcal(
  text: string,
  window: { startUtc: number; endUtc: number },
  zone: string = ZONE,
): ParseResult {
  const lines = unfold(text);
  const events: IcalEvent[] = [];
  let skipped = 0;
  let truncated = lines.length >= MAX_LINES;

  let current: Record<string, Property> | null = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      current = {};
      continue;
    }

    if (line === 'END:VEVENT') {
      if (current) {
        const expanded = eventsFrom(current, window, zone);
        if (expanded === null) skipped += 1;
        else events.push(...expanded);
      }
      current = null;

      if (events.length >= MAX_EVENTS) {
        truncated = true;
        break;
      }
      continue;
    }

    if (!current) continue;
    const property = parseProperty(line);
    if (property) current[property.name] = property;
  }

  events.sort((a, b) => a.startUtc - b.startUtc);
  return { events: events.slice(0, MAX_EVENTS), skipped, truncated };
}

// -- lines --------------------------------------------------------------------

type Property = { name: string; params: Record<string, string>; value: string };

/**
 * Undo RFC 5545 line folding: a line beginning with a space or tab continues
 * the one before it, with that first character removed.
 *
 * Done before anything else, because a folded line can split a property name,
 * a parameter or a value in the middle — including in the middle of a UTF-8
 * character, which is why this works on the already-decoded string.
 */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];

  for (const line of raw) {
    if (lines.length >= MAX_LINES) break;
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
      continue;
    }
    lines.push(line);
  }
  return lines;
}

function parseProperty(line: string): Property | null {
  const colon = indexOfUnquoted(line, ':');
  if (colon <= 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [rawName, ...rawParams] = head.split(';');
  if (!rawName) return null;

  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const equals = param.indexOf('=');
    if (equals <= 0) continue;
    params[param.slice(0, equals).toUpperCase()] = stripQuotes(param.slice(equals + 1));
  }

  return { name: rawName.toUpperCase(), params, value };
}

/** A colon inside a quoted parameter (`TZID="Asia/Jerusalem"`) is not the separator. */
function indexOfUnquoted(line: string, char: string): number {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === char && !quoted) return i;
  }
  return -1;
}

function stripQuotes(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

// -- events -------------------------------------------------------------------

function eventsFrom(
  properties: Record<string, Property>,
  window: { startUtc: number; endUtc: number },
  zone: string,
): IcalEvent[] | null {
  // A cancelled event is still in the file. Showing it would be worse than not
  // reading the feed at all.
  if (properties['STATUS']?.value.toUpperCase() === 'CANCELLED') return [];

  const dtstart = properties['DTSTART'];
  if (!dtstart) return null;

  const start = parseDateTime(dtstart, zone);
  if (start === null) return null;

  const title = unescapeText(properties['SUMMARY']?.value ?? '').slice(0, MAX_TITLE_CHARS);
  const uid = (properties['UID']?.value ?? '').slice(0, 200) || `x-${start.utcMs}`;

  const durationMs = durationOf(properties, start, zone);
  if (durationMs === null) return null;

  const exdates = exceptionsOf(properties, zone);
  const rule = properties['RRULE'] ? parseRrule(properties['RRULE'].value) : null;

  // Stepped through the start's own zone, not the assistant's.
  const starts = rule ? expand(start, rule, window) : [start.utcMs];

  const events: IcalEvent[] = [];
  for (const startUtc of starts) {
    if (exdates.has(startUtc)) continue;
    const endUtc = startUtc + durationMs;
    // Overlap, not containment: a meeting that began before the window and is
    // still going is on your calendar right now.
    if (endUtc <= window.startUtc || startUtc >= window.endUtc) continue;
    events.push({ uid, title, startUtc, endUtc, allDay: start.allDay });
  }
  return events;
}

type Moment = {
  utcMs: number;
  allDay: boolean;
  wall: WallTime;
  /**
   * The zone the wall time belongs to, and therefore the zone a recurrence must
   * be stepped through. A `Z` start is anchored to UTC; stepping it through the
   * assistant's zone would shift every instance after the first by the offset.
   */
  zone: string;
};

/**
 * `20260925T140000Z`, `20260925T140000` with a TZID, or `20260925` as a date.
 *
 * A time with neither `Z` nor a TZID is "floating" — it means the same wall
 * clock wherever it is read. It is resolved in the assistant's own zone, which
 * is the only sensible reading for a feed being shown to one person in Israel.
 */
function parseDateTime(property: Property, zone: string): Moment | null {
  const value = property.value.trim();
  const isDate = property.params['VALUE'] === 'DATE' || /^\d{8}$/.test(value);

  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, utc] = match;
  const wall: WallTime = {
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour ?? 0),
    minute: Number(minute ?? 0),
  };
  void second;

  if (!isFiniteWall(wall)) return null;

  if (utc) {
    return {
      utcMs: Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute),
      allDay: false,
      wall,
      zone: 'UTC',
    };
  }

  const tzid = property.params['TZID'] ?? zone;
  const resolved = toUtc(wall, tzid, zone);
  if (resolved === null) return null;

  return { utcMs: resolved, allDay: isDate, wall, zone: tzid };
}

/**
 * A wall time in a named zone, as an instant.
 *
 * An unknown TZID falls back to the assistant's zone rather than failing: a feed
 * naming a zone this runtime has never heard of is still a feed worth reading,
 * and being an hour out is better than showing nothing.
 */
function toUtc(wall: WallTime, tzid: string, fallbackZone: string): number | null {
  for (const zone of [tzid, fallbackZone]) {
    try {
      const resolved = wallTimeToUtc(wall, zone);
      if (resolved.kind === 'ok') return resolved.utcMs;
      // A DST gap or fold in a feed is not a question to ask the user about —
      // there is nobody to ask. The earlier reading is taken.
      if (resolved.kind === 'fold') return Math.min(...resolved.utcMsCandidates);
      // A gap means the clock skipped that wall time, so there is no instant to
      // return. The next zone in the list is tried, and failing that the event
      // is dropped — one hour a year, and the alternative is inventing a time.
      if (resolved.kind === 'gap') continue;
    } catch {
      continue;
    }
  }
  return null;
}

function isFiniteWall(wall: WallTime): boolean {
  return (
    Number.isInteger(wall.year) &&
    wall.month >= 1 &&
    wall.month <= 12 &&
    wall.day >= 1 &&
    wall.day <= 31 &&
    wall.hour >= 0 &&
    wall.hour <= 23 &&
    wall.minute >= 0 &&
    wall.minute <= 59
  );
}

/** DTEND, or DURATION, or a default that depends on whether it is all day. */
function durationOf(
  properties: Record<string, Property>,
  start: Moment,
  zone: string,
): number | null {
  const dtend = properties['DTEND'];
  if (dtend) {
    const end = parseDateTime(dtend, zone);
    if (end === null) return null;
    return Math.max(0, end.utcMs - start.utcMs);
  }

  const duration = properties['DURATION'];
  if (duration) {
    const ms = parseDuration(duration.value);
    if (ms !== null) return ms;
  }

  // RFC 5545: a DATE start with no end lasts one day; a DATE-TIME start with no
  // end is instantaneous. The second is technically right and useless to render,
  // so it gets an hour — which is what every calendar client shows.
  return start.allDay ? 24 * 3_600_000 : 3_600_000;
}

/** `P1DT2H30M`. Weeks, days, hours, minutes, seconds; months and years are not durations. */
function parseDuration(value: string): number | null {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!match) return null;

  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms =
    (Number(weeks ?? 0) * 7 * 86_400 +
      Number(days ?? 0) * 86_400 +
      Number(hours ?? 0) * 3_600 +
      Number(minutes ?? 0) * 60 +
      Number(seconds ?? 0)) *
    1_000;

  return sign === '-' ? -ms : ms;
}

function exceptionsOf(properties: Record<string, Property>, zone: string): Set<number> {
  const exdate = properties['EXDATE'];
  if (!exdate) return new Set();

  const excluded = new Set<number>();
  for (const value of exdate.value.split(',').slice(0, MAX_INSTANCES_PER_RULE)) {
    const moment = parseDateTime({ ...exdate, value }, zone);
    if (moment) excluded.add(moment.utcMs);
  }
  return excluded;
}

// -- recurrence ---------------------------------------------------------------

type Rrule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count: number | null;
  untilUtc: number | null;
  /** WEEKLY only: 0 = Sunday. Empty means "the weekday DTSTART falls on". */
  byDay: number[];
};

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;

function parseRrule(value: string): Rrule | null {
  const parts: Record<string, string> = {};
  for (const pair of value.split(';')) {
    const equals = pair.indexOf('=');
    if (equals > 0) parts[pair.slice(0, equals).toUpperCase()] = pair.slice(equals + 1);
  }

  const freq = parts['FREQ']?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    // HOURLY, MINUTELY and SECONDLY exist and belong to machines, not calendars.
    return null;
  }

  const interval = Number(parts['INTERVAL'] ?? 1);
  const count = parts['COUNT'] ? Number(parts['COUNT']) : null;

  const until = parts['UNTIL'];
  const untilMatch = until ? /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(until) : null;
  const untilUtc = untilMatch
    ? Date.UTC(
        Number(untilMatch[1]),
        Number(untilMatch[2]) - 1,
        Number(untilMatch[3]),
        Number(untilMatch[4] ?? 23),
        Number(untilMatch[5] ?? 59),
      )
    : null;

  const byDay = (parts['BYDAY'] ?? '')
    .split(',')
    .map((code) => WEEKDAY_CODES.indexOf(code.trim().slice(-2).toUpperCase() as 'SU'))
    .filter((index) => index >= 0);

  return {
    freq,
    interval: Number.isInteger(interval) && interval > 0 ? interval : 1,
    count: count !== null && Number.isInteger(count) && count > 0 ? count : null,
    untilUtc,
    byDay,
  };
}

/**
 * Instances of a rule that fall inside the window.
 *
 * Stepped through the **wall clock**, not by adding milliseconds: "every
 * Tuesday at 09:00" means nine in the morning on both sides of a DST change,
 * and adding seven times 86,400,000 would move it by an hour. That is the same
 * rule R1–R12 apply to everything else here.
 */
function expand(
  start: Moment,
  rule: Rrule,
  window: { startUtc: number; endUtc: number },
): number[] {
  const zone = start.zone;
  const instances: number[] = [];
  const limit = rule.untilUtc === null ? window.endUtc : Math.min(rule.untilUtc, window.endUtc);

  let wall = start.wall;
  let emitted = 0;

  for (let step = 0; step < MAX_INSTANCES_PER_RULE; step++) {
    const occurrences =
      rule.freq === 'WEEKLY' && rule.byDay.length > 0 ? weekOf(wall, rule.byDay, zone) : [wall];

    for (const occurrence of occurrences) {
      const utcMs = toUtc(occurrence, zone, zone);
      if (utcMs === null) continue;
      if (utcMs < start.utcMs) continue;
      if (utcMs > limit) return instances;

      if (rule.count !== null && emitted >= rule.count) return instances;
      emitted += 1;
      if (utcMs >= window.startUtc) instances.push(utcMs);
    }

    wall = advance(wall, rule);
    // Past the window with nothing left to find.
    const next = toUtc(wall, zone, zone);
    if (next === null || next > limit) break;
  }

  return instances;
}

/** The days of `wall`'s week that the rule names. */
function weekOf(wall: WallTime, byDay: number[], zone: string): WallTime[] {
  const asInstant = toUtc(wall, zone, zone);
  if (asInstant === null) return [wall];

  const weekday = localPartsOf(asInstant, zone).weekday;
  return byDay
    .slice()
    .sort((a, b) => a - b)
    .map((target) => addDays(wall, target - weekday));
}

function advance(wall: WallTime, rule: Rrule): WallTime {
  switch (rule.freq) {
    case 'DAILY':
      return addDays(wall, rule.interval);
    case 'WEEKLY':
      return addDays(wall, 7 * rule.interval);
    case 'MONTHLY':
      return addMonths(wall, rule.interval);
    case 'YEARLY':
      return addMonths(wall, 12 * rule.interval);
  }
}

/**
 * Months, keeping the day of the month where one exists.
 *
 * The 31st of a 30-day month is skipped rather than rolled into the next one.
 * RFC 5545 says the same, and rolling would put a monthly meeting on the 1st
 * four times a year without anyone asking for it.
 */
function addMonths(wall: WallTime, months: number): WallTime {
  const total = (wall.year * 12 + (wall.month - 1)) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return { ...wall, year, month };
}

// -- text ---------------------------------------------------------------------

/** RFC 5545 TEXT escaping: `\n`, `\N`, `\,`, `\;`, `\\`. */
function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, char: string) =>
    char === 'n' || char === 'N' ? '\n' : char,
  );
}

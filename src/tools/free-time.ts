/**
 * `calendar.free_time` (2026-10-05, ROADMAP #23): when is the user free.
 * Tier 0, agent-only.
 *
 * Code computes every gap from the calendar: the busy times of timed events
 * (an all-day event does not fill the day), merged, and what is left between
 * 08:00 and 21:00 local and after now. The reply names days and times only,
 * never an event, so no title anyone else wrote reaches the model and this
 * read does not taint the turn.
 *
 * Fail safe (invariant 12): a calendar that could not be read, or a window
 * with more events than one read holds, answers "unavailable" — a partial read
 * would show busy time as free.
 */
import { z } from 'zod';
import { calendarFreeTimeSlots } from '../nlu/slot-schemas.js';
import { resolveWhen } from '../time/resolve.js';
import type { DateSpec } from '../time/resolve.js';
import { resolveRange } from '../time/range.js';
import { addDays, localPartsOf, wallTimeToUtc, ZONE } from '../time/tz.js';
import type { WallTime } from '../time/tz.js';
import { asCalendarEvents } from '../ical/merge.js';
import type { CalendarEvent } from '../google/calendar.js';
import { eventText } from '../render/events.js';
import { formatDay, formatDuration } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { isolateLtr } from '../render/bidi.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';

export const DAY_START_HOUR = 8;
export const DAY_END_HOUR = 21;
const DEFAULT_MINUTES = 30;
/** One read; reaching it means there may be more, so the answer is refused. */
export const MAX_FREE_EVENTS = 100;
const MAX_DAYS = 7;
const MAX_GAPS_PER_DAY = 5;
const MINUTE = 60_000;

const inputSchema = z
  .object({
    startUtc: z.number().int().positive(),
    endUtc: z.number().int().positive(),
    minutes: z.number().int().min(15).max(480),
  })
  .strict();

type FreeInput = z.infer<typeof inputSchema>;

export const calendarFreeTime: ToolDefinition = {
  name: 'calendar.free_time',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = calendarFreeTimeSlots.safeParse(rawSlots);
    if (!slots.success) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'date' } };
    const { date, range } = slots.data;
    const minutes = slots.data.minutes ?? DEFAULT_MINUTES;

    // A range wins over a date, as in `calendar.list_events`. From now on:
    // free time already behind is no use to anyone.
    if (range) {
      const { startUtc, endUtc } = resolveRange(range, ctx.nowMs, ZONE);
      return { kind: 'ready', input: { startUtc, endUtc, minutes } satisfies FreeInput };
    }

    let dayUtc = ctx.nowMs;
    if (date) {
      const when = resolveWhen(
        { date: date as DateSpec, time: { hour: 12, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
        { nowMs: ctx.nowMs },
      );
      if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };
      dayUtc = when.utcMs;
    }
    const day = { ...localPartsOf(dayUtc, ZONE), hour: 0, minute: 0 };
    return {
      kind: 'ready',
      input: { startUtc: wallUtc(day), endUtc: wallUtc(addDays(day, 1)), minutes } satisfies FreeInput,
    };
  },

  preview(_rawInput, lang): string {
    return lang === 'he' ? 'זמן פנוי ביומן' : 'Free time on the calendar';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<FreeInput>(inputSchema, rawInput, 'calendar.free_time');
    const from = Math.max(input.startUtc, ctx.nowMs);
    if (from >= input.endUtc) return { text: passed(ctx.lang) };

    const subscribed = ctx.ical
      ? asCalendarEvents(ctx.ical.eventsBetween(ctx.principal, from, input.endUtc, MAX_FREE_EVENTS))
      : [];
    if (subscribed.length >= MAX_FREE_EVENTS) return { text: tooMany(ctx.lang) };

    let events: CalendarEvent[] = subscribed;
    if (ctx.calendar) {
      const result = await ctx.calendar.listAllEvents({
        startUtc: from,
        endUtc: input.endUtc,
        limit: MAX_FREE_EVENTS,
        strict: true,
      });
      if (!result.ok) {
        switch (result.error.code) {
          case 'not_connected':
            // Without Google, a subscribed feed is the whole calendar, as in
            // `calendar.list_events`.
            if (!ctx.ical) return { text: eventText.notConnected(ctx.lang) };
            break;
          case 'disconnected':
            return { text: eventText.disconnected(ctx.lang) };
          default:
            ctx.log.warn('calendar_free_failed', { errorCode: result.error.code });
            return { text: eventText.unavailable(ctx.lang) };
        }
      } else {
        if (result.value.length >= MAX_FREE_EVENTS) return { text: tooMany(ctx.lang) };
        events = [...result.value, ...subscribed];
      }
    } else if (!ctx.ical) {
      return { text: eventText.notConnected(ctx.lang) };
    }

    const busy = mergeBusy(events);
    const days = freeByDay(from, input.endUtc, busy, input.minutes * MINUTE);
    // Late in the evening, today has no hours left to be free in.
    if (days.length === 0) return { text: passed(ctx.lang) };
    return { text: render(days, input.minutes, ctx.lang) };
  },
};

type Interval = { start: number; end: number };
export type FreeDay = { dayUtc: number; gaps: Interval[] };

/** Timed events as sorted, non-overlapping busy intervals. */
export function mergeBusy(events: readonly CalendarEvent[]): Interval[] {
  const sorted = events
    .filter((event) => !event.allDay && event.endUtc > event.startUtc)
    .map((event) => ({ start: event.startUtc, end: event.endUtc }))
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Each local day in the window, with its gaps of at least `minMs` inside the day's hours. */
export function freeByDay(fromUtc: number, endUtc: number, busy: readonly Interval[], minMs: number): FreeDay[] {
  const days: FreeDay[] = [];
  let day: WallTime = { ...localPartsOf(fromUtc, ZONE), hour: 0, minute: 0 };
  for (let i = 0; i < MAX_DAYS; i++) {
    const dayStart = wallUtc(day);
    if (dayStart >= endUtc) break;
    const open = Math.max(wallUtc({ ...day, hour: DAY_START_HOUR }), fromUtc);
    const close = Math.min(wallUtc({ ...day, hour: DAY_END_HOUR }), endUtc);
    if (open < close) {
      const gaps: Interval[] = [];
      let cursor = open;
      for (const interval of busy) {
        if (interval.end <= cursor) continue;
        if (interval.start >= close) break;
        if (interval.start - cursor >= minMs) gaps.push({ start: cursor, end: interval.start });
        cursor = Math.max(cursor, interval.end);
        if (cursor >= close) break;
      }
      if (close - cursor >= minMs) gaps.push({ start: cursor, end: close });
      days.push({ dayUtc: dayStart, gaps: gaps.slice(0, MAX_GAPS_PER_DAY) });
    }
    day = addDays(day, 1);
  }
  return days;
}

function render(days: readonly FreeDay[], minutes: number, lang: Lang): string {
  const he = lang === 'he';
  if (days.every((day) => day.gaps.length === 0)) {
    return he
      ? `אין זמן פנוי של ${formatDuration(minutes, 'minute', lang)} לפחות בין ${isolateLtr('08:00')} ל-${isolateLtr('21:00')}.`
      : `No free time of at least ${formatDuration(minutes, 'minute', lang)} between 08:00 and 21:00.`;
  }
  const lines = days.map((day) => {
    const name = formatDay(localPartsOf(day.dayUtc + 12 * 60 * MINUTE, ZONE), lang);
    if (day.gaps.length === 0) return `${name}: ${he ? 'אין זמן פנוי' : 'nothing free'}`;
    return `${name}: ${day.gaps.map((gap) => isolateLtr(`${clock(gap.start)}–${clock(gap.end)}`)).join(', ')}`;
  });
  const head = he ? 'זמן פנוי ביומן:' : 'Free time on the calendar:';
  return [head, ...lines].join('\n');
}

const pad = (n: number) => String(n).padStart(2, '0');

function clock(utcMs: number): string {
  const local = localPartsOf(utcMs, ZONE);
  return `${pad(local.hour)}:${pad(local.minute)}`;
}

function passed(lang: Lang): string {
  return lang === 'he'
    ? `השעות ${isolateLtr('08:00–21:00')} בטווח הזה כבר עברו.`
    : 'The hours 08:00–21:00 in that range have already passed.';
}

function tooMany(lang: Lang): string {
  return lang === 'he'
    ? 'יש ביומן יותר מדי אירועים בטווח הזה כדי לחשב זמן פנוי. אפשר לשאול על יום אחד.'
    : 'There are too many events in that range to work out free time. Try asking about one day.';
}

/** A wall time in Jerusalem as an instant; a DST gap or fold takes the earlier reading. */
function wallUtc(wall: WallTime): number {
  const resolved = wallTimeToUtc(wall, ZONE);
  if (resolved.kind === 'ok') return resolved.utcMs;
  if (resolved.kind === 'fold') return Math.min(...resolved.utcMsCandidates);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - 2 * 60 * MINUTE;
}

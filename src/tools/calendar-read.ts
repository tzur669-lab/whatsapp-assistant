/**
 * `calendar.list_events` (PLAN §6.4, §6.6).
 *
 * Tier 0: it reads, so it runs without a confirmation. What it must never do is
 * let event data anywhere near the model — the titles, ids and times that come
 * back are rendered by code and matched by code (CLAUDE.md invariants 2 and 5).
 *
 * A day and a range are both accepted, because "tomorrow" and "this week" are
 * both ordinary questions. A day is a `DateSpec` resolved through the time
 * rules; a range is one of the named spans. Asked with neither, it answers
 * about today rather than asking a question nobody wants for a read.
 *
 * A read has no limit in time (2026-10-12): a past day (`days_ago`, or a date
 * with its year), last week or last month, a whole month or year. Every window
 * is computed in `src/time/range.ts`.
 */
import { z } from 'zod';
import { resolveDay } from '../time/resolve.js';
import type { DateSpec } from '../time/resolve.js';
import { daysAgoWindow, dayWindowOf, monthWindow, resolveRange, resolveReadSpan, yearWindow } from '../time/range.js';
import type { ReadSpan } from '../time/range.js';
import { calendarRangeSchema, MIN_READ_YEAR } from '../nlu/slot-schemas.js';
import { localPartsOf, wallTimeToUtc, addDays, ZONE } from '../time/tz.js';
import { eventText } from '../render/events.js';
import { asCalendarEvents } from '../ical/merge.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';
import { parseInput } from './types.js';

const MAX_EVENTS = 20;

const inputSchema = z
  .object({ startUtc: z.number().int().positive(), endUtc: z.number().int().positive() })
  .strict();

type ListInput = z.infer<typeof inputSchema>;

const slotsSchema = z
  .object({
    date: z.unknown().optional(),
    days_ago: z.number().int().min(1).max(36_500).optional(),
    range: calendarRangeSchema.optional(),
    month: z.number().int().min(1).max(12).optional(),
    year: z.number().int().min(MIN_READ_YEAR).max(2100).optional(),
  })
  .passthrough();

const READ_SPANS: ReadonlySet<string> = new Set<ReadSpan>(['last_week', 'this_month', 'last_month', 'next_month']);

export const calendarListEvents: ToolDefinition = {
  name: 'calendar.list_events',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = slotsSchema.safeParse(rawSlots);
    const data = slots.success ? slots.data : {};
    const date = data.date as DateSpec | undefined;
    const range = data.range;

    // A whole month, or a whole year (2026-10-12).
    if (data.month !== undefined) return { kind: 'ready', input: monthWindow(data.month, data.year, ctx.nowMs) };
    if (data.year !== undefined && !date) return { kind: 'ready', input: yearWindow(data.year) };

    if (range && READ_SPANS.has(range)) {
      return { kind: 'ready', input: resolveReadSpan(range as ReadSpan, ctx.nowMs) };
    }

    if (range) {
      // The whole range: "this week" includes the meetings already behind.
      const { startUtc, endUtc } = resolveRange(range as 'this_week' | 'next_week' | 'weekend', ctx.nowMs, ZONE, { fromStart: true });
      return { kind: 'ready', input: { startUtc, endUtc } };
    }

    // A past day, as far back as asked.
    if (data.days_ago !== undefined) return { kind: 'ready', input: daysAgoWindow(data.days_ago, ctx.nowMs) };

    if (!date) {
      // A read with no day named is about today. Asking "which day?" for a
      // question that changes nothing would be pedantry, not safety.
      return { kind: 'ready', input: dayWindow(ctx.nowMs) };
    }

    // A date the user named is read as said, behind or ahead: with its year
    // that day, without one the nearest such date (`dayWindowOf`).
    if (date.kind === 'absolute') {
      const window = dayWindowOf(date.day, date.month, date.year, ctx.nowMs);
      if (!window) return { kind: 'clarify', clarify: { code: 'time', detail: { kind: 'clarify', rule: 'R10', reason: 'nonexistent_date' } } };
      return { kind: 'ready', input: window };
    }

    // The time resolver owns every date in the system, including this one:
    // a day, so the hour rules cannot turn it into a question (`resolveDay`).
    const when = resolveDay(date, { nowMs: ctx.nowMs });
    if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };

    return { kind: 'ready', input: dayWindow(when.utcMs) };
  },

  preview(rawInput, lang): string {
    void rawInput;
    return lang === 'he' ? 'הצגת היומן' : 'Show the calendar';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ListInput>(inputSchema, rawInput, 'calendar.list_events');
    const calendar = ctx.calendar;

    // A subscribed feed is read from the cache and merged in. It is the whole
    // answer when Google is not connected — which is the point of the feature:
    // it reaches calendars an OAuth grant never will (§6.15).
    const subscribed = ctx.ical
      ? asCalendarEvents(
          ctx.ical.eventsBetween(ctx.principal, input.startUtc, input.endUtc, MAX_EVENTS),
        )
      : [];

    if (!calendar) {
      return subscribed.length > 0
        ? { text: eventText.list(subscribed, ctx.lang, ctx.nowMs) }
        : { text: eventText.notConnected(ctx.lang) };
    }

    // Every calendar shown in Google Calendar, not only the main one (2026-10-01).
    const result = await calendar.listAllEvents({
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      limit: MAX_EVENTS,
    });

    if (!result.ok) {
      // Each failure gets the answer the user can act on, and no provider
      // detail: a status code tells them nothing and leaks a little.
      switch (result.error.code) {
        case 'not_connected':
          return { text: eventText.notConnected(ctx.lang) };
        case 'disconnected':
          return { text: eventText.disconnected(ctx.lang) };
        default:
          ctx.log.warn('calendar_list_failed', { errorCode: result.error.code });
          return { text: eventText.unavailable(ctx.lang) };
      }
    }

    return { text: eventText.list(result.value, ctx.lang, ctx.nowMs) };
  },
};

/** Local midnight to local midnight, resolved through the zone. */
function dayWindow(atUtc: number): ListInput {
  const local = localPartsOf(atUtc, ZONE);
  const midnight = { ...local, hour: 0, minute: 0 };
  return {
    startUtc: midnightUtc(midnight),
    endUtc: midnightUtc(addDays(midnight, 1)),
  };
}

function midnightUtc(wall: { year: number; month: number; day: number; hour: number; minute: number }): number {
  const resolved = wallTimeToUtc({ ...wall, hour: 0, minute: 0 }, ZONE);
  if (resolved.kind === 'ok') return resolved.utcMs;
  if (resolved.kind === 'fold') return Math.min(...resolved.utcMsCandidates);
  return Date.UTC(wall.year, wall.month - 1, wall.day);
}

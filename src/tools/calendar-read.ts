/**
 * `calendar.list_events` (PLAN §6.4, §6.6).
 *
 * Tier 0: it reads, so it runs without a confirmation. What it must never do is
 * let event data anywhere near the model — the titles, ids and times that come
 * back are rendered by code and matched by code (CLAUDE.md invariants 2 and 5).
 *
 * A day and a range are both accepted, because "tomorrow" and "this week" are
 * both ordinary questions. A day is a `DateSpec` resolved through the time
 * rules; a range is one of the three named spans. Asked with neither, it answers
 * about today rather than asking a question nobody wants for a read.
 */
import { z } from 'zod';
import { resolveWhen } from '../time/resolve.js';
import type { DateSpec } from '../time/resolve.js';
import { resolveRange } from '../time/range.js';
import { localPartsOf, wallTimeToUtc, addDays, ZONE } from '../time/tz.js';
import { eventText } from '../render/events.js';
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
    range: z.enum(['this_week', 'next_week', 'weekend']).optional(),
  })
  .passthrough();

export const calendarListEvents: ToolDefinition = {
  name: 'calendar.list_events',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = slotsSchema.safeParse(rawSlots);
    const date = slots.success ? (slots.data.date as DateSpec | undefined) : undefined;
    const range = slots.success ? slots.data.range : undefined;

    if (range) {
      const { startUtc, endUtc } = resolveRange(range, ctx.nowMs);
      return { kind: 'ready', input: { startUtc, endUtc } };
    }

    if (!date) {
      // A read with no day named is about today. Asking "which day?" for a
      // question that changes nothing would be pedantry, not safety.
      return { kind: 'ready', input: dayWindow(ctx.nowMs) };
    }

    // The time resolver owns every date in the system, including this one. It
    // is given noon so the hour rules cannot turn a plain day into a question.
    const when = resolveWhen(
      { date, time: { hour: 12, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
      { nowMs: ctx.nowMs },
    );
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

    if (!calendar) return { text: eventText.notConnected(ctx.lang) };

    const result = await calendar.listEvents({
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

    return { text: eventText.list(result.value, ctx.lang) };
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

/**
 * `calendar.create_event`, `move_event` and `delete_event` (PLAN §6.4, §6.6).
 *
 * The one rule that shapes all three: **code finds the target**. The model emits
 * `query_variants` — spellings of what the user said — and the matching happens
 * here, against events fetched from Google. An event id never comes from a
 * model, and event data never goes back to one (CLAUDE.md invariants 2 and 5).
 *
 * Tiering follows what cannot be taken back. Creating is Tier 1: it executes and
 * offers an Undo. Moving and deleting are Tier 2: they are previewed and wait
 * for a tap. Creating *with attendees* is Tier 3, because an invitation leaves
 * the system — deleting the event afterwards does not unsend it.
 *
 * Writes carry the etag they were previewed with. A confirmation tapped five
 * minutes later must not overwrite what happened in between.
 */
import { z } from 'zod';
import { resolveWhen } from '../time/resolve.js';
import type { DateSpec, TimeSpec } from '../time/resolve.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { eventText } from '../render/events.js';
import { formatWhen } from '../render/format-time.js';
import { matchByText } from './match.js';
import { MAX_TITLE_CHARS } from '../nlu/slot-schemas.js';
import type { CalendarEvent, CalendarFailure } from '../google/calendar.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';
import { parseInput } from './types.js';

/** How far ahead a described event is looked for (PLAN §6.4). */
export const SEARCH_HORIZON_DAYS = 14;

const MAX_CHOICES = 5;
const MAX_SEARCH_RESULTS = 50;

// -- calendar.create_event ----------------------------------------------------

const createInputSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    startUtc: z.number().int().positive(),
    endUtc: z.number().int().positive(),
    attendees: z.array(z.string().min(1).max(100)).max(10).optional(),
  })
  .strict();

type CreateInput = z.infer<typeof createInputSchema>;

const createSlotsSchema = z
  .object({
    title: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    date: z.unknown().optional(),
    time: z.unknown().optional(),
    duration_minutes: z.number().int().min(1).max(24 * 60).optional(),
    attendees: z.array(z.string()).optional(),
  })
  .passthrough();

export const calendarCreateEvent: ToolDefinition = {
  name: 'calendar.create_event',
  inputSchema: createInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = createSlotsSchema.safeParse(rawSlots);
    if (!slots.success) return missing('title');

    const title = slots.data.title?.trim();
    if (!title) return missing('title');

    const when = resolveWhen(
      {
        date: slots.data.date as DateSpec | undefined,
        time: slots.data.time as TimeSpec | undefined,
      },
      { nowMs: ctx.nowMs },
    );
    if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };

    // R11: there is no default duration. A meeting of unknown length is a
    // question, because guessing an hour writes a wrong end time into a shared
    // calendar (PLAN §13, settled 2026-09-24).
    const minutes = slots.data.duration_minutes;
    if (!minutes) return missing('duration');

    const attendees = (slots.data.attendees ?? []).map((name) => name.trim()).filter(Boolean);

    return {
      kind: 'ready',
      input: {
        title,
        startUtc: when.utcMs,
        endUtc: when.utcMs + minutes * 60_000,
        ...(attendees.length ? { attendees } : {}),
      },
      needsConfirm: when.needsConfirm,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<CreateInput>(createInputSchema, rawInput, 'calendar.create_event');
    return eventText.createPreview(
      input.title,
      localPartsOf(input.startUtc, ZONE),
      localPartsOf(input.endUtc, ZONE),
      input.attendees ?? [],
      lang,
    );
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<CreateInput>(createInputSchema, rawInput, 'calendar.create_event');
    if (!ctx.calendar) return { text: eventText.notConnected(ctx.lang) };

    // Attendees are only notified when the action came through Tier 3, and this
    // path has no way to know that it did — so it never notifies. An invitation
    // is a separate, explicit act (PLAN §6.4).
    const result = await ctx.calendar.createEvent({
      title: input.title,
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      ...(input.attendees ? { attendees: input.attendees } : {}),
    });

    if (!result.ok) return { text: failureText(result.error, ctx) };

    return {
      text: eventText.created(
        result.value.title,
        localPartsOf(result.value.startUtc, ZONE),
        localPartsOf(result.value.endUtc, ZONE),
        ctx.lang,
      ),
      compensating: { eventId: result.value.id },
      externalRef: result.value.id,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { eventId } = parseInput<{ eventId: string }>(
      z.object({ eventId: z.string().min(1).max(256) }).strict(),
      compensating,
      'calendar.create_event',
    );
    if (!ctx.calendar) return { text: eventText.notConnected(ctx.lang) };

    const result = await ctx.calendar.deleteEvent({ eventId });
    return { text: result.ok ? eventText.deleted(ctx.lang) : failureText(result.error, ctx) };
  },
};

// -- calendar.move_event ------------------------------------------------------

const moveInputSchema = z
  .object({
    eventId: z.string().min(1).max(256),
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    fromStartUtc: z.number().int().positive(),
    startUtc: z.number().int().positive(),
    endUtc: z.number().int().positive(),
    etag: z.string().max(256).nullable(),
  })
  .strict();

type MoveInput = z.infer<typeof moveInputSchema>;

const moveSlotsSchema = z
  .object({
    query_variants: z.array(z.string()).optional(),
    from_date: z.unknown().optional(),
    from_time: z.unknown().optional(),
    to_date: z.unknown().optional(),
    to_time: z.unknown().optional(),
  })
  .passthrough();

export const calendarMoveEvent: ToolDefinition = {
  name: 'calendar.move_event',
  inputSchema: moveInputSchema,

  resolve(): ResolveOutcome {
    // Finding the event needs the network, and `resolve` is synchronous by
    // design so policy can run before anything is fetched. The lookup therefore
    // happens in `resolveAsync`, which the orchestrator awaits for these tools.
    return missing('target');
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    const slots = moveSlotsSchema.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.query_variants ?? []) : [];
    if (variants.length === 0) return missing('target');

    const when = resolveWhen(
      {
        date: slots.success ? (slots.data.to_date as DateSpec | undefined) : undefined,
        time: slots.success ? (slots.data.to_time as TimeSpec | undefined) : undefined,
      },
      { nowMs: ctx.nowMs },
    );
    if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };

    const found = await findOne(variants, ctx);
    if (found.kind !== 'one') return found.outcome;

    const event = found.event;
    const durationMs = Math.max(0, event.endUtc - event.startUtc);

    return {
      kind: 'ready',
      input: {
        eventId: event.id,
        title: event.title,
        fromStartUtc: event.startUtc,
        startUtc: when.utcMs,
        // The meeting keeps its length: the user moved it, they did not resize it.
        endUtc: when.utcMs + durationMs,
        etag: event.etag,
      },
      needsConfirm: when.needsConfirm,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<MoveInput>(moveInputSchema, rawInput, 'calendar.move_event');
    return eventText.movePreview(
      input.title,
      localPartsOf(input.fromStartUtc, ZONE),
      localPartsOf(input.startUtc, ZONE),
      lang,
    );
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<MoveInput>(moveInputSchema, rawInput, 'calendar.move_event');
    if (!ctx.calendar) return { text: eventText.notConnected(ctx.lang) };

    const result = await ctx.calendar.moveEvent({
      eventId: input.eventId,
      startUtc: input.startUtc,
      endUtc: input.endUtc,
      etag: input.etag,
    });

    if (!result.ok) return { text: failureText(result.error, ctx) };

    return {
      text: eventText.moved(
        result.value.title,
        localPartsOf(result.value.startUtc, ZONE),
        ctx.lang,
      ),
      externalRef: input.eventId,
    };
  },
};

// -- calendar.delete_event ----------------------------------------------------

const deleteInputSchema = z
  .object({
    eventId: z.string().min(1).max(256),
    title: z.string().min(1).max(MAX_TITLE_CHARS),
    startUtc: z.number().int().positive(),
    etag: z.string().max(256).nullable(),
  })
  .strict();

type DeleteInput = z.infer<typeof deleteInputSchema>;

const deleteSlotsSchema = z
  .object({
    query_variants: z.array(z.string()).optional(),
    date: z.unknown().optional(),
    time: z.unknown().optional(),
  })
  .passthrough();

export const calendarDeleteEvent: ToolDefinition = {
  name: 'calendar.delete_event',
  inputSchema: deleteInputSchema,

  resolve(): ResolveOutcome {
    return missing('target');
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    const slots = deleteSlotsSchema.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.query_variants ?? []) : [];
    if (variants.length === 0) return missing('target');

    const found = await findOne(variants, ctx);
    if (found.kind !== 'one') return found.outcome;

    return {
      kind: 'ready',
      input: {
        eventId: found.event.id,
        title: found.event.title,
        startUtc: found.event.startUtc,
        etag: found.event.etag,
      },
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<DeleteInput>(deleteInputSchema, rawInput, 'calendar.delete_event');
    return eventText.deletePreview(input.title, localPartsOf(input.startUtc, ZONE), lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<DeleteInput>(deleteInputSchema, rawInput, 'calendar.delete_event');
    if (!ctx.calendar) return { text: eventText.notConnected(ctx.lang) };

    const result = await ctx.calendar.deleteEvent({ eventId: input.eventId, etag: input.etag });
    return {
      text: result.ok ? eventText.deleted(ctx.lang) : failureText(result.error, ctx),
      externalRef: input.eventId,
    };
  },
};

export const CALENDAR_WRITE_TOOLS = {
  'calendar.create_event': calendarCreateEvent,
  'calendar.move_event': calendarMoveEvent,
  'calendar.delete_event': calendarDeleteEvent,
} as const;

// -- finding the target -------------------------------------------------------

type Found =
  | { kind: 'one'; event: CalendarEvent }
  | { kind: 'other'; outcome: ResolveOutcome };

/**
 * Search the next fortnight for the event the user described.
 *
 * Matching is text matching, done here. The only thing the model contributed is
 * the list of spellings to try.
 */
async function findOne(variants: readonly string[], ctx: ToolContext): Promise<Found> {
  if (!ctx.calendar) {
    return { kind: 'other', outcome: { kind: 'clarify', clarify: { code: 'not_connected' } } };
  }

  const result = await ctx.calendar.listEvents({
    startUtc: ctx.nowMs,
    endUtc: ctx.nowMs + SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000,
    limit: MAX_SEARCH_RESULTS,
  });

  if (!result.ok) {
    const code = result.error.code === 'disconnected' ? 'not_connected' : 'not_found';
    return { kind: 'other', outcome: { kind: 'clarify', clarify: { code } } };
  }

  const matches = matchByText(result.value, variants, (event) => event.title);
  if (matches.length === 0) {
    return { kind: 'other', outcome: { kind: 'clarify', clarify: { code: 'not_found' } } };
  }
  if (matches.length === 1 && matches[0]) return { kind: 'one', event: matches[0] };

  return {
    kind: 'other',
    outcome: {
      kind: 'clarify',
      clarify: {
        code: 'ambiguous',
        choices: matches.slice(0, MAX_CHOICES).map((event) => ({
          id: event.id,
          label: `${formatWhen(localPartsOf(event.startUtc, ZONE), ctx.lang)} — ${event.title}`,
        })),
      },
    },
  };
}

function missing(slot: 'title' | 'target' | 'duration'): ResolveOutcome {
  return { kind: 'clarify', clarify: { code: 'missing_slot', slot } };
}

function failureText(error: CalendarFailure, ctx: ToolContext): string {
  switch (error.code) {
    case 'not_connected':
      return eventText.notConnected(ctx.lang);
    case 'disconnected':
      return eventText.disconnected(ctx.lang);
    case 'changed':
      return eventText.changed(ctx.lang);
    case 'not_found':
      return eventText.gone(ctx.lang);
    default:
      ctx.log.warn('calendar_write_failed', { errorCode: error.code });
      return eventText.unavailable(ctx.lang);
  }
}

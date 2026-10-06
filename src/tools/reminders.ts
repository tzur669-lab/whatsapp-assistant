/**
 * The `reminders.*` tools (PLAN §6.4, §6.7).
 *
 * All three follow the same division. The LLM said what it heard; `resolve`
 * decides what that means, using `src/time/resolve.ts` for every date and
 * matching targets **in code** from `query_variants` — the model never supplies
 * an id (CLAUDE.md invariants 4 and 5).
 *
 * Nothing here defaults a missing slot. A reminder with no time is a question,
 * not a guess at 09:00: a reminder that fires at the wrong hour is worse than
 * one extra message.
 */
import { z } from 'zod';
import { applyMeridiem, DEFAULT_TIME_SETTINGS, resolveWhen } from '../time/resolve.js';
import type { DateSpec, ResolveRule, TimeSpec } from '../time/resolve.js';
import { firstOccurrence } from '../time/recur.js';
import type { RecurRule } from '../time/recur.js';
import { restPeriodAt, upcomingRestTimes } from '../time/shabbat.js';
import { resolveRange } from '../time/range.js';
import type { RangeName } from '../time/range.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { matchByText } from './match.js';
import { planDelivery } from '../policy/window.js';
import { reminderText } from '../render/reminders.js';
import type { ReminderView } from '../render/reminders.js';
import { formatWhen } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import {
  MAX_DESTINATION_CHARS,
  MAX_TITLE_CHARS,
  remindersAtRestSlots,
  remindersLeaveSlots,
  remindersMoveSlots,
  remindersRepeatSlots,
  remindersScheduledReadSlots,
  SCHEDULED_TOPICS,
} from '../nlu/slot-schemas.js';
import type { Reminder } from './reminder-store.js';
import type {
  ExecuteResult,
  ResolveOutcome,
  TargetChoice,
  ToolContext,
  ToolDefinition,
} from './types.js';
import { parseInput } from './types.js';

/** How many upcoming reminders `reminders.list` will show at once. */
const LIST_LIMIT = 20;

/** Above this, "which one?" is a worse question than "say it differently". */
const MAX_CHOICES = 5;

// -- reminders.create ---------------------------------------------------------

const createInputSchema = z
  .object({
    text: z.string().min(1).max(MAX_TITLE_CHARS),
    dueAtUtc: z.number().int().positive(),
    localWallTime: z.string().min(1).max(32),
    tz: z.string().min(1).max(64),
  })
  .strict();

type CreateInput = z.infer<typeof createInputSchema>;

/** A recurring reminder's rule, as stored and as re-validated (B6). */
const recurRuleSchema = z
  .object({
    freq: z.enum(['daily', 'weekly', 'monthly']),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    day: z.number().int().min(1).max(31).optional(),
  })
  .strict();

const createSlotsSchema = z
  .object({
    text: z.string().min(1).max(MAX_TITLE_CHARS).optional(),
    date: z.unknown().optional(),
    time: z.unknown().optional(),
  })
  .passthrough();

export const remindersCreate: ToolDefinition = {
  name: 'reminders.create',
  inputSchema: createInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = createSlotsSchema.safeParse(rawSlots);
    if (!slots.success) return clarifyMissing('text');

    const text = slots.data.text?.trim();
    if (!text) return clarifyMissing('text');

    const when = resolveWhen(
      {
        date: slots.data.date as DateSpec | undefined,
        time: slots.data.time as TimeSpec | undefined,
      },
      { nowMs: ctx.nowMs },
    );
    if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };

    const input: CreateInput = {
      text,
      dueAtUtc: when.utcMs,
      localWallTime: wallTimeString(when.utcMs, when.zone),
      tz: when.zone,
    };
    // R8: a reminder a year out is more likely a typo than a plan.
    return { kind: 'ready', input, needsConfirm: when.needsConfirm };
  },

  preview(rawInput, lang): string {
    const input = parseInput<CreateInput>(createInputSchema, rawInput, 'reminders.create');
    return reminderText.created(viewOf(input), lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<CreateInput>(createInputSchema, rawInput, 'reminders.create');
    return scheduleOne(input, ctx);
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    return undoCreate(compensating, ctx);
  },
};

/**
 * Schedule one reminder and say so. `place` is set only by `reminders.leave`
 * (ROADMAP #5): the input schemas of the other tools have no such field.
 */
async function scheduleOne(input: CreateInput, ctx: ToolContext, place?: string): Promise<ExecuteResult> {
  const reminder = ctx.reminders.schedule({
    principal: ctx.principal,
    text: input.text,
    dueAtUtc: input.dueAtUtc,
    localWallTime: input.localWallTime,
    tz: input.tz,
    ...(place ? { place } : {}),
  });

  // Which channel it will arrive on is decided now, not when it comes due:
  // outside the window nothing but a paid template gets through, so that is a
  // send that must never be attempted rather than one that fails (§6.7).
  const plan = planDelivery({
    dueAtUtc: input.dueAtUtc,
    lastInboundAt: ctx.lastInboundAt,
    nowMs: ctx.nowMs,
    monthlySent: ctx.monthlySent,
    ...(ctx.channel ? { channel: ctx.channel } : {}),
  });

  const view = viewOf(input);

  // Out of window, a WhatsApp send is not a send that fails — it is one that
  // must never be attempted. A calendar popup is the delivery instead, and it
  // is written now rather than discovered missing when the reminder is due.
  const backupEventId =
    plan.channel === 'calendar' ? await writeBackupEvent(input, ctx) : null;
  if (backupEventId) ctx.reminders.setBackupEvent(reminder.id, backupEventId);

  return {
    text:
      plan.channel === 'calendar'
        ? reminderText.createdViaCalendar(view, ctx.lang)
        : reminderText.created(view, ctx.lang),
    compensating: { reminderId: reminder.id },
    externalRef: reminder.id,
    rescheduleAlarm: true,
  };
}

async function undoCreate(compensating: unknown, ctx: ToolContext): Promise<ExecuteResult> {
  const { reminderId } = parseInput<{ reminderId: string }>(
    z.object({ reminderId: z.string().min(1).max(64) }).strict(),
    compensating,
    'reminders.create',
  );
  await dropBackupEvent(reminderId, ctx);
  ctx.reminders.cancel(reminderId, ctx.principal);
  return { text: reminderText.undoneCreate(ctx.lang), rescheduleAlarm: true };
}

// -- reminders.list -----------------------------------------------------------

const listInputSchema = z
  .object({ range: z.enum(['this_week', 'next_week', 'weekend']).optional() })
  .strict();

type ListInput = z.infer<typeof listInputSchema>;

export const remindersList: ToolDefinition = {
  name: 'reminders.list',
  inputSchema: listInputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = listInputSchema.safeParse(stripUnknown(rawSlots, ['range']));
    // A list with no range is the whole point of asking; an unreadable range
    // is not worth a question, so it degrades to "everything upcoming".
    return { kind: 'ready', input: slots.success ? slots.data : {} };
  },

  preview(rawInput, lang): string {
    void rawInput;
    return lang === 'he' ? 'הצגת התזכורות' : 'Show reminders';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ListInput>(listInputSchema, rawInput, 'reminders.list');
    const all = ctx.reminders.listUpcoming(ctx.principal, LIST_LIMIT);

    const shown = input.range ? withinRange(all, input.range, ctx.nowMs) : all;
    const text = reminderText.list(shown.map(viewOfReminder), ctx.lang);
    // A "time to leave" reminder's text holds a calendar title (ROADMAP #5).
    return { text, ...(shown.some((reminder) => reminder.place) ? { tainting: true as const } : {}) };
  },
};

// -- reminders.cancel ---------------------------------------------------------

const cancelInputSchema = z
  .object({
    reminderId: z.string().min(1).max(64),
    text: z.string().min(1).max(MAX_TITLE_CHARS),
    dueAtUtc: z.number().int().positive(),
    tz: z.string().min(1).max(64),
    /** Present when it repeats: the preview says the whole series ends (B6). */
    rule: recurRuleSchema.optional(),
  })
  .strict();

type CancelInput = z.infer<typeof cancelInputSchema>;

const cancelSlotsSchema = z
  .object({
    query_variants: z.array(z.string()).optional(),
    date: z.unknown().optional(),
  })
  .passthrough();

export const remindersCancel: ToolDefinition = {
  name: 'reminders.cancel',
  inputSchema: cancelInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = cancelSlotsSchema.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.query_variants ?? []) : [];

    const pending = ctx.reminders.listUpcoming(ctx.principal, LIST_LIMIT);
    if (pending.length === 0) return { kind: 'clarify', clarify: { code: 'nothing_scheduled' } };

    // One pending reminder and no description is not ambiguous — but it is also
    // not what the user asked for, so it still goes through the Tier 2
    // confirmation below rather than being cancelled on a guess.
    if (variants.length === 0) {
      return pending.length === 1 && pending[0]
        ? { kind: 'ready', input: cancelInputOf(pending[0]) }
        : clarifyMissing('target');
    }

    const matches = matchByText(pending, variants, (reminder) => reminder.text);
    if (matches.length === 0) return { kind: 'clarify', clarify: { code: 'not_found' } };
    if (matches.length === 1 && matches[0]) {
      return { kind: 'ready', input: cancelInputOf(matches[0]) };
    }

    return {
      kind: 'clarify',
      clarify: { code: 'ambiguous', choices: choicesOf(matches.slice(0, MAX_CHOICES), 'he') },
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<CancelInput>(cancelInputSchema, rawInput, 'reminders.cancel');
    return reminderText.cancelPreview(
      {
        id: input.reminderId,
        text: input.text,
        local: localPartsOf(input.dueAtUtc, input.tz),
        ...(input.rule ? { rule: input.rule } : {}),
      },
      lang,
    );
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<CancelInput>(cancelInputSchema, rawInput, 'reminders.cancel');

    // Between the preview and the tap the reminder may have fired or been
    // cancelled elsewhere. Say so rather than reporting a cancel that did not
    // happen (PLAN §6.5 step 4).
    await dropBackupEvent(input.reminderId, ctx);
    const cancelled = ctx.reminders.cancel(input.reminderId, ctx.principal);
    return {
      text: cancelled
        ? reminderText.cancelled(ctx.lang)
        : ctx.lang === 'he'
          ? 'התזכורת כבר לא ממתינה — היא נשלחה או בוטלה בינתיים.'
          : 'That reminder is no longer pending — it fired or was cancelled already.',
      externalRef: input.reminderId,
      rescheduleAlarm: true,
    };
  },
};

// -- reminders.repeat (B6) ----------------------------------------------------

const repeatInputSchema = createInputSchema.extend({ rule: recurRuleSchema }).strict();

type RepeatInput = z.infer<typeof repeatInputSchema>;

export const remindersRepeat: ToolDefinition = {
  name: 'reminders.repeat',
  inputSchema: repeatInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = remindersRepeatSlots.safeParse(rawSlots);
    if (!slots.success) return clarifyMissing('text');

    const text = slots.data.text?.trim();
    if (!text) return clarifyMissing('text');

    const resolved = resolveRule(slots.data, ctx.nowMs);
    if (resolved.kind === 'clarify') return resolved;

    const input: RepeatInput = { text, ...resolved.at };
    return { kind: 'ready', input };
  },

  preview(rawInput, lang): string {
    const input = parseInput<RepeatInput>(repeatInputSchema, rawInput, 'reminders.repeat');
    return reminderText.createdRepeat({ ...viewOf(input), rule: input.rule }, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<RepeatInput>(repeatInputSchema, rawInput, 'reminders.repeat');

    // No calendar stand-in: the app has no 24-hour window, and WhatsApp, which
    // needed one, is frozen (§6.18). A series of backup events is not worth
    // building for a channel that is off.
    const reminder = ctx.reminders.schedule({
      principal: ctx.principal,
      text: input.text,
      dueAtUtc: input.dueAtUtc,
      localWallTime: input.localWallTime,
      tz: input.tz,
      rule: input.rule,
    });

    return {
      text: reminderText.createdRepeat({ ...viewOf(input), rule: input.rule }, ctx.lang),
      compensating: { reminderId: reminder.id, seriesId: reminder.seriesId },
      externalRef: reminder.id,
      rescheduleAlarm: true,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { seriesId } = parseInput<{ reminderId: string; seriesId: string }>(
      z.object({ reminderId: z.string().min(1).max(64), seriesId: z.string().min(1).max(64) }).strict(),
      compensating,
      'reminders.repeat',
    );
    // By series: by the time Undo is tapped the first one may have fired and
    // been followed by the next.
    ctx.reminders.cancelSeries(seriesId, ctx.principal);
    return { text: reminderText.undoneCreate(ctx.lang), rescheduleAlarm: true };
  },
};

type RuleSlots = Pick<z.infer<typeof remindersRepeatSlots>, 'time' | 'every' | 'weekdays' | 'day_of_month'>;

/**
 * The rule and its first occurrence, or the question to ask. Shared by
 * `reminders.repeat` and `reminders.scheduled_read`, so both read a time and
 * a "how often" by exactly the same rules.
 */
function resolveRule(
  slots: RuleSlots,
  nowMs: number,
): { kind: 'ok'; at: Omit<RepeatInput, 'text'> } | Extract<ResolveOutcome, { kind: 'clarify' }> {
  // R3: never invent a time. R4 and R5 exactly as a one-off reminder has them.
  const time = slots.time;
  if (!time) return clarifyTime('R3', 'missing_time');
  const adjusted = applyMeridiem(time);
  if (!adjusted) return clarifyTime('R4', 'invalid_time');
  if (
    adjusted.hour >= DEFAULT_TIME_SETTINGS.unlikelyHourStart &&
    adjusted.hour < DEFAULT_TIME_SETTINGS.unlikelyHourEnd &&
    time.meridiem === 'unspecified' &&
    time.part_of_day === 'unspecified'
  ) {
    return clarifyTime('R5', 'unlikely_hour');
  }

  const rule = ruleOf(slots, adjusted);
  // "Every what?" is asked without an open question: the answer is a rule,
  // which no answer parser reads, so the agent takes it from history.
  if (!rule) return clarifyMissing('date');

  const first = firstOccurrence(rule, nowMs, ZONE);
  if (first.kind === 'gap' || first.kind === 'fold') return clarifyTime('R2', 'recurring_dst');
  if (first.kind === 'never') return clarifyMissing('date');

  return {
    kind: 'ok',
    at: { dueAtUtc: first.utcMs, localWallTime: wallTimeString(first.utcMs, ZONE), tz: ZONE, rule },
  };
}

/** The rule the slots describe, or null when they do not say how often. */
function ruleOf(
  slots: RuleSlots,
  at: { hour: number; minute: number },
): RecurRule | null {
  const weekdays = slots.weekdays ? [...new Set(slots.weekdays)].sort((a, b) => a - b) : undefined;
  const every = slots.every ?? (weekdays ? 'week' : slots.day_of_month ? 'month' : undefined);

  // Named days win over "every day": "כל יום ראשון" is a weekly rule.
  if (weekdays && every !== 'month') {
    return weekdays.length === 7
      ? { freq: 'daily', ...at }
      : { freq: 'weekly', ...at, weekdays };
  }
  if (every === 'day') return { freq: 'daily', ...at };
  if (every === 'month' && slots.day_of_month) return { freq: 'monthly', ...at, day: slots.day_of_month };
  return null;
}

function clarifyTime(rule: ResolveRule, reason: string): Extract<ResolveOutcome, { kind: 'clarify' }> {
  return { kind: 'clarify', clarify: { code: 'time', detail: { kind: 'clarify', rule, reason } } };
}

// -- reminders.scheduled_read (ROADMAP #7) -------------------------------------
//
// "Send me the weather every morning at 7." A recurring reminder whose
// occurrence carries a closed action: at the due time code runs the lookup and
// sends what it renders (`src/core/scheduled-read.ts`). No model is involved
// then, and nothing but the topic is stored — no text the model wrote.

const scheduledReadInputSchema = createInputSchema
  .extend({ rule: recurRuleSchema, action: z.enum(SCHEDULED_TOPICS) })
  .strict();

type ScheduledReadInput = z.infer<typeof scheduledReadInputSchema>;

export const remindersScheduledRead: ToolDefinition = {
  name: 'reminders.scheduled_read',
  inputSchema: scheduledReadInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = remindersScheduledReadSlots.safeParse(rawSlots);
    if (!slots.success || !slots.data.topic) return clarifyMissing('target');

    const resolved = resolveRule(slots.data, ctx.nowMs);
    if (resolved.kind === 'clarify') return resolved;

    // The label is code's, in the language of the turn: it is what the list
    // shows and what a later "cancel the weather" is matched against.
    const input: ScheduledReadInput = {
      text: reminderText.scheduledLabel(slots.data.topic, ctx.lang),
      ...resolved.at,
      action: slots.data.topic,
    };
    return { kind: 'ready', input };
  },

  preview(rawInput, lang): string {
    const input = parseInput<ScheduledReadInput>(scheduledReadInputSchema, rawInput, 'reminders.scheduled_read');
    return reminderText.createdScheduledRead({ ...viewOf(input), rule: input.rule }, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ScheduledReadInput>(scheduledReadInputSchema, rawInput, 'reminders.scheduled_read');
    const reminder = ctx.reminders.schedule({
      principal: ctx.principal,
      text: input.text,
      dueAtUtc: input.dueAtUtc,
      localWallTime: input.localWallTime,
      tz: input.tz,
      rule: input.rule,
      action: input.action,
    });

    return {
      text: reminderText.createdScheduledRead({ ...viewOf(input), rule: input.rule }, ctx.lang),
      compensating: { reminderId: reminder.id, seriesId: reminder.seriesId },
      externalRef: reminder.id,
      rescheduleAlarm: true,
    };
  },

  // The same Undo as a repeat: the whole series.
  undo: (compensating, ctx) => remindersRepeat.undo!(compensating, ctx),
};

// -- reminders.move (B8) ------------------------------------------------------

const moveInputSchema = z
  .object({
    reminderId: z.string().min(1).max(64),
    text: z.string().min(1).max(MAX_TITLE_CHARS),
    fromDueAtUtc: z.number().int().positive(),
    dueAtUtc: z.number().int().positive(),
    localWallTime: z.string().min(1).max(32),
    tz: z.string().min(1).max(64),
    recurring: z.boolean(),
  })
  .strict();

type MoveInput = z.infer<typeof moveInputSchema>;

export const remindersMove: ToolDefinition = {
  name: 'reminders.move',
  inputSchema: moveInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = remindersMoveSlots.safeParse(rawSlots);
    const data = slots.success ? slots.data : {};

    const target = findPending(data.query_variants ?? [], ctx);
    if (!('reminder' in target)) return target.outcome;
    const reminder = target.reminder;

    if (!data.to_date && !data.to_time) return clarifyMissing('time');

    // What was not said stays as it was: "לשעה 5" keeps the day, "למחר" the hour.
    const current = localPartsOf(reminder.dueAtUtc, reminder.tz);
    const date: DateSpec = data.to_date ?? {
      kind: 'absolute',
      day: current.day,
      month: current.month,
      year: current.year,
    };
    const time: TimeSpec = data.to_time ?? {
      hour: current.hour,
      minute: current.minute,
      // The stored hour is already on the 24-hour clock; saying so keeps R5
      // from asking about a time the user set and did not mention.
      meridiem: current.hour < 12 ? 'am' : 'pm',
      part_of_day: 'unspecified',
    };

    const when = resolveWhen({ date, time }, { nowMs: ctx.nowMs });
    if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };

    const input: MoveInput = {
      reminderId: reminder.id,
      text: reminder.text,
      fromDueAtUtc: reminder.dueAtUtc,
      dueAtUtc: when.utcMs,
      localWallTime: wallTimeString(when.utcMs, when.zone),
      tz: when.zone,
      recurring: reminder.seriesId !== null,
    };
    return { kind: 'ready', input, needsConfirm: when.needsConfirm };
  },

  preview(rawInput, lang): string {
    const input = parseInput<MoveInput>(moveInputSchema, rawInput, 'reminders.move');
    return reminderText.movePreview(
      {
        id: input.reminderId,
        text: input.text,
        local: localPartsOf(input.fromDueAtUtc, input.tz),
        // Only whether it repeats matters to the preview, not the rule itself.
        ...(input.recurring ? { rule: { freq: 'daily' as const, hour: 0, minute: 0 } } : {}),
      },
      localPartsOf(input.dueAtUtc, input.tz),
      lang,
    );
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<MoveInput>(moveInputSchema, rawInput, 'reminders.move');

    // The stand-in was written for the old time. WhatsApp, which needed it, is
    // frozen, so it is removed rather than rewritten (§6.18).
    await dropBackupEvent(input.reminderId, ctx);
    const moved = ctx.reminders.reschedule(
      input.reminderId,
      ctx.principal,
      input.dueAtUtc,
      input.localWallTime,
    );
    return {
      text: moved
        ? reminderText.moved(localPartsOf(input.dueAtUtc, input.tz), ctx.lang)
        : reminderText.noLongerPending(ctx.lang),
      externalRef: input.reminderId,
      rescheduleAlarm: true,
    };
  },
};

// -- reminders.at_rest (2026-10-05) -------------------------------------------

const atRestInputSchema = createInputSchema.extend({ held: z.boolean() }).strict();

type AtRestInput = z.infer<typeof atRestInputSchema>;

export const remindersAtRest: ToolDefinition = {
  name: 'reminders.at_rest',
  inputSchema: atRestInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = remindersAtRestSlots.safeParse(rawSlots);
    if (!slots.success) return clarifyMissing('text');

    const text = slots.data.text?.trim();
    if (!text) return clarifyMissing('text');
    const event = slots.data.event;
    if (!event) return clarifyMissing('date');

    const dueAtUtc = restEventTime(event, slots.data.minutes ?? 0, ctx.nowMs);
    if (dueAtUtc === null) return clarifyMissing('date');

    const input: AtRestInput = {
      text,
      dueAtUtc,
      localWallTime: wallTimeString(dueAtUtc, ZONE),
      tz: ZONE,
      // A chag running into Shabbat or out of it puts some of these times
      // inside the hold. Still set; the reply says it will come at the end.
      held: ctx.repo.restHoldEnabled() && restPeriodAt(dueAtUtc) !== null,
    };
    return { kind: 'ready', input };
  },

  preview(rawInput, lang): string {
    const input = parseInput<AtRestInput>(atRestInputSchema, rawInput, 'reminders.at_rest');
    return withHeldNote(remindersCreate.preview(createPart(input), lang), input.held, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<AtRestInput>(atRestInputSchema, rawInput, 'reminders.at_rest');
    const result = await remindersCreate.execute(createPart(input), ctx);
    return { ...result, text: withHeldNote(result.text, input.held, ctx.lang) };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    return remindersCreate.undo!(compensating, ctx);
  },
};

/** Minutes before a start or after an end; the earliest of those still ahead. */
function restEventTime(
  event: 'shabbat_start' | 'shabbat_end' | 'chag_start' | 'chag_end',
  minutes: number,
  nowMs: number,
): number | null {
  const which = event.startsWith('shabbat') ? 'shabbat' : 'chag';
  const atStart = event.endsWith('_start');
  // "At candle lighting" is a minute before it: at the start itself it would
  // be inside the hold and arrive a day late.
  const offsetMs = (atStart ? -Math.max(minutes, 1) : minutes) * 60_000;

  for (const times of upcomingRestTimes(nowMs, which)) {
    const dueAtUtc = (atStart ? times.startUtc : times.endUtc) + offsetMs;
    if (dueAtUtc > nowMs + 60_000) return dueAtUtc;
  }
  return null;
}

function createPart(input: AtRestInput): CreateInput {
  return { text: input.text, dueAtUtc: input.dueAtUtc, localWallTime: input.localWallTime, tz: input.tz };
}

function withHeldNote(text: string, held: boolean, lang: Lang): string {
  return held ? `${text}\n\n${reminderText.heldNote(lang)}` : text;
}

// -- reminders.leave (ROADMAP #5, 2026-10-06) ---------------------------------

/** The user's decision (2026-10-06): no travel time said is half an hour. */
export const DEFAULT_TRAVEL_MINUTES = 30;
/** How far ahead an event to leave for is looked for, as `nav.go` does. */
const LEAVE_EVENT_DAYS = 7;

const leaveInputSchema = createInputSchema
  .extend({
    place: z.string().min(1).max(MAX_DESTINATION_CHARS).optional(),
    eventStartUtc: z.number().int().positive(),
    minutes: z.number().int().min(5).max(240),
    held: z.boolean(),
  })
  .strict();

type LeaveInput = z.infer<typeof leaveInputSchema>;

/**
 * "Remind me when to leave for the meeting with Dani": the event is found in
 * code (its title's words, or the next timed one), and the reminder is set the
 * travel time before it starts. At the due time it carries a Waze card to the
 * event's place, when it has one. No traffic API: the time is the user's, or
 * half an hour. A calendar title is someone else's words: every reply taints.
 */
export const remindersLeave: ToolDefinition = {
  name: 'reminders.leave',
  inputSchema: leaveInputSchema,

  resolve(): ResolveOutcome {
    // Only the async path can see the calendar.
    return { kind: 'clarify', clarify: { code: 'not_connected' } };
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    const parsed = remindersLeaveSlots.safeParse(rawSlots);
    if (!parsed.success) return clarifyMissing('target');
    const slots = parsed.data;
    if (!slots.event && slots.next_event !== true) return clarifyMissing('target');
    if (!ctx.calendar) return { kind: 'clarify', clarify: { code: 'not_connected' } };

    const listed = await ctx.calendar.listAllEvents({
      startUtc: ctx.nowMs,
      endUtc: ctx.nowMs + LEAVE_EVENT_DAYS * 86_400_000,
      limit: 50,
    });
    if (!listed.ok) {
      return listed.error.code === 'not_connected' || listed.error.code === 'disconnected'
        ? { kind: 'clarify', clarify: { code: 'not_connected' } }
        : { kind: 'clarify', clarify: { code: 'not_found' } };
    }
    // A timed event still to start; an all-day one has no hour to leave by.
    const timed = listed.value
      .filter((event) => !event.allDay && event.startUtc > ctx.nowMs)
      .sort((a, b) => a.startUtc - b.startUtc);
    const candidates = slots.event ? matchByText(timed, slots.event, (event) => event.title) : timed;
    const target = candidates[0];
    if (!target) return { kind: 'clarify', clarify: { code: 'not_found' } };

    const minutes = slots.minutes ?? DEFAULT_TRAVEL_MINUTES;
    const dueAtUtc = target.startUtc - minutes * 60_000;
    if (dueAtUtc <= ctx.nowMs + 60_000) return { kind: 'clarify', clarify: { code: 'leave_too_late' }, tainting: true };

    const input: LeaveInput = {
      text: reminderText.leaveLabel(target.title, ctx.lang),
      dueAtUtc,
      localWallTime: wallTimeString(dueAtUtc, ZONE),
      tz: ZONE,
      ...(target.location ? { place: target.location.slice(0, MAX_DESTINATION_CHARS) } : {}),
      eventStartUtc: target.startUtc,
      minutes,
      held: ctx.repo.restHoldEnabled() && restPeriodAt(dueAtUtc) !== null,
    };
    return { kind: 'ready', input, tainting: true };
  },

  preview(rawInput, lang): string {
    const input = parseInput<LeaveInput>(leaveInputSchema, rawInput, 'reminders.leave');
    return withHeldNote(leaveText(input, lang), input.held, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<LeaveInput>(leaveInputSchema, rawInput, 'reminders.leave');
    const result = await scheduleOne(
      { text: input.text, dueAtUtc: input.dueAtUtc, localWallTime: input.localWallTime, tz: input.tz },
      ctx,
      input.place,
    );
    return { ...result, text: withHeldNote(leaveText(input, ctx.lang), input.held, ctx.lang), tainting: true };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    return undoCreate(compensating, ctx);
  },
};

function leaveText(input: LeaveInput, lang: Lang): string {
  return reminderText.createdLeave(
    {
      text: input.text,
      leave: localPartsOf(input.dueAtUtc, input.tz),
      start: localPartsOf(input.eventStartUtc, input.tz),
      minutes: input.minutes,
      hasPlace: input.place !== undefined,
    },
    lang,
  );
}

/** One pending reminder by description, the way `reminders.cancel` finds it. */
function findPending(
  variants: readonly string[],
  ctx: ToolContext,
): { reminder: Reminder } | { outcome: ResolveOutcome } {
  const pending = ctx.reminders.listUpcoming(ctx.principal, LIST_LIMIT);
  if (pending.length === 0) return { outcome: { kind: 'clarify', clarify: { code: 'nothing_scheduled' } } };

  if (variants.length === 0) {
    return pending.length === 1 && pending[0]
      ? { reminder: pending[0] }
      : { outcome: clarifyMissing('target') };
  }

  const matches = matchByText(pending, variants, (reminder) => reminder.text);
  if (matches.length === 0) return { outcome: { kind: 'clarify', clarify: { code: 'not_found' } } };
  if (matches.length === 1 && matches[0]) return { reminder: matches[0] };
  return {
    outcome: {
      kind: 'clarify',
      clarify: { code: 'ambiguous', choices: choicesOf(matches.slice(0, MAX_CHOICES), 'he') },
    },
  };
}

/** Kept as a named export: the reminder matching has its own tests. */
export function matchReminders(
  reminders: readonly Reminder[],
  variants: readonly string[],
): Reminder[] {
  return matchByText(reminders, variants, (reminder) => reminder.text);
}

export const REMINDER_TOOLS = {
  'reminders.create': remindersCreate,
  'reminders.list': remindersList,
  'reminders.cancel': remindersCancel,
  'reminders.repeat': remindersRepeat,
  'reminders.move': remindersMove,
  'reminders.at_rest': remindersAtRest,
  'reminders.scheduled_read': remindersScheduledRead,
  'reminders.leave': remindersLeave,
} as const;

// -- the calendar fallback ----------------------------------------------------

/**
 * Put the reminder on the app-created calendar as a popup.
 *
 * Returns null when Google is not connected — the reminder still exists and
 * will be delivered late once the window reopens. A missing fallback is worse
 * than a late reminder, but it is not worth failing the whole request for.
 */
async function writeBackupEvent(input: CreateInput, ctx: ToolContext): Promise<string | null> {
  if (!ctx.calendar) return null;

  const calendarId = await ctx.calendar.remindersCalendarId();
  if (!calendarId.ok) {
    ctx.log.warn('reminder_backup_calendar_failed', { errorCode: calendarId.error.code });
    return null;
  }

  const created = await ctx.calendar.createEvent({
    title: input.text,
    startUtc: input.dueAtUtc,
    endUtc: input.dueAtUtc + BACKUP_EVENT_MINUTES * 60_000,
    calendarId: calendarId.value,
    popupAtStart: true,
  });

  if (!created.ok) {
    ctx.log.warn('reminder_backup_event_failed', { errorCode: created.error.code });
    return null;
  }
  return created.value.id;
}

/** Remove a backup event when its reminder is cancelled, undone, or delivered. */
export async function dropBackupEvent(reminderId: string, ctx: ToolContext): Promise<void> {
  const reminder = ctx.reminders.byId(reminderId);
  if (!reminder?.backupEventId || !ctx.calendar) return;

  const calendarId = await ctx.calendar.remindersCalendarId();
  if (!calendarId.ok) return;

  await ctx.calendar.deleteEvent({
    eventId: reminder.backupEventId,
    calendarId: calendarId.value,
  });
  ctx.reminders.setBackupEvent(reminderId, null);
}

/** A reminder is a moment, not a span; Google still wants an end. */
const BACKUP_EVENT_MINUTES = 5;

// -- helpers ------------------------------------------------------------------

function clarifyMissing(slot: 'text' | 'target' | 'time' | 'date'): Extract<ResolveOutcome, { kind: 'clarify' }> {
  return { kind: 'clarify', clarify: { code: 'missing_slot', slot } };
}

function withinRange(
  reminders: readonly Reminder[],
  range: RangeName,
  nowMs: number,
): Reminder[] {
  const { startUtc, endUtc } = resolveRange(range, nowMs);
  return reminders.filter((r) => r.dueAtUtc >= startUtc && r.dueAtUtc < endUtc);
}

function cancelInputOf(reminder: Reminder): CancelInput {
  return {
    reminderId: reminder.id,
    text: reminder.text,
    dueAtUtc: reminder.dueAtUtc,
    tz: reminder.tz,
    ...(reminder.rule ? { rule: reminder.rule } : {}),
  };
}

function choicesOf(reminders: readonly Reminder[], lang: Lang): TargetChoice[] {
  return reminders.map((reminder) => ({
    id: reminder.id,
    label: `${formatFor(reminder, lang)} — ${reminder.text}`,
  }));
}

function formatFor(reminder: Reminder, lang: Lang): string {
  return formatWhen(localPartsOf(reminder.dueAtUtc, reminder.tz), lang);
}

function viewOf(input: CreateInput): ReminderView {
  return { id: '', text: input.text, local: localPartsOf(input.dueAtUtc, input.tz) };
}

function viewOfReminder(reminder: Reminder): ReminderView {
  return {
    id: reminder.id,
    text: reminder.text,
    local: localPartsOf(reminder.dueAtUtc, reminder.tz),
    ...(reminder.rule ? { rule: reminder.rule } : {}),
  };
}

/** `2026-09-25T14:00` — the wall time, stored beside the instant (PLAN §6.8). */
function wallTimeString(utcMs: number, zone: string): string {
  const p = localPartsOf(utcMs, zone || ZONE);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

function stripUnknown(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (record[key] !== undefined) out[key] = record[key];
  }
  return out;
}

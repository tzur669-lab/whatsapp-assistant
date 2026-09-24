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
import { resolveWhen } from '../time/resolve.js';
import type { DateSpec, TimeSpec } from '../time/resolve.js';
import { resolveRange } from '../time/range.js';
import type { RangeName } from '../time/range.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { normalizeHebrew } from '../time/hebrew-lexicon.js';
import { planDelivery } from '../policy/window.js';
import { reminderText } from '../render/reminders.js';
import type { ReminderView } from '../render/reminders.js';
import { formatWhen } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { MAX_TITLE_CHARS } from '../nlu/slot-schemas.js';
import type { Reminder } from './reminder-store.js';
import type {
  ExecuteResult,
  ResolveOutcome,
  TargetChoice,
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

    const reminder = ctx.reminders.schedule({
      principal: ctx.principal,
      text: input.text,
      dueAtUtc: input.dueAtUtc,
      localWallTime: input.localWallTime,
      tz: input.tz,
    });

    // Which channel it will arrive on is decided now, not when it comes due:
    // outside the window nothing but a paid template gets through, so that is a
    // send that must never be attempted rather than one that fails (§6.7).
    const plan = planDelivery({
      dueAtUtc: input.dueAtUtc,
      lastInboundAt: ctx.lastInboundAt,
      nowMs: ctx.nowMs,
      monthlySent: ctx.monthlySent,
    });

    const view = viewOf(input);
    return {
      text:
        plan.channel === 'whatsapp'
          ? reminderText.created(view, ctx.lang)
          : reminderText.createdViaCalendar(view, ctx.lang),
      compensating: { reminderId: reminder.id },
      externalRef: reminder.id,
      rescheduleAlarm: true,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { reminderId } = parseInput<{ reminderId: string }>(
      z.object({ reminderId: z.string().min(1).max(64) }).strict(),
      compensating,
      'reminders.create',
    );
    ctx.reminders.cancel(reminderId, ctx.principal);
    return { text: reminderText.undoneCreate(ctx.lang), rescheduleAlarm: true };
  },
};

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
    return { text: reminderText.list(shown.map(viewOfReminder), ctx.lang) };
  },
};

// -- reminders.cancel ---------------------------------------------------------

const cancelInputSchema = z
  .object({
    reminderId: z.string().min(1).max(64),
    text: z.string().min(1).max(MAX_TITLE_CHARS),
    dueAtUtc: z.number().int().positive(),
    tz: z.string().min(1).max(64),
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

    const matches = matchReminders(pending, variants);
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
      { id: input.reminderId, text: input.text, local: localPartsOf(input.dueAtUtc, input.tz) },
      lang,
    );
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<CancelInput>(cancelInputSchema, rawInput, 'reminders.cancel');

    // Between the preview and the tap the reminder may have fired or been
    // cancelled elsewhere. Say so rather than reporting a cancel that did not
    // happen (PLAN §6.5 step 4).
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

export const REMINDER_TOOLS = {
  'reminders.create': remindersCreate,
  'reminders.list': remindersList,
  'reminders.cancel': remindersCancel,
} as const;

// -- matching -----------------------------------------------------------------

/**
 * Find the reminders a description refers to.
 *
 * Matching is substring-based over normalized text, in both directions: the
 * user says "אבא" for "להתקשר לאבא", and "להתקשר לאבא בערב" for "להתקשר לאבא".
 * Hebrew normalization strips nikud and folds final letters, because
 * "להתקשר לאמא" and "לאמא" differ by a final mem.
 */
export function matchReminders(
  reminders: readonly Reminder[],
  variants: readonly string[],
): Reminder[] {
  const needles = variants
    .map((variant) => foldForMatch(variant))
    .filter((variant) => variant.length > 0);
  if (needles.length === 0) return [];

  return reminders.filter((reminder) => {
    const haystack = foldForMatch(reminder.text);
    return needles.some((needle) => haystack.includes(needle) || needle.includes(haystack));
  });
}

/** Final letters fold to their base form, so a suffix cannot break a match. */
const FINAL_FORMS: Readonly<Record<string, string>> = {
  'ך': 'כ', // ך -> כ
  'ם': 'מ', // ם -> מ
  'ן': 'נ', // ן -> נ
  'ף': 'פ', // ף -> פ
  'ץ': 'צ', // ץ -> צ
};

function foldForMatch(value: string): string {
  return normalizeHebrew(value)
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (letter) => FINAL_FORMS[letter] ?? letter)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// -- helpers ------------------------------------------------------------------

function clarifyMissing(slot: 'text' | 'target'): ResolveOutcome {
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

/**
 * `reminders.when` (block J, J4, PLAN §6.30): "כשמגיע מייל מ-DHL, תזכיר לי
 * לבדוק את המשלוח". Tier 1: creating a watch only echoes the user's own words,
 * so Undo is enough; a tainted turn confirms (policy).
 *
 * Offered only in the app (there is no outbox on WhatsApp) and only when the
 * words say "when … arrives" (`namesWatch`); never in the full catalog. The
 * phone matches notifications and SMS itself; Gmail matches mail on the tick.
 */
import { z } from 'zod';
import { remindersWhenSlots } from '../nlu/slot-schemas.js';
import { normalizeHebrew } from '../time/hebrew-lexicon.js';
import { personalQuestion } from '../render/personal.js';
import { watchText } from '../render/watches.js';
import { normalizeWatchText } from '../core/watch-match.js';
import { parseInput } from './types.js';
import type { ExecuteResult, PersonalQuestion, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';
import { WATCH_DEFAULT_DAYS, WATCH_MAX_DAYS, WATCH_REPEAT_FIRES, WATCH_SOURCES } from './watch-store.js';
import type { WatchStore } from './watch-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The words that offer `reminders.when`: "כש… יגיע/תגיע/מגיע/ייכנס/אקבל",
 * "when … arrives / comes in / I get". Code only: the flag never adds a tool
 * on its own, the pipeline also requires the app channel.
 */
const WATCH_WORDS = [
  /(?:^|\s)(?:ו)?כש\S*(?:\s+\S+){0,8}?\s*(?:י|ת|נ)?(?:גיע|מגיע|מגיעה|יגיעו|גיעו|נכנס|נכנסת|ייכנס|יכנס|תיכנס|אקבל|יופיע|תופיע|יבוא|תבוא)/,
  /\bwhen(?:ever)?\b.{0,80}\b(?:arrives?|comes? in|i get|i receive|shows? up)\b/i,
];

export function namesWatch(text: string): boolean {
  const normalized = normalizeHebrew(text);
  return WATCH_WORDS.some((pattern) => pattern.test(normalized));
}

const inputSchema = z
  .object({
    source: z.enum(WATCH_SOURCES),
    said: z.array(z.string().min(1).max(30)).min(1).max(3),
    sender: z.string().min(1).max(40).nullable(),
    text: z.string().min(1).max(200),
    repeat: z.boolean(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type WatchInput = z.infer<typeof inputSchema>;

const ask = (what: PersonalQuestion): ResolveOutcome => ({ kind: 'clarify', clarify: { code: 'personal', what } });

function storeOf(ctx: ToolContext): WatchStore {
  if (!ctx.watches) throw new Error('E_WATCHES_UNAVAILABLE');
  return ctx.watches;
}

export const remindersWhen: ToolDefinition = {
  name: 'reminders.when',
  inputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    if (ctx.channel !== 'app' || !ctx.watches) return ask('watch_app_only');
    const parsed = remindersWhenSlots.safeParse(rawSlots);
    if (!parsed.success) return ask('watch_keywords');
    const slots = parsed.data;
    if (!slots.source) return ask('watch_source');
    // A keyword that normalizes to nothing ("!!") could never match.
    const said = (slots.keywords ?? []).map((word) => word.trim()).filter((word) => normalizeWatchText(word).length > 0);
    if (said.length === 0) return ask('watch_keywords');
    const text = slots.text?.trim();
    if (!text) return ask('watch_text');
    const days = Math.min(slots.days ?? WATCH_DEFAULT_DAYS, WATCH_MAX_DAYS);
    return {
      kind: 'ready',
      input: {
        source: slots.source,
        said,
        sender: slots.source === 'mail' ? (slots.sender?.trim() || null) : null,
        text,
        repeat: slots.repeat === 'yes',
        expiresAt: ctx.nowMs + days * DAY_MS,
      } satisfies WatchInput,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<WatchInput>(inputSchema, rawInput, 'reminders.when');
    return watchText.created({ ...input, firesLeft: input.repeat ? WATCH_REPEAT_FIRES : 1 }, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<WatchInput>(inputSchema, rawInput, 'reminders.when');
    const made = storeOf(ctx).create({ principal: ctx.principal, ...input });
    if (!made.ok) return { text: personalQuestion('watches_full', ctx.lang) };
    // The phone fetches its list again; best effort, a missed push only delays.
    await ctx.watchesChanged?.().catch(() => undefined);
    return {
      text: watchText.created({ ...input, firesLeft: input.repeat ? WATCH_REPEAT_FIRES : 1 }, ctx.lang),
      compensating: { watchId: made.id },
      externalRef: made.id,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { watchId } = parseInput<{ watchId: string }>(
      z.object({ watchId: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
      compensating,
      'reminders.when',
    );
    // Gone already (spent, cancelled) is the state the Undo asked for.
    storeOf(ctx).cancel(ctx.principal, watchId);
    await ctx.watchesChanged?.().catch(() => undefined);
    return { text: watchText.cancelled(ctx.lang) };
  },
};

/**
 * `mail.follow_up` (block L, L2, 2026-10-15): "תזכיר לי אם לא ענו לי על
 * המייל לדני עד יום חמישי ב-9". Tier 1: it only starts waiting, and Undo
 * cancels; a tainted turn confirms (policy).
 *
 * Code finds the sent mail (the model gives words, never an id) in the last
 * month's sent folder, and code resolves the deadline (never defaulted: a day
 * without an hour is a question). The hourly tick checks the thread once the
 * deadline passes (`core/followup-tick.ts`). "Someone replied in the thread"
 * is all it can tell, and the description says so.
 *
 * Offered only in the app (its notices go through the outbox) and only when
 * the words say "if they don't reply" (`namesFollowUp`); never in the full catalog.
 */
import { z } from 'zod';
import { mailFollowUpSlots } from '../nlu/slot-schemas.js';
import { normalizeHebrew } from '../time/hebrew-lexicon.js';
import { resolveWhen } from '../time/resolve.js';
import type { DateSpec, TimeSpec } from '../time/resolve.js';
import { followUpText } from '../render/followups.js';
import { formatWhen } from '../render/format-time.js';
import { localPartsOf } from '../time/tz.js';
import { newestPerThread, queryWords } from './mail.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';
import type { FollowUpStore } from './followup-store.js';

const ZONE = 'Asia/Jerusalem';
const SENT_SEARCH_DAYS = 30;
const MAX_CHOICES = 5;
/** A follow-up waits at most this long: past it, Gmail search is the better tool. */
const MAX_WAIT_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * The words that offer `mail.follow_up`: "אם (הוא/היא/הם) לא י/תענה/ענו",
 * "אם אין תשובה", "if they don't reply / answer", "no reply". Code only: the
 * flag never adds a tool on its own; the pipeline also requires the app.
 */
const FOLLOW_UP_WORDS = [
  /אם\s+(?:\S+\s+){0,3}לא\s+(?:\S+\s+){0,2}(?:י|ת|נ)?(?:ענה|ענו|עונה|עונים|תענה|יענה|יענו|ענתה|יחזיר|יחזרו|חזר|חזרו)/,
  /אם\s+(?:\S+\s+){0,2}(?:אין|לא תהיה|לא תגיע|לא הגיעה|לא קיבלתי)\s+(?:\S+\s+){0,1}תשוב/,
  /\bif\b.{0,40}\b(?:no one|nobody|they|he|she|doesn'?t|don'?t|hasn'?t|haven'?t|didn'?t)\b.{0,30}\b(?:reply|replies|replied|answer|answers|answered|respond|responds|responded|write back|get back)\b/i,
  /\bno (?:reply|response|answer)\b/i,
];

export function namesFollowUp(text: string): boolean {
  const normalized = normalizeHebrew(text);
  return FOLLOW_UP_WORDS.some((pattern) => pattern.test(normalized));
}

const inputSchema = z
  .object({
    threadId: z.string().min(1).max(100),
    sentId: z.string().min(1).max(100),
    sentMessageId: z.string().min(1).max(500).nullable(),
    sentAt: z.number().int().nonnegative(),
    subject: z.string().min(1).max(200),
    /** For the reminder draft's To line only. Never rendered, never sent to a model. */
    toHeader: z.string().min(3).max(320).nullable(),
    dueAt: z.number().int().positive(),
  })
  .strict();
type FollowUpInput = z.infer<typeof inputSchema>;

function storeOf(ctx: ToolContext): FollowUpStore {
  if (!ctx.followUps) throw new Error('E_FOLLOWUPS_UNAVAILABLE');
  return ctx.followUps;
}

/** A header Gmail gave, as a To line: one line, capped, or nothing. */
export function toLineOf(header: string | null): string | null {
  if (header === null) return null;
  const line = header.replace(/[\r\n]+/g, ' ').trim();
  return line.length >= 3 && line.length <= 320 ? line : null;
}

export const mailFollowUp: ToolDefinition = {
  name: 'mail.follow_up',
  inputSchema,

  resolve(): ResolveOutcome {
    // The sent mail lives behind the network: `resolveAsync` does the work.
    return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    if (ctx.channel !== 'app' || !ctx.followUps) return { kind: 'clarify', clarify: { code: 'personal', what: 'watch_app_only' } };
    const slots = mailFollowUpSlots.safeParse(rawSlots);
    const variants = slots.success ? (slots.data.mail ?? []).map(queryWords).filter((v) => v.length > 0) : [];
    if (variants.length === 0) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };

    // The deadline first: no network for a request that is missing its hour.
    const date = slots.success ? (slots.data.date as DateSpec | undefined) : undefined;
    const time = slots.success ? (slots.data.time as TimeSpec | undefined) : undefined;
    if (date === undefined && time === undefined) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'time' } };
    const when = resolveWhen({ date, time }, { nowMs: ctx.nowMs });
    if (when.kind === 'clarify') return { kind: 'clarify', clarify: { code: 'time', detail: when } };
    if (when.utcMs - ctx.nowMs > MAX_WAIT_MS) return { kind: 'clarify', clarify: { code: 'personal', what: 'followup_far' } };

    if (!ctx.gmail) return { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'gmail' } };
    const alternatives = variants.length > 1 ? `{${variants.map((v) => `"${v}"`).join(' ')}}` : variants[0]!;
    const found = await ctx.gmail.search(`in:sent newer_than:${SENT_SEARCH_DAYS}d ${alternatives}`, MAX_CHOICES + 1);
    if (!found.ok) {
      return found.error.code === 'not_connected' || found.error.code === 'disconnected'
        ? { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'gmail' } }
        : { kind: 'clarify', clarify: { code: 'not_found' } };
    }
    // One per conversation: a follow-up waits on a thread, from its newest sent mail.
    const threads = newestPerThread(found.value);
    if (threads.length === 0) return { kind: 'clarify', clarify: { code: 'personal', what: 'followup_not_found' } };
    if (threads.length > 1) {
      return {
        kind: 'clarify',
        clarify: {
          code: 'ambiguous',
          choices: threads.slice(0, MAX_CHOICES).map((mail) => ({
            id: mail.id,
            label: `${mail.subject} (${formatWhen(localPartsOf(mail.at, ZONE), ctx.lang)})`,
          })),
        },
      };
    }
    const mail = threads[0]!;
    return {
      kind: 'ready',
      input: {
        threadId: mail.threadId,
        sentId: mail.id,
        sentMessageId: mail.messageId?.slice(0, 500) || null,
        sentAt: mail.at,
        subject: mail.subject.slice(0, 200),
        toHeader: toLineOf(mail.toHeader),
        dueAt: when.utcMs,
      } satisfies FollowUpInput,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<FollowUpInput>(inputSchema, rawInput, 'mail.follow_up');
    return followUpText.created(input.subject, input.dueAt, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<FollowUpInput>(inputSchema, rawInput, 'mail.follow_up');
    const made = storeOf(ctx).create({ principal: ctx.principal, ...input });
    if (!made.ok) return { text: made.reason === 'exists' ? followUpText.exists(ctx.lang) : followUpText.full(ctx.lang) };
    return {
      text: followUpText.created(input.subject, input.dueAt, ctx.lang),
      compensating: { followUpId: made.id },
      externalRef: made.id,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { followUpId } = parseInput<{ followUpId: string }>(
      z.object({ followUpId: z.string().regex(/^[0-9a-f]{32}$/) }).strict(),
      compensating,
      'mail.follow_up',
    );
    // Gone already (answered, notified, cancelled) is the state the Undo asked for.
    storeOf(ctx).cancel(ctx.principal, followUpId);
    return { text: followUpText.cancelled(ctx.lang) };
  },
};

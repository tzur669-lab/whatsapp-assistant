/**
 * Gmail tools (2026-10-01): `mail.search` (Tier 0, always taints) and
 * `mail.draft` (Tier 2, a draft the user sends). Agent-only.
 *
 * The model says who and what. Code builds the Gmail query from those words,
 * stripped of Gmail's operators, so a slot cannot become a different search;
 * code finds the message a reply answers, and holds its address. Nothing
 * here sends: the grant has no send scope.
 */
import { z } from 'zod';
import { MAX_MAIL_BODY_CHARS, MAX_MAIL_COUNT, MAX_MAIL_DAYS, mailDraftSlots, mailSearchSlots } from '../nlu/slot-schemas.js';
import { mailText } from '../render/mail.js';
import { eventText } from '../render/events.js';
import type { GoogleFailure } from '../google/api.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

const DEFAULT_RESULTS = 6;
const MAX_CHOICES = 5;
// A month by default: "my last mail" is often older than a few days.
const DEFAULT_DAYS = 30;
const REPLY_SEARCH_DAYS = 30;

/** Words only: Gmail's operators and grouping characters are taken out. */
export function queryWords(text: string): string {
  return text
    .replace(/[\\"(){}[\]:<>*]/g, ' ')
    .replace(/(^|\s)-+/g, ' ')
    .replace(/\b(?:OR|AND|AROUND)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/** The Gmail query, built by code from the slots. */
export function buildQuery(slots: {
  from?: string | undefined;
  about?: string | undefined;
  unread?: boolean | undefined;
  days?: number | undefined;
}): string {
  const parts = [`newer_than:${slots.days ?? DEFAULT_DAYS}d`];
  if (slots.unread) parts.push('is:unread');
  const from = slots.from ? queryWords(slots.from) : '';
  const about = slots.about ? queryWords(slots.about) : '';
  if (from) parts.push(`from:(${from})`);
  if (about) parts.push(about);
  // Without a sender or a topic, the inbox that matters: no promotions or social.
  if (!from && !about) parts.push('in:inbox', '-category:promotions', '-category:social');
  return parts.join(' ');
}

/**
 * One message per conversation, the newest — Gmail lists newest first. A Map
 * built from the list would keep the *last* value per key, the oldest one
 * (fixed 2026-10-06: a reply was threaded to the conversation's first mail).
 */
export function newestPerThread<T extends { threadId: string }>(mails: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const mail of mails) if (!seen.has(mail.threadId)) seen.set(mail.threadId, mail);
  return [...seen.values()];
}

const failure = (error: GoogleFailure, ctx: ToolContext): ExecuteResult => {
  if (error.code === 'not_connected' || error.code === 'disconnected') return { text: eventText.grantNotConnected('gmail', ctx.lang) };
  ctx.log.warn('mail_failed', { errorCode: error.code });
  return { text: mailText.unavailable(ctx.lang) };
};

// -- mail.search ----------------------------------------------------------------

const searchInputSchema = z
  .object({ query: z.string().min(1).max(300), max: z.number().int().min(1).max(MAX_MAIL_COUNT), full: z.boolean() })
  .strict();
type SearchInput = z.infer<typeof searchInputSchema>;

/**
 * A number past its range is taken as the range's end, not as a reason to
 * drop every slot: "the last three months" asked as 90 days is still a year at
 * most, not the default.
 */
function clampSlot(raw: unknown, key: 'days' | 'count', max: number): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const value = (raw as Record<string, unknown>)[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return raw;
  return { ...raw, [key]: Math.min(max, Math.max(1, Math.round(value))) };
}

export const mailSearch: ToolDefinition = {
  name: 'mail.search',
  inputSchema: searchInputSchema,

  resolve(rawSlots): ResolveOutcome {
    const slots = mailSearchSlots.safeParse(clampSlot(clampSlot(rawSlots, 'days', MAX_MAIL_DAYS), 'count', MAX_MAIL_COUNT));
    const data = slots.success ? slots.data : {};
    return {
      kind: 'ready',
      input: { query: buildQuery(data), max: data.count ?? DEFAULT_RESULTS, full: data.full === true } satisfies SearchInput,
    };
  },

  preview: () => 'חיפוש במייל',

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<SearchInput>(searchInputSchema, rawInput, 'mail.search');
    if (!ctx.gmail) return { text: eventText.grantNotConnected('gmail', ctx.lang) };

    const found = await ctx.gmail.search(input.query, input.max);
    if (!found.ok) return failure(found.error, ctx);

    let body: string | null = null;
    const newest = found.value[0];
    if (input.full && newest) {
      const read = await ctx.gmail.body(newest.id);
      if (!read.ok) return failure(read.error, ctx);
      body = read.value;
    }
    // Every result is someone else's words (§6.19).
    return { text: mailText.results(found.value, body, ctx.lang), tainting: true };
  },
};

// -- mail.draft -------------------------------------------------------------------

const draftInputSchema = z
  .object({
    /** The address a reply goes to. Held here; never shown to the model. */
    to: z.string().min(3).max(320).nullable(),
    toName: z.string().min(1).max(80).nullable(),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(MAX_MAIL_BODY_CHARS),
    threadId: z.string().min(1).max(100).nullable(),
    inReplyTo: z.string().min(1).max(500).nullable(),
  })
  .strict();
type DraftInput = z.infer<typeof draftInputSchema>;

export const mailDraft: ToolDefinition = {
  name: 'mail.draft',
  inputSchema: draftInputSchema,

  resolve(): ResolveOutcome {
    // A reply's target lives behind the network: `resolveAsync` does the work.
    return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } };
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    const slots = mailDraftSlots.safeParse(rawSlots);
    if (!slots.success) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } };
    const body = slots.data.body?.trim();
    if (!body) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } };
    const subject = slots.data.subject?.trim();

    const variants = slots.data.reply_to ?? [];
    if (variants.length === 0) {
      return {
        kind: 'ready',
        input: { to: null, toName: null, subject: subject ?? '(ללא נושא)', body, threadId: null, inReplyTo: null } satisfies DraftInput,
      };
    }

    if (!ctx.gmail) return { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'gmail' } };
    const words = queryWords(variants.join(' '));
    // Each variant as its own alternative: "דני" or "Dani" finds the same mail.
    const alternatives = variants.map(queryWords).filter(Boolean);
    const query = `newer_than:${REPLY_SEARCH_DAYS}d ${alternatives.length > 1 ? `{${alternatives.map((a) => `"${a}"`).join(' ')}}` : words}`;
    const found = await ctx.gmail.search(query, MAX_CHOICES + 1);
    if (!found.ok) {
      return found.error.code === 'not_connected' || found.error.code === 'disconnected'
        ? { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'gmail' } }
        : { kind: 'clarify', clarify: { code: 'not_found' } };
    }
    // One message per conversation: replying to a thread is replying to its newest.
    const threads = newestPerThread(found.value);
    if (threads.length === 0) return { kind: 'clarify', clarify: { code: 'not_found' } };
    if (threads.length > 1) {
      return {
        kind: 'clarify',
        clarify: { code: 'ambiguous', choices: threads.slice(0, MAX_CHOICES).map((m) => ({ id: m.id, label: `${m.fromName}: ${m.subject}` })) },
      };
    }
    const mail = threads[0]!;
    if (!mail.fromAddress) return { kind: 'clarify', clarify: { code: 'not_found' } };
    return {
      kind: 'ready',
      input: {
        to: mail.fromAddress,
        toName: mail.fromName,
        subject: subject ?? (/^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`),
        body,
        threadId: mail.threadId,
        inReplyTo: mail.messageId,
      } satisfies DraftInput,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<DraftInput>(draftInputSchema, rawInput, 'mail.draft');
    // The name, never the address: this text goes to the phone.
    return mailText.draftPreview(input.toName, input.subject, input.body, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<DraftInput>(draftInputSchema, rawInput, 'mail.draft');
    if (!ctx.gmail) return { text: eventText.grantNotConnected('gmail', ctx.lang) };
    const saved = await ctx.gmail.createDraft({
      to: input.to,
      subject: input.subject,
      body: input.body,
      threadId: input.threadId,
      inReplyTo: input.inReplyTo,
    });
    if (!saved.ok) return failure(saved.error, ctx);
    return { text: mailText.draftSaved(ctx.lang), externalRef: saved.value };
  },
};

export const MAIL_TOOLS = {
  'mail.search': mailSearch,
  'mail.draft': mailDraft,
} as const;

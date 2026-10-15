/**
 * `mail.archive` (block L, L5, 2026-10-15): "תארכב את כל הניוזלטרים
 * מהשבוע". Tier 2: the card shows the exact count and the filter, and what
 * runs is the stored id list the card showed (invariant 7). Archive only:
 * no delete, no trash, no send — the ban-list test holds the client to INBOX
 * and the bot's own labels.
 *
 * Code builds the Gmail query from the slots (`in:inbox` always, so archived
 * mail is never a target) and lists at most 50; more than 50 is a question,
 * never a partial archive. Needs the `gmail.modify` scope, checked against
 * what the grant actually holds. Offered only when the words say so
 * (`namesArchive`), never in the full catalog.
 */
import { z } from 'zod';
import { mailArchiveSlots } from '../nlu/slot-schemas.js';
import { normalizeHebrew } from '../time/hebrew-lexicon.js';
import { archiveText } from '../render/archive.js';
import { eventText } from '../render/events.js';
import { runArchive } from '../core/mail-archive.js';
import { queryWords } from './mail.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

export const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
export const MAX_ARCHIVE = 50;

const WORDS = [/(?:^|\s)\S*(?:ארכב|ארכוב|ארכיב)/, /\barchiv/i, /(?:תנקה|לנקות|נקה)\s+(?:לי\s+)?(?:את\s+)?(?:ה)?(?:מייל|תיבת|דואר)/, /\bclean\s+(?:up\s+)?(?:my\s+)?(?:inbox|mail|email)\b/i];

export function namesArchive(text: string): boolean {
  const normalized = normalizeHebrew(text);
  return WORDS.some((pattern) => pattern.test(normalized));
}

const inputSchema = z
  .object({
    ids: z.array(z.string().regex(/^[0-9a-zA-Z]{1,64}$/)).min(1).max(MAX_ARCHIVE),
    sender: z.string().min(1).max(60).nullable(),
    about: z.string().min(1).max(100).nullable(),
    olderThanDays: z.number().int().min(1).max(3650).nullable(),
  })
  .strict();
type ArchiveInput = z.infer<typeof inputSchema>;

/** The Gmail query, by code: words only, `in:inbox` always. */
export function archiveQuery(slots: { sender: string | null; about: string | null; olderThanDays: number | null }): string {
  const parts = ['in:inbox'];
  if (slots.sender) parts.push(`from:(${slots.sender})`);
  if (slots.about) parts.push(slots.about);
  if (slots.olderThanDays) parts.push(`older_than:${slots.olderThanDays}d`);
  return parts.join(' ');
}

export const mailArchive: ToolDefinition = {
  name: 'mail.archive',
  inputSchema,

  resolve(): ResolveOutcome {
    // The inbox lives behind the network: `resolveAsync` does the work.
    return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };
  },

  async resolveAsync(rawSlots, ctx: ToolContext): Promise<ResolveOutcome> {
    if (!ctx.gmail) return { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'gmail' } };
    if (!ctx.gmail.hasScope(GMAIL_MODIFY)) return { kind: 'clarify', clarify: { code: 'personal', what: 'archive_reconnect' } };
    if (!ctx.archives) return { kind: 'clarify', clarify: { code: 'personal', what: 'watch_app_only' } };
    const parsed = mailArchiveSlots.safeParse(rawSlots);
    const sender = parsed.success && parsed.data.sender ? queryWords(parsed.data.sender) || null : null;
    const about = parsed.success && parsed.data.about ? queryWords(parsed.data.about) || null : null;
    const olderThanDays = parsed.success ? (parsed.data.older_than_days ?? null) : null;
    // Never "the whole inbox" by accident: at least one filter.
    if (!sender && !about && !olderThanDays) return { kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } };

    const listed = await ctx.gmail.listIdsBounded(archiveQuery({ sender, about, olderThanDays }), MAX_ARCHIVE);
    if (!listed.ok) {
      return listed.error.code === 'not_connected' || listed.error.code === 'disconnected'
        ? { kind: 'clarify', clarify: { code: 'grant_missing', grant: 'gmail' } }
        : { kind: 'clarify', clarify: { code: 'not_found' } };
    }
    if (listed.value.more) return { kind: 'clarify', clarify: { code: 'personal', what: 'archive_too_many' } };
    if (listed.value.ids.length === 0) return { kind: 'clarify', clarify: { code: 'personal', what: 'archive_none' } };
    return { kind: 'ready', input: { ids: listed.value.ids, sender, about, olderThanDays } satisfies ArchiveInput };
  },

  preview(rawInput, lang): string {
    const input = parseInput<ArchiveInput>(inputSchema, rawInput, 'mail.archive');
    return archiveText.preview(input.ids.length, input, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<ArchiveInput>(inputSchema, rawInput, 'mail.archive');
    if (!ctx.gmail) return { text: eventText.grantNotConnected('gmail', ctx.lang) };
    if (!ctx.archives) return { text: archiveText.unknown(ctx.lang) };
    const outcome = await runArchive({ store: ctx.archives, gmail: ctx.gmail, principal: ctx.principal, ids: input.ids });
    return { text: archiveText.outcome(outcome, input.ids.length, ctx.lang) };
  },
};

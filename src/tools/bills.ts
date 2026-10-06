/**
 * `mail.bills` (ROADMAP #24, 2026-10-06): bills and invoices in Gmail, with
 * the amount and the due date when the mail states them. Tier 0, agent-only,
 * through the `gmail` grant.
 *
 * Code builds the Gmail query (the model says only how far back), reads each
 * match, and pulls out the amount and the date (`bill-extract.ts`). The reply
 * is code's text and ends the turn: amounts are numbers the model-bound scrub
 * would blank. Mail is someone else's words, so it taints.
 */
import { z } from 'zod';
import { mailBillsSlots, MAX_BILL_DAYS } from '../nlu/slot-schemas.js';
import { eventText } from '../render/events.js';
import { mailText } from '../render/mail.js';
import { cleanItemText } from '../render/phone-reads.js';
import { isolate, isolateLtr } from '../render/bidi.js';
import { formatDay } from '../render/format-time.js';
import type { Lang } from '../render/format-time.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import type { LocalParts } from '../time/tz.js';
import { billFacts } from './bill-extract.js';
import type { BillFacts } from './bill-extract.js';
import { parseInput } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolDefinition } from './types.js';
import { newestPerThread } from './mail.js';

const DEFAULT_DAYS = 45;
/** Each one is a body read: a request of its own, against the Worker's subrequest cap. */
const MAX_BILLS = 8;
const MAX_SUBJECT_CHARS = 60;

/** Words a bill says about itself. Fixed by code; nothing from the model goes in. */
const BILL_WORDS = [
  'חשבונית',
  '"חשבון לתשלום"',
  '"דרישת תשלום"',
  '"לתשלום עד"',
  '"מועד התשלום"',
  '"חשבון תקופתי"',
  'invoice',
  '"payment due"',
  '"amount due"',
  '"your bill"',
];

export function buildBillsQuery(days: number): string {
  return `newer_than:${days}d {${BILL_WORDS.join(' ')}} -category:promotions -category:social`;
}

const inputSchema = z.object({ query: z.string().min(1).max(400) }).strict();
type BillsInput = z.infer<typeof inputSchema>;

type Bill = { from: string; subject: string; at: number; facts: BillFacts };

function dayNumber(date: { year: number; month: number; day: number }): number {
  return Date.UTC(date.year, date.month - 1, date.day);
}

function dueLocal(due: NonNullable<BillFacts['due']>): LocalParts {
  return { ...due, hour: 0, minute: 0, weekday: new Date(dayNumber(due)).getUTCDay() };
}

function shekels(amount: number): string {
  return `${isolateLtr(amount.toLocaleString('en-US', { maximumFractionDigits: 2 }))} ₪`;
}

export function renderBills(bills: readonly Bill[], nowMs: number, lang: Lang): string {
  const he = lang === 'he';
  if (bills.length === 0) return he ? 'לא נמצאו חשבונות לתשלום במייל.' : 'No bills found in the mail.';
  const today = dayNumber(localPartsOf(nowMs, ZONE));
  const sorted = [...bills].sort((a, b) => {
    const da = a.facts.due ? dayNumber(a.facts.due) : Infinity;
    const db = b.facts.due ? dayNumber(b.facts.due) : Infinity;
    return da - db || b.at - a.at;
  });
  const lines = sorted.map((bill) => {
    const parts = [`${isolate(bill.from)}: ${isolate(bill.subject)}`];
    if (bill.facts.amount !== null) parts.push(shekels(bill.facts.amount));
    if (bill.facts.due) {
      const late = dayNumber(bill.facts.due) < today;
      const day = formatDay(dueLocal(bill.facts.due), lang);
      parts.push(he ? `לתשלום עד ${day}${late ? ' (המועד עבר)' : ''}` : `due ${day}${late ? ' (past due)' : ''}`);
    }
    return `• ${parts.join(' · ')}`;
  });
  const footer = he
    ? 'הסכום והתאריך נלקחו מתוך המייל. כדאי לבדוק במייל עצמו לפני התשלום.'
    : 'Amounts and dates are read from the mail. Check the mail itself before paying.';
  return [he ? 'חשבונות במייל:' : 'Bills in the mail:', ...lines, '', footer].join('\n');
}

export const mailBills: ToolDefinition = {
  name: 'mail.bills',
  inputSchema,

  resolve(rawSlots): ResolveOutcome {
    const raw = rawSlots as { days?: unknown } | null;
    // A number past the range is the range's end, as in mail.search.
    const clamped =
      raw && typeof raw.days === 'number' && Number.isFinite(raw.days)
        ? { ...raw, days: Math.min(MAX_BILL_DAYS, Math.max(1, Math.round(raw.days))) }
        : rawSlots;
    const slots = mailBillsSlots.safeParse(clamped);
    const days = (slots.success ? slots.data.days : undefined) ?? DEFAULT_DAYS;
    return { kind: 'ready', input: { query: buildBillsQuery(days) } satisfies BillsInput };
  },

  preview: () => 'חשבונות במייל',

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<BillsInput>(inputSchema, rawInput, 'mail.bills');
    if (!ctx.gmail) return { text: eventText.grantNotConnected('gmail', ctx.lang) };

    const found = await ctx.gmail.search(input.query, MAX_BILLS);
    if (!found.ok) {
      if (found.error.code === 'not_connected' || found.error.code === 'disconnected') {
        return { text: eventText.grantNotConnected('gmail', ctx.lang) };
      }
      ctx.log.warn('mail_failed', { errorCode: found.error.code });
      return { text: mailText.unavailable(ctx.lang) };
    }

    // One bill per conversation: a reminder in the same thread is the same bill.
    const mails = newestPerThread(found.value);
    const bills: Bill[] = [];
    for (const mail of mails) {
      const read = await ctx.gmail.body(mail.id);
      // A body that cannot be read still lists the mail, from its subject and snippet.
      const body = read.ok ? read.value : '';
      const text = `${mail.subject}\n${mail.snippet}\n${body}`;
      bills.push({
        from: cleanItemText(mail.fromName).slice(0, 60),
        subject: cleanItemText(mail.subject).slice(0, MAX_SUBJECT_CHARS),
        at: mail.at,
        facts: billFacts(text, localPartsOf(mail.at, ZONE)),
      });
    }
    return { text: renderBills(bills, ctx.nowMs, ctx.lang), tainting: true };
  },
};

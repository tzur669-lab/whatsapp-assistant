/**
 * The monthly bookkeeping file (block L, L4, 2026-10-15): one month's
 * expenses, totals by category, and the bills found in Gmail, as one CSV card
 * the phone saves. `expenses.monthly_pack` on request, and the 1st-of-month
 * job (`assistant-do.ts`) share `buildMonthlyPack`.
 *
 * Nothing in it is ever presented as complete when it is not: the bills scan
 * is capped and can miss mails, and the file says so in its first lines; when
 * Gmail is not reachable the file still goes, without bills, saying why.
 * Shekels only — expenses are kept in agorot and bills are read only next to
 * a shekel sign (`bill-extract.ts`), so nothing is converted or mixed.
 *
 * Offered only when the words ask for it (`namesMonthlyPack`), never in the
 * full catalog, and never in a smart conversation (`smartOfferedTools`).
 */
import { z } from 'zod';
import { expensesMonthlyPackSlots } from '../nlu/slot-schemas.js';
import { normalizeHebrew } from '../time/hebrew-lexicon.js';
import { localPartsOf, wallTimeToUtc, ZONE } from '../time/tz.js';
import { categoryName } from '../render/personal.js';
import { monthlyText } from '../render/monthly.js';
import type { BillsCoverage } from '../render/monthly.js';
import type { Lang } from '../render/format-time.js';
import { BOM, cell, EXPENSE_CATEGORIES, formatAgorot, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS } from './expense-store.js';
import type { Expense, ExpenseStore } from './expense-store.js';
import { buildBillsQueryBetween, readBillsCounted } from './bills.js';
import type { Bill } from './bills.js';
import type { GmailClient } from '../google/gmail.js';
import { parseInput, ToolInputError } from './types.js';
import type { ExecuteResult, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

const WORDS = [
  /הנהלת\s+חשבונות/,
  /רואה\s+ה?חשבון/,
  /(?:קובץ|דוח|דו"ח|דו״ח|סיכום|חבילה)\s+(?:ה)?חודשי/,
  /\b(?:monthly\s+(?:pack|report|file|statement)|bookkeeping|accountant)\b/i,
];

export function namesMonthlyPack(text: string): boolean {
  const normalized = normalizeHebrew(text);
  return WORDS.some((pattern) => pattern.test(normalized));
}

export type MonthSpan = { year: number; month: number; key: string; from: string; to: string; startUtc: number; endUtc: number };

/** Local midnight of a day as an instant: Israel changes its clocks at 02:00, so 00:00 always exists once. */
function midnightUtc(year: number, month: number, day: number): number {
  const resolved = wallTimeToUtc({ year, month, day, hour: 0, minute: 0 }, ZONE);
  return resolved.kind === 'ok' ? resolved.utcMs : resolved.kind === 'fold' ? resolved.utcMsCandidates[0] : Date.UTC(year, month - 1, day);
}

/**
 * The month to pack: `month` (1–12) is the latest such month that has
 * already ended; absent is last month. Local (`Asia/Jerusalem`) bounds.
 */
export function monthSpan(nowMs: number, month?: number): MonthSpan {
  const today = localPartsOf(nowMs, ZONE);
  let year = today.year;
  let m = month ?? today.month - 1;
  if (m < 1) {
    m += 12;
    year -= 1;
  }
  // "September" asked in September (or later in a year that has not reached it) is last year's.
  if (month !== undefined && (m > today.month - 1 || today.month === 1)) year -= 1;
  const next = m === 12 ? { y: year + 1, m: 1 } : { y: year, m: m + 1 };
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(Date.UTC(next.y, next.m - 1, 1) - 86_400_000).getUTCDate();
  return {
    year,
    month: m,
    key: `${year}-${pad(m)}`,
    from: `${year}-${pad(m)}-01`,
    to: `${year}-${pad(m)}-${pad(lastDay)}`,
    startUtc: midnightUtc(year, m, 1),
    endUtc: midnightUtc(next.y, next.m, 1),
  };
}

/** The CSV: notes first (what it does not cover), then expenses, totals, bills. Capped like the export. */
export function monthlyCsv(params: { expenses: readonly Expense[]; expensesCut: boolean; bills: readonly Bill[] | null; coverage: BillsCoverage; lang: Lang }): string {
  const { lang } = params;
  const k = monthlyText.kind;
  const line = (cells: readonly string[]) => `${cells.map(cell).join(',')}\r\n`;
  const lines: string[] = [];
  for (const note of monthlyText.notes(params.coverage, params.expensesCut, lang)) lines.push(line([k.note(lang), '', '', '', '', note]));

  const ordered = [...params.expenses].sort((a, b) => a.spentOn.localeCompare(b.spentOn));
  for (const expense of ordered) {
    lines.push(line([k.expense(lang), expense.spentOn, formatAgorot(expense.amountAgorot), 'ILS', categoryName(expense.category, lang), expense.description ?? '']));
  }
  let total = 0;
  for (const category of EXPENSE_CATEGORIES) {
    const sum = ordered.filter((expense) => expense.category === category).reduce((acc, expense) => acc + expense.amountAgorot, 0);
    if (sum === 0) continue;
    total += sum;
    lines.push(line([k.categoryTotal(lang), '', formatAgorot(sum), 'ILS', categoryName(category, lang), '']));
  }
  lines.push(line([k.total(lang), '', formatAgorot(total), 'ILS', '', '']));

  for (const bill of params.bills ?? []) {
    const received = localPartsOf(bill.at, ZONE);
    const pad = (n: number) => String(n).padStart(2, '0');
    const due = bill.facts.due ? monthlyText.dueNote(`${bill.facts.due.year}-${pad(bill.facts.due.month)}-${pad(bill.facts.due.day)}`, lang) : '';
    const amount = bill.facts.amount === null ? '' : bill.facts.amount.toFixed(2);
    lines.push(line([k.bill(lang), `${received.year}-${pad(received.month)}-${pad(received.day)}`, amount, amount ? 'ILS' : '', bill.from, [bill.subject, due].filter(Boolean).join(' · ')]));
  }

  // The byte cap of the export, cutting from the end; the notes stay.
  const encoder = new TextEncoder();
  let content = `${BOM}${line(monthlyText.header(lang))}`;
  for (const next of lines) {
    if (encoder.encode(content + next).length > MAX_EXPORT_BYTES) break;
    content += next;
  }
  return content;
}

const inputSchema = z
  .object({
    type: z.literal('file'),
    name: z.string().regex(/^monthly-\d{4}-\d{2}\.csv$/),
    mime: z.literal('text/csv'),
    content: z.string().min(1).max(MAX_EXPORT_BYTES),
    preview: z.string().min(1).max(300),
  })
  .strict();
export type MonthlyPackInput = z.infer<typeof inputSchema>;

/**
 * Build one month's file: expenses from SQL, bills from Gmail when it can be
 * reached. Reads only; nothing is stored.
 */
export async function buildMonthlyPack(params: {
  principal: string;
  expenses: ExpenseStore;
  gmail: GmailClient | null;
  span: MonthSpan;
  lang: Lang;
}): Promise<{ input: MonthlyPackInput; expenses: number; coverage: BillsCoverage }> {
  // One more than fits, so a cut is known rather than guessed.
  const rows = params.expenses.between(params.principal, params.span.from, params.span.to, MAX_EXPORT_ROWS + 1);
  const expensesCut = rows.length > MAX_EXPORT_ROWS;
  const expenses = rows.slice(0, MAX_EXPORT_ROWS);

  let bills: Bill[] | null = null;
  let coverage: BillsCoverage = { kind: 'unavailable' };
  if (params.gmail) {
    const read = await readBillsCounted(params.gmail, buildBillsQueryBetween(params.span.startUtc, params.span.endUtc));
    if (read.ok) {
      bills = read.value.bills;
      coverage = { kind: 'read', count: bills.length, skipped: read.value.skipped, capped: read.value.capped };
    }
  }
  const content = monthlyCsv({ expenses, expensesCut, bills, coverage, lang: params.lang });
  return {
    input: {
      type: 'file',
      name: `monthly-${params.span.key}.csv`,
      mime: 'text/csv',
      content,
      preview: monthlyText.preview(params.span.year, params.span.month, expenses.length, coverage, params.lang),
    },
    expenses: expenses.length,
    coverage,
  };
}

export const expensesMonthlyPack: ToolDefinition = {
  name: 'expenses.monthly_pack',
  inputSchema,

  resolve(): ResolveOutcome {
    // The bills live behind the network: `resolveAsync` does the work.
    return { kind: 'clarify', clarify: { code: 'personal', what: 'no_expenses' } };
  },

  async resolveAsync(rawSlots, ctx: ToolContext): Promise<ResolveOutcome> {
    if (!ctx.expenses) return { kind: 'clarify', clarify: { code: 'personal', what: 'no_expenses' } };
    const slots = expensesMonthlyPackSlots.safeParse(rawSlots);
    const span = monthSpan(ctx.nowMs, slots.success ? slots.data.month : undefined);
    const built = await buildMonthlyPack({ principal: ctx.principal, expenses: ctx.expenses, gmail: ctx.gmail ?? null, span, lang: ctx.lang });
    // Bills are someone else's words: the card that lists their senders taints.
    return { kind: 'ready', input: built.input, ...(built.coverage.kind === 'read' && built.coverage.count > 0 ? { tainting: true as const } : {}) };
  },

  preview(rawInput): string {
    return parseInput<MonthlyPackInput>(inputSchema, rawInput, 'expenses.monthly_pack').preview;
  },

  /** A card is run by the phone after its claim, never here (§6.20). */
  async execute(): Promise<ExecuteResult> {
    throw new ToolInputError('expenses.monthly_pack');
  },

  // Never without the tap: the file carries bill senders and subjects, someone else's words.
  autoRunnable: () => false,
};

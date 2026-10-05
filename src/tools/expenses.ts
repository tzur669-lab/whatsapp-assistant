/**
 * `expenses.*` (PLAN §6.22, ROADMAP #10, 2026-10-05): record a spending, sum a
 * period, export it as CSV to the phone.
 *
 * The model gives an amount, a category from a closed list, a few words and a
 * past day as it was said; code works out the day (`src/time/past-day.ts`),
 * stores whole agorot, and does every sum. No day said is today — the user's
 * decision of 2026-10-05, and the reply always shows the day it chose.
 *
 * The export is a card (§6.20): the file is built here, stored in the card's
 * pending row, and reaches the phone only from the signed claim.
 */
import { z } from 'zod';
import {
  EXPENSE_CATEGORY_SLOTS,
  EXPENSE_PERIODS,
  expensesAddSlots,
  expensesExportSlots,
  expensesSummarySlots,
  MAX_EXPENSE_DESCRIPTION_CHARS,
} from '../nlu/slot-schemas.js';
import { categoryName, expenseText, personalQuestion } from '../render/personal.js';
import { expensePeriodDays, resolvePastDay } from '../time/past-day.js';
import type { ExpensePeriod, SpentDateSpec } from '../time/past-day.js';
import { ZONE } from '../time/tz.js';
import { expensesCsv, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS } from './expense-store.js';
import type { ExpenseStore } from './expense-store.js';
import { parseInput, ToolInputError } from './types.js';
import type { ExecuteResult, PersonalQuestion, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

const ask = (what: PersonalQuestion): ResolveOutcome => ({ kind: 'clarify', clarify: { code: 'personal', what } });

function storeOf(ctx: ToolContext): ExpenseStore {
  if (!ctx.expenses) throw new Error('E_EXPENSES_UNAVAILABLE');
  return ctx.expenses;
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// -- expenses.add -----------------------------------------------------------------

const addInputSchema = z
  .object({
    agorot: z.number().int().positive().max(100_000_000),
    category: z.enum(EXPENSE_CATEGORY_SLOTS),
    description: z.string().min(1).max(MAX_EXPENSE_DESCRIPTION_CHARS).nullable(),
    spentOn: isoDay,
  })
  .strict();
type AddInput = z.infer<typeof addInputSchema>;

export const expensesAdd: ToolDefinition = {
  name: 'expenses.add',
  inputSchema: addInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = expensesAddSlots.safeParse(rawSlots);
    if (!slots.success || slots.data.amount === undefined) return ask('expense_amount');
    const { amount, category, description } = slots.data;

    // No day said: today (approved by the user, 2026-10-05). A spending is in
    // the past, so this is not the scheduling time invariant 4 forbids guessing.
    const day = resolvePastDay(spentOf(slots.data), ctx.nowMs, ZONE);
    if (day.kind === 'clarify') {
      return ask(day.reason === 'future' ? 'expense_future' : day.reason === 'too_old' ? 'expense_too_old' : 'expense_invalid_date');
    }

    const agorot = Math.round(amount * 100);
    if (agorot <= 0) return ask('expense_amount');
    const words = description?.trim();
    return {
      kind: 'ready',
      input: {
        agorot,
        category: category ?? 'other',
        description: words ? words : null,
        spentOn: day.iso,
      } satisfies AddInput,
    };
  },

  preview(rawInput, lang): string {
    const input = parseInput<AddInput>(addInputSchema, rawInput, 'expenses.add');
    return expenseText.added(input, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<AddInput>(addInputSchema, rawInput, 'expenses.add');
    const row = storeOf(ctx).add(ctx.principal, {
      amountAgorot: input.agorot,
      category: input.category,
      description: input.description,
      spentOn: input.spentOn,
    });
    if (!row) return { text: personalQuestion('expenses_full', ctx.lang) };
    return { text: expenseText.added(input, ctx.lang), compensating: { expenseId: row.id }, externalRef: row.id };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const { expenseId } = parseInput<{ expenseId: string }>(
      z.object({ expenseId: z.string().min(1).max(64) }).strict(),
      compensating,
      'expenses.add',
    );
    const removed = storeOf(ctx).remove(expenseId, ctx.principal);
    return { text: removed ? expenseText.removed(ctx.lang) : expenseText.gone(ctx.lang) };
  },
};

/** The most specific day said wins: a date, then a weekday, then days ago. */
function spentOf(slots: { days_ago?: number | undefined; weekday?: number | undefined; on_date?: { day: number; month: number; year?: number | undefined } | undefined }): SpentDateSpec {
  if (slots.on_date) return { kind: 'absolute', ...slots.on_date };
  if (slots.weekday !== undefined) return { kind: 'weekday', weekday: slots.weekday };
  return { kind: 'days_ago', days: slots.days_ago ?? 0 };
}

// -- expenses.summary -------------------------------------------------------------

const summaryInputSchema = z
  .object({
    period: z.enum(EXPENSE_PERIODS),
    from: isoDay,
    to: isoDay,
    category: z.enum(EXPENSE_CATEGORY_SLOTS).optional(),
  })
  .strict();
type SummaryInput = z.infer<typeof summaryInputSchema>;

export const expensesSummary: ToolDefinition = {
  name: 'expenses.summary',
  inputSchema: summaryInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = expensesSummarySlots.safeParse(rawSlots);
    const period: ExpensePeriod = (slots.success ? slots.data.period : undefined) ?? 'this_month';
    const category = slots.success ? slots.data.category : undefined;
    const { from, to } = expensePeriodDays(period, ctx.nowMs, ZONE);
    return { kind: 'ready', input: { period, from, to, ...(category ? { category } : {}) } satisfies SummaryInput };
  },

  preview(): string {
    return 'הוצאות';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<SummaryInput>(summaryInputSchema, rawInput, 'expenses.summary');
    const totals = storeOf(ctx).totals(ctx.principal, input.from, input.to, input.category);
    if (totals.length === 0) return { text: personalQuestion('no_expenses', ctx.lang) };
    return { text: expenseText.summary(totals, input.period, ctx.lang) };
  },
};

// -- expenses.export ----------------------------------------------------------------

/** The card the phone gets from the claim: a closed type, a safe name, the file. */
const exportInputSchema = z
  .object({
    type: z.literal('file'),
    name: z.string().regex(/^[a-z0-9-]{1,48}\.csv$/),
    mime: z.literal('text/csv'),
    content: z.string().min(1).max(MAX_EXPORT_BYTES),
    preview: z.string().min(1).max(300),
  })
  .strict();
type ExportInput = z.infer<typeof exportInputSchema>;

export const expensesExport: ToolDefinition = {
  name: 'expenses.export',
  inputSchema: exportInputSchema,

  resolve(rawSlots, ctx): ResolveOutcome {
    const slots = expensesExportSlots.safeParse(rawSlots);
    const period: ExpensePeriod = (slots.success ? slots.data.period : undefined) ?? 'all';
    const { from, to } = expensePeriodDays(period, ctx.nowMs, ZONE);

    // One more than fits, so a cut is known rather than guessed.
    const rows = storeOf(ctx).between(ctx.principal, from, to, MAX_EXPORT_ROWS + 1);
    if (rows.length === 0) return ask('no_expenses');

    const csv = expensesCsv(rows, expenseText.csvHeader(ctx.lang), (category) => categoryName(category, ctx.lang));
    return {
      kind: 'ready',
      input: {
        type: 'file',
        name: `expenses-${to}.csv`,
        mime: 'text/csv',
        content: csv.content,
        preview: expenseText.exportPreview(csv.rows, period, csv.cut, ctx.lang),
      } satisfies ExportInput,
    };
  },

  preview(rawInput): string {
    return parseInput<ExportInput>(exportInputSchema, rawInput, 'expenses.export').preview;
  },

  /** A card is run by the phone after its claim, never here (§6.20). */
  async execute(): Promise<ExecuteResult> {
    throw new ToolInputError('expenses.export');
  },

  // Saving a file of the user's own data on the user's own phone.
  autoRunnable: () => true,
};

export const EXPENSE_TOOLS = {
  'expenses.add': expensesAdd,
  'expenses.summary': expensesSummary,
  'expenses.export': expensesExport,
} as const;

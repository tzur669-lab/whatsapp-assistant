/**
 * `portfolio.*` (PLAN §6.24, ROADMAP block H part 19, 2026-10-08): "יש לי 10
 * מניות אפל ב-150", "קניתי עוד 50 טבע בת״א ב-118 שקל", "מה שווי התיק?".
 *
 * Private (`ToolSpec.private`): no holding, price or reply reaches the model.
 *
 * The symbol is the one value the model supplies that names a target; code
 * checks it with the quote source before anything is kept. The market comes
 * from the message's own words first (`marketWordsIn`), then the model's
 * `market`, then the holdings and the sources: a stock listed in both markets
 * is asked about, never guessed. All arithmetic is integer, in `holding-store`.
 */
import { z } from 'zod';
import { portfolioShowSlots, portfolioUpdateSlots } from '../nlu/slot-schemas.js';
import { personalQuestion } from '../render/personal.js';
import { holdingLabel, portfolioText } from '../render/portfolio.js';
import type { PricedHolding } from '../render/portfolio.js';
import type { Lang } from '../render/format-time.js';
import { SYMBOL_PATTERN } from '../lookup/quotes.js';
import type { Currency, Market, Quote, QuoteSources, SourceResult } from '../lookup/quotes.js';
import { usdIls } from '../lookup/rates.js';
import { applyOp, MAX_HOLDINGS, MAX_QUANTITY_MILLI, QUOTE_FRESH_CLOSED_MS, QUOTE_FRESH_OPEN_MS } from './holding-store.js';
import type { Holding, HoldingStore, OpInput, OpQuestion } from './holding-store.js';
import { parseInput } from './types.js';
import type { ExecuteResult, PersonalQuestion, ResolveOutcome, ToolContext, ToolDefinition } from './types.js';

const ask = (what: PersonalQuestion): ResolveOutcome => ({ kind: 'clarify', clarify: { code: 'personal', what } });

const QUESTION_OF: Record<OpQuestion, PersonalQuestion> = {
  buy_price: 'holding_buy_price',
  previous_price: 'holding_previous_price',
  reduce_below: 'holding_reduce_below',
  reduce_none: 'holding_reduce_none',
  too_many: 'holding_too_many',
};

function storeOf(ctx: ToolContext): HoldingStore {
  if (!ctx.holdings) throw new Error('E_HOLDINGS_UNAVAILABLE');
  return ctx.holdings;
}

const US_WORDS = [/ארה["״׳']{0,2}ב/, /ארצות הברית/, /אמריקא/, /ניו יורק/, /נאסד["״׳']{0,2}ק/, /וול סטריט/, /\b(?:NYSE|NASDAQ|US market|Wall Street)\b/i];
const TASE_WORDS = [/(?<![א-ת])[ובה]?ת["״׳']{1,2}א(?![א-ת])/, /תל אביב/, /תל-אביב/, /הבורסה הישראלית/, /\b(?:TASE|TLV|Tel Aviv)\b/i];

/** The market the message's own words name, read by code (PLAN §6.24). */
export function marketWordsIn(text: string): 'us' | 'tase' | 'both' | undefined {
  const us = US_WORDS.some((pattern) => pattern.test(text));
  const tase = TASE_WORDS.some((pattern) => pattern.test(text));
  if (us && tase) return 'both';
  return us ? 'us' : tase ? 'tase' : undefined;
}

/** A price as said, to minor units of the holding's currency. Undefined: the unit is not known. */
function buyPriceMinor(price: number, unit: 'shekel' | 'agorot' | undefined, currency: Currency): number | undefined {
  if (currency === 'USD') return Math.round(price * 100);
  if (unit === 'shekel') return Math.round(price * 100);
  if (unit === 'agorot') return Math.round(price);
  return undefined;
}

// -- portfolio.update -----------------------------------------------------------

const minorSchema = z.number().int().positive().max(1_000_000_000);

const updateInputSchema = z
  .object({
    op: z.enum(['set', 'add', 'reduce']),
    symbol: z.string().regex(SYMBOL_PATTERN),
    market: z.enum(['us', 'tase']),
    name: z.string().min(1).max(80).nullable(),
    currency: z.enum(['USD', 'ILS']),
    quantityMilli: z.number().int().min(0).max(MAX_QUANTITY_MILLI),
    buyPriceMinor: minorSchema.optional(),
    previousBuyPriceMinor: minorSchema.optional(),
    previousUnknown: z.literal(true).optional(),
  })
  .strict();
type UpdateInput = z.infer<typeof updateInputSchema>;

const positionSchema = z
  .object({ quantityMilli: z.number().int().positive().max(MAX_QUANTITY_MILLI), buyPriceMinor: minorSchema.nullable() })
  .strict();
const changeSchema = z
  .object({
    id: z.string().min(1).max(64),
    version: z.number().int().min(0),
    before: positionSchema.nullable(),
    removed: z.boolean(),
  })
  .strict();

const labelOf = (input: Pick<UpdateInput, 'symbol' | 'market' | 'name'>, lang: Lang) => holdingLabel(input, lang);

export const portfolioUpdate: ToolDefinition = {
  name: 'portfolio.update',
  inputSchema: updateInputSchema,

  resolve(): ResolveOutcome {
    // The symbol is checked with the quote source: found in `resolveAsync`.
    return ask('holding_symbol');
  },

  async resolveAsync(rawSlots, ctx): Promise<ResolveOutcome> {
    const slots = portfolioUpdateSlots.safeParse(rawSlots);
    if (!slots.success) return ask('holding_symbol');
    const store = storeOf(ctx);

    let symbol = (slots.data.symbol ?? '').trim().toUpperCase().replace(/\s+/g, '');
    let market: Market | undefined;
    if (symbol.endsWith('.TA')) {
      symbol = symbol.slice(0, -3);
      market = 'tase';
    }
    if (!symbol) return ask('holding_symbol');
    if (!SYMBOL_PATTERN.test(symbol)) return ask('holding_unknown');
    if (slots.data.quantity === undefined) return ask('holding_quantity');
    const quantityMilli = Math.round(slots.data.quantity * 1000);

    // The message's own words first, then the model's market (PLAN §6.24).
    const words = ctx.marketWords;
    if (words === 'both') return ask('holding_market');
    market = words ?? market ?? slots.data.market;

    const held = store.bySymbol(ctx.principal, symbol);
    let found: Extract<SourceResult, { kind: 'ok' }> | undefined;
    if (!market) {
      if (held.length === 1) market = held[0]!.market;
      else if (held.length > 1) return ask('holding_market');
      else if (slots.data.op === 'reduce') return ask('holding_reduce_none');
      else {
        const quotes = quotesOf(ctx);
        if (!quotes) return ask('quotes_down');
        const [us, tase] = await Promise.all([quotes.quote(symbol, 'us'), quotes.quote(symbol, 'tase')]);
        if (us.kind === 'ok' && tase.kind === 'ok') return ask('holding_market');
        if (us.kind === 'ok') [market, found] = ['us', us];
        else if (tase.kind === 'ok') [market, found] = ['tase', tase];
        else return us.kind === 'error' || tase.kind === 'error' ? ask('quotes_down') : ask('holding_unknown');
      }
    }

    const existing = store.find(ctx.principal, symbol, market);
    const op = slots.data.op ?? (existing ? undefined : 'add');
    if (!op) return ask('holding_op');
    if (op !== 'set' && quantityMilli <= 0) return ask('holding_quantity');
    if (op === 'reduce' && !existing) return ask('holding_reduce_none');

    // A new holding is checked with the source; its currency is the quote's.
    if (!existing && !found) {
      const quotes = quotesOf(ctx);
      if (!quotes) return ask('quotes_down');
      const result = await quotes.quote(symbol, market);
      if (result.kind === 'unknown') return ask('holding_unknown');
      if (result.kind === 'error') return ask('quotes_down');
      found = result;
    }
    if (found) store.keep(symbol, market, found.quote);
    const currency: Currency = existing?.currency ?? found!.quote.currency;
    const name = existing?.name ?? found?.name ?? null;

    const opInput: OpInput = { op, quantityMilli };
    if (slots.data.buy_price !== undefined) {
      const minor = buyPriceMinor(slots.data.buy_price, slots.data.buy_price_unit, currency);
      if (minor === undefined) return ask('holding_price_unit');
      opInput.buyPriceMinor = minor;
    }
    if (slots.data.old_price !== undefined) {
      const minor = buyPriceMinor(slots.data.old_price, slots.data.buy_price_unit, currency);
      if (minor === undefined) return ask('holding_price_unit');
      opInput.previousBuyPriceMinor = minor;
    }
    if (slots.data.old_price_unknown === 'yes') opInput.previousUnknown = true;

    // The rules ask before anything is offered; execute applies them again on the row as it is then.
    const ruled = applyOp(existing, opInput);
    if (ruled.kind === 'ask') return ask(QUESTION_OF[ruled.what]);
    if (!existing && store.all(ctx.principal).length >= MAX_HOLDINGS) return ask('holdings_full');

    const input: UpdateInput = { op, symbol, market, name, currency, quantityMilli };
    if (opInput.buyPriceMinor !== undefined) input.buyPriceMinor = opInput.buyPriceMinor;
    if (opInput.previousBuyPriceMinor !== undefined) input.previousBuyPriceMinor = opInput.previousBuyPriceMinor;
    if (opInput.previousUnknown) input.previousUnknown = true;
    return { kind: 'ready', input };
  },

  preview(rawInput, lang): string {
    const input = parseInput<UpdateInput>(updateInputSchema, rawInput, 'portfolio.update');
    const buyPrice = input.buyPriceMinor !== undefined ? { minor: input.buyPriceMinor, currency: input.currency } : null;
    return portfolioText.preview(input.op, labelOf(input, lang), input.quantityMilli, buyPrice, lang);
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    const input = parseInput<UpdateInput>(updateInputSchema, rawInput, 'portfolio.update');
    const store = storeOf(ctx);
    const before = store.find(ctx.principal, input.symbol, input.market);
    const opInput: OpInput = { op: input.op, quantityMilli: input.quantityMilli };
    if (input.buyPriceMinor !== undefined) opInput.buyPriceMinor = input.buyPriceMinor;
    if (input.previousBuyPriceMinor !== undefined) opInput.previousBuyPriceMinor = input.previousBuyPriceMinor;
    if (input.previousUnknown) opInput.previousUnknown = true;

    const outcome = store.mutate(
      ctx.principal,
      { symbol: input.symbol, market: input.market, name: input.name, currency: input.currency },
      opInput,
    );
    const label = labelOf(input, ctx.lang);
    if (outcome.kind === 'full') return { text: personalQuestion('holdings_full', ctx.lang) };
    if (outcome.kind === 'ask') return { text: personalQuestion(QUESTION_OF[outcome.what], ctx.lang) };
    if (outcome.kind === 'unchanged') return { text: portfolioText.unchanged(label, ctx.lang) };

    const cached = store.cached(input.symbol, input.market);
    return {
      text: portfolioText.updated(outcome.holding, before, label, cached && cached.currency === input.currency ? cached : null, ctx.lang),
      compensating: outcome.change,
      externalRef: outcome.change.id,
    };
  },

  async undo(compensating, ctx): Promise<ExecuteResult> {
    const change = parseInput<z.infer<typeof changeSchema>>(changeSchema, compensating, 'portfolio.update');
    const outcome = storeOf(ctx).undo(ctx.principal, change);
    return { text: outcome === 'done' ? portfolioText.undone(ctx.lang) : portfolioText.undoRefused(outcome, ctx.lang) };
  },
};

// -- portfolio.show ---------------------------------------------------------------

const showInputSchema = z.object({}).strict();

export const portfolioShow: ToolDefinition = {
  name: 'portfolio.show',
  inputSchema: showInputSchema,

  resolve(rawSlots): ResolveOutcome {
    portfolioShowSlots.safeParse(rawSlots);
    return { kind: 'ready', input: {} };
  },

  preview(_input, lang): string {
    return lang === 'he' ? 'תיק המניות' : 'Portfolio';
  },

  async execute(rawInput, ctx): Promise<ExecuteResult> {
    parseInput(showInputSchema, rawInput, 'portfolio.show');
    const report = await portfolioReport(storeOf(ctx), ctx.principal, quotesOf(ctx), ctx.fetchImpl, ctx.lang, ctx.nowMs);
    return { text: report ?? personalQuestion('no_holdings', ctx.lang) };
  },
};

function quotesOf(ctx: Pick<ToolContext, 'quotes'>): QuoteSources | undefined {
  return ctx.quotes;
}

/**
 * Every holding with a price: a fresh cached quote, else one fetched now, else
 * the last cached one marked stale, else none. One call per symbol.
 */
export async function priceHoldings(store: HoldingStore, holdings: readonly Holding[], quotes: QuoteSources | undefined, nowMs: number): Promise<PricedHolding[]> {
  return Promise.all(
    holdings.map(async (holding): Promise<PricedHolding> => {
      const cached = store.cached(holding.symbol, holding.market);
      const fresh = cached && nowMs - cached.fetchedAt < (cached.marketOpen ? QUOTE_FRESH_OPEN_MS : QUOTE_FRESH_CLOSED_MS);
      if (cached && fresh) return { holding, quote: cached, stale: false };
      const result = quotes ? await quotes.quote(holding.symbol, holding.market) : ({ kind: 'error' } as const);
      if (result.kind === 'ok') {
        store.keep(holding.symbol, holding.market, result.quote);
        return { holding, quote: result.quote, stale: false };
      }
      return { holding, quote: cached ? (cached as Quote) : null, stale: cached !== null };
    }),
  );
}

/** The rendered portfolio, or null when nothing is held. Shared by `portfolio.show` and the scheduled send. */
export async function portfolioReport(
  store: HoldingStore,
  principal: string,
  quotes: QuoteSources | undefined,
  fetchImpl: typeof fetch | undefined,
  lang: Lang,
  nowMs: number,
): Promise<string | null> {
  const holdings = store.all(principal);
  if (holdings.length === 0) return null;
  const priced = await priceHoldings(store, holdings, quotes, nowMs);
  const usd = holdings.some((h) => h.currency === 'USD') && fetchImpl ? await usdIls(fetchImpl) : null;
  return portfolioText.show(priced, usd, lang);
}

export const PORTFOLIO_TOOLS = {
  'portfolio.update': portfolioUpdate,
  'portfolio.show': portfolioShow,
} as const;

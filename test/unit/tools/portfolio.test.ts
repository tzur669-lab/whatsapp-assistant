/**
 * The stock portfolio (PLAN §6.24, ROADMAP block H part 19): units, the op
 * rules, markets, the store's Undo, the rendered report, and that none of it
 * reaches the model. No network: the sources get a fake fetch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { NoteStore } from '../../../src/tools/note-store.js';
import { applyOp, HoldingStore, MAX_HOLDINGS, weightedAverage } from '../../../src/tools/holding-store.js';
import { createQuoteSources, marketOpenAt, toMinor } from '../../../src/lookup/quotes.js';
import type { Market, Quote, QuoteSources, SourceResult } from '../../../src/lookup/quotes.js';
import { marketWordsIn, portfolioShow, portfolioUpdate } from '../../../src/tools/portfolio.js';
import { portfolioText, valueOf } from '../../../src/render/portfolio.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { scheduledReadMessage } from '../../../src/core/scheduled-read.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const NOW = Date.parse('2026-10-07T15:00:00Z'); // Wednesday: 11:00 New York, 18:00 Jerusalem
const PRINCIPAL = 'p_pf';
const plain = (text: string) => stripIsolates(text);
const M = (shares: number) => Math.round(shares * 1000);

function quote(priceMinor: number, currency: 'USD' | 'ILS', over: Partial<Quote> = {}): Quote {
  return { priceMinor, prevCloseMinor: null, currency, asOf: NOW - 60_000, marketOpen: true, ...over };
}

/** A fake source: a table of answers per `SYMBOL@market`, and a count of calls. */
function fakeSources(table: Record<string, SourceResult>): QuoteSources & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    quote(symbol: string, market: Market) {
      calls.push(`${symbol}@${market}`);
      return Promise.resolve(table[`${symbol}@${market}`] ?? { kind: 'unknown' });
    },
  };
}

const ok = (q: Quote, name: string | null = null): SourceResult => ({ kind: 'ok', quote: q, name });

// -- units and sources ------------------------------------------------------------

describe('quotes: units, normalized once', () => {
  it('USD and ILS are ×100, ILA (agorot) as is; anything else is refused', () => {
    expect(toMinor(336.67, 'USD')).toEqual({ minor: 33667, currency: 'USD' });
    expect(toMinor(118.9, 'ILS')).toEqual({ minor: 11890, currency: 'ILS' });
    expect(toMinor(11890, 'ILA')).toEqual({ minor: 11890, currency: 'ILS' });
    expect(toMinor(10, 'EUR')).toBeNull();
    expect(toMinor(0, 'USD')).toBeNull();
    expect(toMinor(-1, 'ILA')).toBeNull();
  });

  it('Finnhub: the key in a header and never in the URL; zeros mean no such symbol; a 429 is an error', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    let answer: Response = Response.json({ c: 336.67, pc: 333.63, t: Math.floor((NOW - 60_000) / 1000) });
    const fetchImpl = ((url: string, init?: RequestInit) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return Promise.resolve(answer);
    }) as unknown as typeof fetch;
    const sources = createQuoteSources(fetchImpl, 'testkey000000000000', () => NOW);

    const got = await sources.quote('AAPL', 'us');
    expect(got).toMatchObject({ kind: 'ok', quote: { priceMinor: 33667, prevCloseMinor: 33363, currency: 'USD', marketOpen: true } });
    expect(seen[0]!.url).not.toContain('testkey');
    expect(seen[0]!.headers['X-Finnhub-Token']).toBe('testkey000000000000');

    answer = Response.json({ c: 0, d: null, pc: 0, t: 0 });
    expect(await sources.quote('NOSUCH', 'us')).toEqual({ kind: 'unknown' });
    answer = new Response('slow down', { status: 429 });
    expect(await sources.quote('AAPL', 'us')).toEqual({ kind: 'error' });
    answer = Response.json({ error: 'You don\'t have access to this resource.' });
    expect(await sources.quote('AAPL', 'us')).toEqual({ kind: 'error' });
  });

  it('without a key, a US quote is an error and nothing is fetched', async () => {
    let fetched = 0;
    const sources = createQuoteSources((() => {
      fetched += 1;
      return Promise.resolve(Response.json({}));
    }) as unknown as typeof fetch, undefined, () => NOW);
    expect(await sources.quote('AAPL', 'us')).toEqual({ kind: 'error' });
    expect(fetched).toBe(0);
  });

  it('Yahoo: ILA to agorot, a 404 is unknown, an answer for another symbol is an error', async () => {
    let answer: Response;
    const fetchImpl = (() => Promise.resolve(answer)) as unknown as typeof fetch;
    const sources = createQuoteSources(fetchImpl, undefined, () => NOW);
    const meta = (over: Record<string, unknown> = {}) =>
      Response.json({ chart: { result: [{ meta: { symbol: 'TEVA.TA', currency: 'ILA', regularMarketPrice: 11890, chartPreviousClose: 11990, regularMarketTime: Math.floor(NOW / 1000), longName: 'Teva', ...over } }] } });

    answer = meta();
    expect(await sources.quote('TEVA', 'tase')).toMatchObject({ kind: 'ok', name: 'Teva', quote: { priceMinor: 11890, prevCloseMinor: 11990, currency: 'ILS' } });
    answer = meta({ currency: 'ILS', regularMarketPrice: 118.9, chartPreviousClose: 119.9 });
    expect(await sources.quote('TEVA', 'tase')).toMatchObject({ kind: 'ok', quote: { priceMinor: 11890, prevCloseMinor: 11990 } });
    answer = meta({ symbol: 'TEVB.TA' });
    expect(await sources.quote('TEVA', 'tase')).toEqual({ kind: 'error' });
    answer = meta({ currency: 'GBp' });
    expect(await sources.quote('TEVA', 'tase')).toEqual({ kind: 'error' });
    answer = new Response('', { status: 404 });
    expect(await sources.quote('NOSUCH', 'tase')).toEqual({ kind: 'unknown' });
    answer = new Response('', { status: 500 });
    expect(await sources.quote('TEVA', 'tase')).toEqual({ kind: 'error' });
  });

  it('market hours by each exchange\'s own clock, across the weeks the clocks change apart', () => {
    // 2026-10-27, Tuesday: Israel is already back on winter time (25.10), New York not yet (1.11).
    const at = (iso: string) => Date.parse(iso);
    expect(marketOpenAt('us', at('2026-10-27T13:31:00Z'), at('2026-10-27T13:31:00Z'))).toBe(true); // 09:31 New York (EDT)
    expect(marketOpenAt('us', at('2026-10-27T13:29:00Z'), at('2026-10-27T13:29:00Z'))).toBe(false);
    expect(marketOpenAt('tase', at('2026-10-27T08:00:00Z'), at('2026-10-27T08:00:00Z'))).toBe(true); // 10:00 Jerusalem (IST)
    expect(marketOpenAt('tase', at('2026-10-27T15:30:00Z'), at('2026-10-27T15:30:00Z'))).toBe(false); // 17:30
    // Friday's short TASE session; Sunday is closed since 2026.
    expect(marketOpenAt('tase', at('2026-10-30T11:00:00Z'), at('2026-10-30T11:00:00Z'))).toBe(true); // 13:00
    expect(marketOpenAt('tase', at('2026-10-30T12:00:00Z'), at('2026-10-30T12:00:00Z'))).toBe(false); // 14:00
    expect(marketOpenAt('tase', at('2026-11-01T08:00:00Z'), at('2026-11-01T08:00:00Z'))).toBe(false);
    // An old quote means closed, whatever the clock says (a holiday).
    expect(marketOpenAt('us', at('2026-10-27T15:00:00Z'), at('2026-10-27T14:00:00Z'))).toBe(false);
  });
});

// -- the rules --------------------------------------------------------------------

describe('applyOp: the table in §6.24', () => {
  const held = (shares: number, price: number | null) => ({ quantityMilli: M(shares), buyPriceMinor: price });

  it('add with a price and one stored: the weighted average, rounded once', () => {
    expect(applyOp(held(10, 15000), { op: 'add', quantityMilli: M(5), buyPriceMinor: 18000 })).toEqual({
      kind: 'set',
      quantityMilli: M(15),
      buyPriceMinor: 16000,
    });
    expect(weightedAverage(M(1), 100, M(2), 101)).toBe(101); // 100.67 → 101
  });

  it('add with no price when one is stored: asks, never guesses', () => {
    expect(applyOp(held(10, 15000), { op: 'add', quantityMilli: M(5) })).toEqual({ kind: 'ask', what: 'buy_price' });
  });

  it('add with a price when none is stored: asks for the earlier price; "unknown" keeps none', () => {
    expect(applyOp(held(10, null), { op: 'add', quantityMilli: M(5), buyPriceMinor: 18000 })).toEqual({ kind: 'ask', what: 'previous_price' });
    expect(applyOp(held(10, null), { op: 'add', quantityMilli: M(5), buyPriceMinor: 18000, previousBuyPriceMinor: 15000 })).toEqual({
      kind: 'set',
      quantityMilli: M(15),
      buyPriceMinor: 16000,
    });
    expect(applyOp(held(10, null), { op: 'add', quantityMilli: M(5), buyPriceMinor: 18000, previousUnknown: true })).toEqual({
      kind: 'set',
      quantityMilli: M(15),
      buyPriceMinor: null,
    });
    expect(applyOp(held(10, null), { op: 'add', quantityMilli: M(5) })).toEqual({ kind: 'set', quantityMilli: M(15), buyPriceMinor: null });
  });

  it('reduce keeps the average; to zero removes; below zero or nothing held asks', () => {
    expect(applyOp(held(10, 15000), { op: 'reduce', quantityMilli: M(3) })).toEqual({ kind: 'set', quantityMilli: M(7), buyPriceMinor: 15000 });
    expect(applyOp(held(10, 15000), { op: 'reduce', quantityMilli: M(10) })).toEqual({ kind: 'remove' });
    expect(applyOp(held(10, 15000), { op: 'reduce', quantityMilli: M(11) })).toEqual({ kind: 'ask', what: 'reduce_below' });
    expect(applyOp(null, { op: 'reduce', quantityMilli: M(1) })).toEqual({ kind: 'ask', what: 'reduce_none' });
  });

  it('set: a price replaces the basis; without one, more is an add and less is a reduce; 0 removes', () => {
    expect(applyOp(held(10, 15000), { op: 'set', quantityMilli: M(20), buyPriceMinor: 17000 })).toEqual({ kind: 'set', quantityMilli: M(20), buyPriceMinor: 17000 });
    expect(applyOp(held(10, 15000), { op: 'set', quantityMilli: M(20) })).toEqual({ kind: 'ask', what: 'buy_price' });
    expect(applyOp(held(10, null), { op: 'set', quantityMilli: M(20) })).toEqual({ kind: 'set', quantityMilli: M(20), buyPriceMinor: null });
    expect(applyOp(held(10, 15000), { op: 'set', quantityMilli: M(4) })).toEqual({ kind: 'set', quantityMilli: M(4), buyPriceMinor: 15000 });
    expect(applyOp(held(10, 15000), { op: 'set', quantityMilli: 0 })).toEqual({ kind: 'remove' });
    expect(applyOp(null, { op: 'set', quantityMilli: M(20) })).toEqual({ kind: 'set', quantityMilli: M(20), buyPriceMinor: null });
  });

  it('caps the quantity at 10 million shares', () => {
    expect(applyOp(null, { op: 'add', quantityMilli: M(10_000_001) })).toEqual({ kind: 'ask', what: 'too_many' });
  });

  it('values a big position to the cent', () => {
    // 9,999,999,999 × 99,999,999 / 1000 = 999,999,989,900,000.001: exact, no float drift.
    expect(valueOf(M(9_999_999.999), 99_999_999)).toBe(999_999_989_900_000);
    expect(valueOf(M(0.5), 101)).toBe(51); // 50.5 → 51
  });
});

describe('market words', () => {
  it.each([
    ['טבע בת״א', 'tase'],
    ['50 מניות טבע בבורסה בתל אביב', 'tase'],
    ['קניתי TEVA ב-TASE', 'tase'],
    ['אפל בארה״ב', 'us'],
    ['אפל בנאסד"ק', 'us'],
    ['NVDA on NASDAQ', 'us'],
    ['אפל בת״א ובארה״ב', 'both'],
    ['קניתי 10 אפל', undefined],
    ['התאמה', undefined],
  ])('"%s" → %s', (text, expected) => expect(marketWordsIn(text)).toBe(expected));
});

// -- the store and the tools ------------------------------------------------------

describe('portfolio tools', () => {
  let driver: TestSqlDriver;
  let store: HoldingStore;
  let ctx: ToolContext;
  let now: number;

  const make = (sources: QuoteSources, over: Partial<ToolContext> = {}): ToolContext => ({ ...ctx, quotes: sources, ...over });

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    now = NOW;
    store = new HoldingStore(driver, () => now);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      notes: new NoteStore(driver, () => NOW),
      holdings: store,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
    };
  });
  afterEach(() => driver.close());

  async function run(slots: Record<string, unknown>, c: ToolContext) {
    const out = await portfolioUpdate.resolveAsync!(slots, c);
    if (out.kind !== 'ready') return { out, result: null };
    return { out, result: await portfolioUpdate.execute(out.input, c) };
  }

  it('adds a US stock with a buy price, checked with the source, and Undo takes it out', async () => {
    const sources = fakeSources({ 'AAPL@us': ok(quote(33667, 'USD')) });
    const { result } = await run({ op: 'add', symbol: 'aapl', quantity: 10, buy_price: 150 }, make(sources));
    expect(plain(result!.text)).toContain('הוספתי לתיק: AAPL · ארה״ב');
    expect(plain(result!.text)).toContain('מחיר קנייה ממוצע $150.00');
    expect(plain(result!.text)).toContain('מחיר עכשיו: $336.67');
    expect(store.all(PRINCIPAL)).toMatchObject([{ symbol: 'AAPL', market: 'us', quantityMilli: M(10), buyPriceMinor: 15000, currency: 'USD' }]);

    expect(plain((await portfolioUpdate.undo!(result!.compensating, ctx)).text)).toContain('ביטלתי');
    expect(store.all(PRINCIPAL)).toEqual([]);
  });

  it('a stock listed in both markets is asked about; the message\'s market words win over the model', async () => {
    const both = fakeSources({ 'TEVA@us': ok(quote(3100, 'USD')), 'TEVA@tase': ok(quote(11890, 'ILS'), 'Teva') });
    expect((await run({ op: 'add', symbol: 'TEVA', quantity: 50 }, make(both))).out).toMatchObject({ clarify: { what: 'holding_market' } });

    // The words say TASE; the model said us.
    const { result } = await run({ op: 'add', symbol: 'TEVA', market: 'us', quantity: 50 }, make(both, { marketWords: 'tase' }));
    expect(plain(result!.text)).toContain('TEVA · ת״א · Teva');
    expect(store.find(PRINCIPAL, 'TEVA', 'tase')).not.toBeNull();
    expect(store.find(PRINCIPAL, 'TEVA', 'us')).toBeNull();

    expect((await run({ op: 'add', symbol: 'AAPL', quantity: 1 }, make(both, { marketWords: 'both' }))).out).toMatchObject({
      clarify: { what: 'holding_market' },
    });
  });

  it('a TASE buy price needs its unit from the words: shekels or agorot, never a default', async () => {
    const sources = fakeSources({ 'TEVA@tase': ok(quote(11890, 'ILS')) });
    const c = make(sources, { marketWords: 'tase' });
    expect((await run({ op: 'add', symbol: 'TEVA', quantity: 50, buy_price: 6000 }, c)).out).toMatchObject({ clarify: { what: 'holding_price_unit' } });
    await run({ op: 'add', symbol: 'TEVA', quantity: 50, buy_price: 6000, buy_price_unit: 'agorot' }, c);
    expect(store.find(PRINCIPAL, 'TEVA', 'tase')!.buyPriceMinor).toBe(6000);
    await run({ op: 'set', symbol: 'TEVA', quantity: 50, buy_price: 61.5, buy_price_unit: 'shekel' }, c);
    expect(store.find(PRINCIPAL, 'TEVA', 'tase')!.buyPriceMinor).toBe(6150);
  });

  it('".TA" names TASE; an unknown symbol and a source that is down are said so', async () => {
    const sources = fakeSources({ 'LUMI@tase': ok(quote(7229, 'ILS')), 'DOWN@us': { kind: 'error' } });
    await run({ op: 'add', symbol: 'LUMI.TA', quantity: 100 }, make(sources));
    expect(store.find(PRINCIPAL, 'LUMI', 'tase')).not.toBeNull();
    expect((await run({ op: 'add', symbol: 'NOSUCH', quantity: 1 }, make(sources))).out).toMatchObject({ clarify: { what: 'holding_unknown' } });
    expect((await run({ op: 'add', symbol: 'DOWN', quantity: 1 }, make(sources))).out).toMatchObject({ clarify: { what: 'quotes_down' } });
  });

  it('a held stock needs no network to sell; "how many?" and "add or total?" are asked', async () => {
    const sources = fakeSources({ 'AAPL@us': ok(quote(33667, 'USD')) });
    await run({ op: 'add', symbol: 'AAPL', quantity: 10, buy_price: 150 }, make(sources));
    sources.calls.length = 0;
    const { result } = await run({ op: 'reduce', symbol: 'AAPL', quantity: 3 }, make(sources));
    expect(sources.calls).toEqual([]);
    expect(plain(result!.text)).toContain('7 מניות');
    expect((await run({ symbol: 'AAPL', quantity: 3 }, make(sources))).out).toMatchObject({ clarify: { what: 'holding_op' } });
    expect((await run({ op: 'add', symbol: 'AAPL' }, make(sources))).out).toMatchObject({ clarify: { what: 'holding_quantity' } });
    expect((await run({ op: 'add', symbol: 'AAPL', quantity: 2 }, make(sources))).out).toMatchObject({ clarify: { what: 'holding_buy_price' } });
    expect((await run({ op: 'reduce', symbol: 'MSFT', quantity: 2 }, make(sources))).out).toMatchObject({ clarify: { what: 'holding_reduce_none' } });
  });

  it('Undo is refused when the holding changed since, and a removal comes back', async () => {
    const sources = fakeSources({ 'AAPL@us': ok(quote(33667, 'USD')) });
    const first = await run({ op: 'add', symbol: 'AAPL', quantity: 10, buy_price: 150 }, make(sources));
    await run({ op: 'add', symbol: 'AAPL', quantity: 5, buy_price: 180 }, make(sources));
    expect(plain((await portfolioUpdate.undo!(first.result!.compensating, ctx)).text)).toContain('השתנתה מאז');
    expect(store.find(PRINCIPAL, 'AAPL', 'us')!.quantityMilli).toBe(M(15));

    const sold = await run({ op: 'reduce', symbol: 'AAPL', quantity: 15 }, make(sources));
    expect(plain(sold.result!.text)).toContain('הסרתי מהתיק');
    expect(store.all(PRINCIPAL)).toEqual([]);
    await portfolioUpdate.undo!(sold.result!.compensating, ctx);
    expect(store.find(PRINCIPAL, 'AAPL', 'us')).toMatchObject({ quantityMilli: M(15), buyPriceMinor: 16000 });
  });

  it('holds at most 20 stocks, all or nothing', async () => {
    for (let i = 0; i < MAX_HOLDINGS; i++) {
      store.mutate(PRINCIPAL, { symbol: `S${i}`, market: 'us', name: null, currency: 'USD' }, { op: 'add', quantityMilli: M(1) });
    }
    const sources = fakeSources({ 'AAPL@us': ok(quote(33667, 'USD')) });
    expect((await run({ op: 'add', symbol: 'AAPL', quantity: 1 }, make(sources))).out).toMatchObject({ clarify: { what: 'holdings_full' } });
    expect(store.all(PRINCIPAL)).toHaveLength(MAX_HOLDINGS);
  });

  describe('portfolio.show', () => {
    const show = async (c: ToolContext) => plain((await portfolioShow.execute({}, c)).text);
    const boi = (rate: number) =>
      (() => Promise.resolve(Response.json({ exchangeRates: [{ key: 'USD', currentExchangeRate: rate, unit: 1, lastUpdate: '2026-10-07T12:00:00' }] }))) as unknown as typeof fetch;

    it('empty: how to start, and where old stock notes are', async () => {
      expect(await show(make(fakeSources({})))).toContain('התיק ריק');
    });

    it('each holding: price, change, value and P/L in its currency; the ₪ total at the representative rate', async () => {
      store.mutate(PRINCIPAL, { symbol: 'AAPL', market: 'us', name: null, currency: 'USD' }, { op: 'add', quantityMilli: M(10), buyPriceMinor: 15000 });
      store.mutate(PRINCIPAL, { symbol: 'TEVA', market: 'tase', name: 'Teva', currency: 'ILS' }, { op: 'add', quantityMilli: M(50) });
      const sources = fakeSources({
        'AAPL@us': ok(quote(20000, 'USD', { prevCloseMinor: 19000 })),
        'TEVA@tase': ok(quote(11890, 'ILS', { prevCloseMinor: 11990, marketOpen: false, asOf: Date.parse('2026-10-07T14:24:00Z') })),
      });
      const text = await show(make(sources, { fetchImpl: boi(3.65) }));
      expect(text).toContain('$200.00 · היום +5.26%');
      expect(text).toContain('שווי $2,000.00 · רווח/הפסד +$500.00 (+33.33%) בדולרים, לא כולל שינוי שער');
      expect(text).toContain('₪118.90 · סגירה אחרונה 7.10 · -0.83%');
      expect(text).toContain('שווי ₪5,945.00 · רווח/הפסד: —');
      // 2,000 × 3.65 = 7,300 + 5,945 = 13,245.
      expect(text).toContain('סה״כ שווי: ₪13,245.00, לפי השער היציג מ-2026-10-07');
      expect(text).toContain('רווח/הפסד בדולרים: +$500.00 (1 מתוך 1)');
      expect(text).not.toContain('רווח/הפסד בשקלים');
    });

    it('a fresh cached quote is not fetched again; a failed source serves the old one, labelled; none at all makes the total partial', async () => {
      store.mutate(PRINCIPAL, { symbol: 'AAPL', market: 'us', name: null, currency: 'USD' }, { op: 'add', quantityMilli: M(1) });
      store.mutate(PRINCIPAL, { symbol: 'MSFT', market: 'us', name: null, currency: 'USD' }, { op: 'add', quantityMilli: M(1) });
      const good = fakeSources({ 'AAPL@us': ok(quote(20000, 'USD')) });
      await show(make(good, { fetchImpl: boi(3.65) }));
      good.calls.length = 0;
      await show(make(good, { fetchImpl: boi(3.65) }));
      expect(good.calls).toEqual(['MSFT@us']);

      now = NOW + 10 * 60_000; // past the open-market freshness
      const down = fakeSources({ 'AAPL@us': { kind: 'error' }, 'MSFT@us': { kind: 'error' } });
      const text = await show(make(down, { fetchImpl: boi(3.65), nowMs: now }));
      expect(text).toContain('המקור לא זמין כרגע');
      expect(text).toContain('מחיר לא זמין כרגע');
      expect(text).toContain('סה״כ שווי (חלקי: 1 מתוך 2)');
    });

    it('a quote in another currency than the holding\'s is not used', async () => {
      store.mutate(PRINCIPAL, { symbol: 'TEVA', market: 'tase', name: null, currency: 'ILS' }, { op: 'add', quantityMilli: M(1) });
      const text = await show(make(fakeSources({ 'TEVA@tase': ok(quote(500, 'USD')) })));
      expect(text).toContain('מחיר לא זמין כרגע');
    });

    it('no exchange rate today: each currency on its own', async () => {
      store.mutate(PRINCIPAL, { symbol: 'AAPL', market: 'us', name: null, currency: 'USD' }, { op: 'add', quantityMilli: M(1) });
      const failing = (() => Promise.reject(new Error('down'))) as unknown as typeof fetch;
      const text = await show(make(fakeSources({ 'AAPL@us': ok(quote(20000, 'USD')) }), { fetchImpl: failing }));
      expect(text).toContain('$200.00 (שער הדולר לא זמין כרגע)');
    });
  });

  it('the scheduled send renders the same report, and one line when nothing is held', async () => {
    const reminder = { id: 'r1', principal: PRINCIPAL, text: 'תיק המניות (שליחה קבועה)', action: 'portfolio' as const, lateByMs: 0 };
    const deps = { nowMs: NOW, lang: 'he' as const, repo: ctx.repo, log: createFakeLogger(), fetchImpl: fetch };
    const empty = await scheduledReadMessage(reminder as never, { ...deps, portfolio: () => Promise.resolve(null) });
    expect(plain(empty!)).toContain(portfolioText.emptyScheduled('he'));
    const full = await scheduledReadMessage(reminder as never, { ...deps, portfolio: () => Promise.resolve('תיק המניות:\n• AAPL') });
    expect(plain(full!)).toContain('• AAPL');
  });
});

describe('the portfolio in an agent turn', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let store: HoldingStore;
  let agents: FakeAgent[];
  let seq = 0;
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
  const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });

  const deps = (steps: FakeStep[], quotes: QuoteSources): PipelineDeps => {
    const agent = createFakeAgent(steps);
    agents.push(agent);
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      holdings: store,
      quotes,
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      agent: {
        providers: [agent],
        budget: new TokenBudget(() => NOW),
        history: new ConversationHistory(driver, () => NOW, keyring),
        lock: new AgentLock(driver, () => NOW),
      },
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app' };
  };
  const say = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.pf.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    store = new HoldingStore(driver, () => NOW);
    agents = [];
  });
  afterEach(() => driver.close());

  it('the words of the message pick the market, the reply is private, and no price reaches the model', async () => {
    const both = fakeSources({ 'TEVA@us': ok(quote(3100, 'USD')), 'TEVA@tase': ok(quote(11890, 'ILS'), 'Teva') });
    const out = await handleInbound(
      say('קניתי 50 מניות טבע בת״א'),
      deps([{ tool: 'portfolio.update', args: { op: 'add', symbol: 'TEVA', market: 'us', quantity: 50 } }, { text: 'בוצע' }], both),
    );
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(out.private).toBe(true);
    expect(store.find(PRINCIPAL, 'TEVA', 'tase')).not.toBeNull();

    await handleInbound(say('מה שווי התיק?'), deps([{ tool: 'portfolio.show', args: {} }], both));
    const seen = agents.map((agent) => seenByModel(agent)).join('\n');
    expect(seen).not.toContain('118.90');
    expect(seen).not.toContain('11890');
  });
});

describe('the confirmation says what will change', () => {
  it('names the action and the quantity: add, set and reduce read differently', () => {
    const base = { symbol: 'TEVA', market: 'tase', name: null, currency: 'ILS', quantityMilli: 50_000 } as const;
    expect(plain(portfolioUpdate.preview({ ...base, op: 'add', buyPriceMinor: 6000 }, 'he'))).toBe('להוסיף לתיק 50 מניות במחיר ₪60.00: TEVA · ת״א');
    expect(plain(portfolioUpdate.preview({ ...base, op: 'set' }, 'he'))).toBe('לקבוע בתיק 50 מניות בסך הכול: TEVA · ת״א');
    expect(plain(portfolioUpdate.preview({ ...base, op: 'reduce' }, 'he'))).toBe('להוריד מהתיק 50 מניות: TEVA · ת״א');
  });
});

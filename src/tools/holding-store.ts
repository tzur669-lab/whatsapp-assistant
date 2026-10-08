/**
 * The stock portfolio's rows (PLAN §6.24, ROADMAP block H part 19).
 *
 * Private like notes. Synchronous over `SqlDriver`: the rules in `applyOp` run
 * on the row as it is inside the same transaction that writes it, so nothing
 * changes between the check and the write.
 *
 * Money in integer minor units of the holding's own currency; quantity in
 * thousandths of a share. One average buy price per holding, never a guess:
 * where the rules cannot know it, they ask (`applyOp`).
 *
 * Removals are soft and every change bumps `version`. An Undo names the row and
 * the version it left; if the row changed since, the Undo is refused.
 */
import type { SqlDriver } from '../core/sql.js';
import { UNDO_EXPIRY_MS } from '../confirm/undo.js';
import type { Currency, Market, Quote } from '../lookup/quotes.js';

export const MAX_HOLDINGS = 20;
/** 10 million shares, in thousandths. Matches the table's CHECK. */
export const MAX_QUANTITY_MILLI = 10_000_000_000;
/** How long a quote is fresh: open market, then closed. */
export const QUOTE_FRESH_OPEN_MS = 5 * 60_000;
export const QUOTE_FRESH_CLOSED_MS = 2 * 60 * 60_000;
/** Older than this, a cached quote is not even served as stale. */
export const QUOTE_KEEP_MS = 3 * 24 * 60 * 60_000;

export type Holding = {
  id: string;
  symbol: string;
  market: Market;
  name: string | null;
  quantityMilli: number;
  buyPriceMinor: number | null;
  currency: Currency;
  version: number;
};

export type Op = 'set' | 'add' | 'reduce';

export type OpInput = {
  op: Op;
  quantityMilli: number;
  buyPriceMinor?: number;
  /** The price of the shares held before, asked for when an add brings a price and none is stored. */
  previousBuyPriceMinor?: number;
  /** The user said the earlier price is not known. */
  previousUnknown?: true;
};

/** Why the rules stop and ask (invariant 12: never a guess). */
export type OpQuestion = 'buy_price' | 'previous_price' | 'reduce_below' | 'reduce_none' | 'too_many';

export type OpResult =
  | { kind: 'set'; quantityMilli: number; buyPriceMinor: number | null }
  | { kind: 'remove' }
  | { kind: 'unchanged' }
  | { kind: 'ask'; what: OpQuestion };

type Position = { quantityMilli: number; buyPriceMinor: number | null };

/** `(q1·p1 + q2·p2) / (q1 + q2)`, rounded once, in BigInt so nothing overflows. */
export function weightedAverage(q1: number, p1: number, q2: number, p2: number): number {
  const num = BigInt(q1) * BigInt(p1) + BigInt(q2) * BigInt(p2);
  const den = BigInt(q1 + q2);
  return Number((num * 2n + den) / (2n * den));
}

/** The table in PLAN §6.24, in code. Pure. */
export function applyOp(current: Position | null, input: OpInput): OpResult {
  const q = input.quantityMilli;
  const p = input.buyPriceMinor;
  const capped = (result: OpResult): OpResult =>
    result.kind === 'set' && result.quantityMilli > MAX_QUANTITY_MILLI ? { kind: 'ask', what: 'too_many' } : result;

  switch (input.op) {
    case 'add': {
      if (q <= 0) return { kind: 'unchanged' };
      if (!current) return capped({ kind: 'set', quantityMilli: q, buyPriceMinor: p ?? null });
      return capped(grow(current, q, input));
    }
    case 'reduce': {
      if (!current) return { kind: 'ask', what: 'reduce_none' };
      if (q > current.quantityMilli) return { kind: 'ask', what: 'reduce_below' };
      if (q === current.quantityMilli) return { kind: 'remove' };
      if (q <= 0) return { kind: 'unchanged' };
      return { kind: 'set', quantityMilli: current.quantityMilli - q, buyPriceMinor: current.buyPriceMinor };
    }
    case 'set': {
      if (q === 0) return current ? { kind: 'remove' } : { kind: 'ask', what: 'reduce_none' };
      // A price said with the total replaces the whole basis: the user stated it.
      if (p !== undefined) return capped({ kind: 'set', quantityMilli: q, buyPriceMinor: p });
      if (!current) return capped({ kind: 'set', quantityMilli: q, buyPriceMinor: null });
      if (q === current.quantityMilli) return { kind: 'unchanged' };
      if (q < current.quantityMilli) return { kind: 'set', quantityMilli: q, buyPriceMinor: current.buyPriceMinor };
      // More than before, with no price: the difference is an add.
      return capped(grow(current, q - current.quantityMilli, input));
    }
  }
}

function grow(current: Position, q: number, input: OpInput): OpResult {
  const p = input.buyPriceMinor;
  const total = current.quantityMilli + q;
  if (current.buyPriceMinor !== null) {
    if (p === undefined) return { kind: 'ask', what: 'buy_price' };
    return { kind: 'set', quantityMilli: total, buyPriceMinor: weightedAverage(current.quantityMilli, current.buyPriceMinor, q, p) };
  }
  if (p === undefined) return { kind: 'set', quantityMilli: total, buyPriceMinor: null };
  // One price per holding cannot hold a mixed basis: ask for the earlier one.
  if (input.previousBuyPriceMinor !== undefined) {
    return { kind: 'set', quantityMilli: total, buyPriceMinor: weightedAverage(current.quantityMilli, input.previousBuyPriceMinor, q, p) };
  }
  if (input.previousUnknown) return { kind: 'set', quantityMilli: total, buyPriceMinor: null };
  return { kind: 'ask', what: 'previous_price' };
}

/** What an Undo needs: the row, the version this change left, and what was there before. */
export type HoldingChange = {
  id: string;
  version: number;
  /** null: the change created the holding. */
  before: Position | null;
  /** The change removed it (soft). */
  removed: boolean;
};

export type MutateOutcome =
  | { kind: 'done'; holding: Holding | null; previous: Position | null; change: HoldingChange }
  | { kind: 'unchanged'; holding: Holding }
  | { kind: 'ask'; what: OpQuestion }
  | { kind: 'full' };

export type UndoOutcome = 'done' | 'changed' | 'clash' | 'full';

export type NewHolding = { symbol: string; market: Market; name: string | null; currency: Currency };

export class HoldingStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** Active holdings, in the order they were added. */
  all(principal: string): Holding[] {
    return this.sql
      .exec('SELECT * FROM holdings WHERE principal = ? AND removed_at IS NULL ORDER BY added_at, rowid', principal)
      .map(rowToHolding);
  }

  find(principal: string, symbol: string, market: Market): Holding | null {
    const row = this.sql.exec(
      'SELECT * FROM holdings WHERE principal = ? AND symbol = ? AND market = ? AND removed_at IS NULL',
      principal,
      symbol,
      market,
    )[0];
    return row ? rowToHolding(row) : null;
  }

  /** Active holdings with this symbol, in any market. */
  bySymbol(principal: string, symbol: string): Holding[] {
    return this.sql
      .exec('SELECT * FROM holdings WHERE principal = ? AND symbol = ? AND removed_at IS NULL ORDER BY market', principal, symbol)
      .map(rowToHolding);
  }

  /**
   * Apply one change by the rules, on the row as it is now. `create` describes
   * the holding if the change makes a new one.
   */
  mutate(principal: string, create: NewHolding, input: OpInput): MutateOutcome {
    return this.sql.transaction((): MutateOutcome => {
      const current = this.find(principal, create.symbol, create.market);
      const result = applyOp(current, input);
      if (result.kind === 'ask') return result;
      if (result.kind === 'unchanged') {
        if (current) return { kind: 'unchanged', holding: current };
        return { kind: 'ask', what: 'reduce_none' };
      }
      const now = this.now();
      if (result.kind === 'remove') {
        const held = current!;
        this.sql.exec('UPDATE holdings SET removed_at = ?, version = version + 1 WHERE id = ?', now, held.id);
        const before = { quantityMilli: held.quantityMilli, buyPriceMinor: held.buyPriceMinor };
        return { kind: 'done', holding: null, previous: before, change: { id: held.id, version: held.version + 1, before, removed: true } };
      }
      if (current) {
        this.sql.exec(
          'UPDATE holdings SET quantity_milli = ?, buy_price_minor = ?, version = version + 1 WHERE id = ?',
          result.quantityMilli,
          result.buyPriceMinor,
          current.id,
        );
        const before = { quantityMilli: current.quantityMilli, buyPriceMinor: current.buyPriceMinor };
        const holding = { ...current, quantityMilli: result.quantityMilli, buyPriceMinor: result.buyPriceMinor, version: current.version + 1 };
        return { kind: 'done', holding, previous: before, change: { id: current.id, version: holding.version, before, removed: false } };
      }
      if (this.all(principal).length >= MAX_HOLDINGS) return { kind: 'full' };
      const id = randomHex(12);
      this.sql.exec(
        `INSERT INTO holdings (id, principal, symbol, market, name, quantity_milli, buy_price_minor, currency, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        principal,
        create.symbol,
        create.market,
        create.name,
        result.quantityMilli,
        result.buyPriceMinor,
        create.currency,
        now,
      );
      const holding: Holding = { id, ...create, quantityMilli: result.quantityMilli, buyPriceMinor: result.buyPriceMinor, version: 0 };
      return { kind: 'done', holding, previous: null, change: { id, version: 0, before: null, removed: false } };
    });
  }

  /** Put the row back as it was, unless it changed since, its symbol is held again, or the portfolio is full. */
  undo(principal: string, change: HoldingChange): UndoOutcome {
    return this.sql.transaction((): UndoOutcome => {
      const row = this.sql.exec('SELECT * FROM holdings WHERE id = ? AND principal = ?', change.id, principal)[0];
      if (!row || Number(row['version']) !== change.version) return 'changed';
      const removed = row['removed_at'] !== null && row['removed_at'] !== undefined;
      if (removed !== change.removed) return 'changed';
      const now = this.now();
      if (change.before === null) {
        this.sql.exec('UPDATE holdings SET removed_at = ?, version = version + 1 WHERE id = ?', now, change.id);
        return 'done';
      }
      if (change.removed) {
        const holding = rowToHolding(row);
        if (this.find(principal, holding.symbol, holding.market)) return 'clash';
        if (this.all(principal).length >= MAX_HOLDINGS) return 'full';
        this.sql.exec(
          'UPDATE holdings SET removed_at = NULL, quantity_milli = ?, buy_price_minor = ?, version = version + 1 WHERE id = ?',
          change.before.quantityMilli,
          change.before.buyPriceMinor,
          change.id,
        );
        return 'done';
      }
      this.sql.exec(
        'UPDATE holdings SET quantity_milli = ?, buy_price_minor = ?, version = version + 1 WHERE id = ?',
        change.before.quantityMilli,
        change.before.buyPriceMinor,
        change.id,
      );
      return 'done';
    });
  }

  // -- the quote cache: public prices, no principal ---------------------------

  cached(symbol: string, market: Market): (Quote & { fetchedAt: number }) | null {
    const row = this.sql.exec('SELECT * FROM quote_cache WHERE symbol = ? AND market = ?', symbol, market)[0];
    if (!row) return null;
    const fetchedAt = Number(row['fetched_at']);
    if (this.now() - fetchedAt > QUOTE_KEEP_MS) return null;
    return {
      priceMinor: Number(row['price_minor']),
      prevCloseMinor: row['prev_close_minor'] === null ? null : Number(row['prev_close_minor']),
      currency: String(row['currency']) as Currency,
      asOf: Number(row['as_of']),
      marketOpen: Number(row['market_open']) === 1,
      fetchedAt,
    };
  }

  keep(symbol: string, market: Market, quote: Quote): void {
    this.sql.exec(
      `INSERT INTO quote_cache (symbol, market, price_minor, prev_close_minor, currency, as_of, market_open, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (symbol, market) DO UPDATE SET price_minor = excluded.price_minor, prev_close_minor = excluded.prev_close_minor,
         currency = excluded.currency, as_of = excluded.as_of, market_open = excluded.market_open, fetched_at = excluded.fetched_at`,
      symbol,
      market,
      quote.priceMinor,
      quote.prevCloseMinor,
      quote.currency,
      quote.asOf,
      quote.marketOpen ? 1 : 0,
      this.now(),
    );
  }

  /** The daily sweep: removed rows past the Undo window, and old quotes. */
  purge(): void {
    const now = this.now();
    this.sql.exec('DELETE FROM holdings WHERE removed_at IS NOT NULL AND removed_at < ?', now - UNDO_EXPIRY_MS);
    this.sql.exec('DELETE FROM quote_cache WHERE fetched_at < ?', now - QUOTE_KEEP_MS);
  }
}

function rowToHolding(row: Record<string, unknown>): Holding {
  return {
    id: String(row['id']),
    symbol: String(row['symbol']),
    market: String(row['market']) as Market,
    name: row['name'] === null || row['name'] === undefined ? null : String(row['name']),
    quantityMilli: Number(row['quantity_milli']),
    buyPriceMinor: row['buy_price_minor'] === null || row['buy_price_minor'] === undefined ? null : Number(row['buy_price_minor']),
    currency: String(row['currency']) as Currency,
    version: Number(row['version']),
  };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

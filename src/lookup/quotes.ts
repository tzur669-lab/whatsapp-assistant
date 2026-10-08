/**
 * Stock quotes for the portfolio (PLAN §6.24, ROADMAP block H part 19).
 *
 * Two sources, chosen by the spike (2026-10-08):
 *   - US: Finnhub's free tier. The key (`QUOTES_API_KEY`) travels in the
 *     `X-Finnhub-Token` header, never in a URL, and is never logged.
 *   - TASE: Yahoo's chart endpoint. No key; unofficial, so a failure is
 *     "unavailable", never a guess.
 *
 * One call per symbol: neither source has a free batch. Units are normalized
 * here, exactly once: USD → cents, ILS → agorot, and Yahoo's ILA (agorot) as
 * is. Nothing past this file ever sees ILA or a float price.
 *
 * Only the symbol leaves the bot. Failures are returned, never thrown, and an
 * error body is never read.
 */
import { localPartsOf } from '../time/tz.js';

export type Market = 'us' | 'tase';
export type Currency = 'USD' | 'ILS';

export type Quote = {
  /** Minor units: cents or agorot. */
  priceMinor: number;
  prevCloseMinor: number | null;
  currency: Currency;
  /** When the source priced it (ms). */
  asOf: number;
  marketOpen: boolean;
};

export type SourceResult =
  | { kind: 'ok'; quote: Quote; name: string | null }
  /** The source knows no such symbol. */
  | { kind: 'unknown' }
  /** Network, status, rate limit, a malformed body — or no key. */
  | { kind: 'error' };

export interface QuoteSources {
  quote(symbol: string, market: Market): Promise<SourceResult>;
}

const TIMEOUT_MS = 8_000;
const MAX_BYTES = 200_000;
const FINNHUB = 'https://finnhub.io/api/v1';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
/** Yahoo refuses requests that name no browser-like agent. A product name, nothing of the user's. */
const YAHOO_AGENT = 'Mozilla/5.0 (compatible; PersonalAssistantBot/1.0)';

/** A ticker as stored: upper case, letters, digits, a dot or a dash. */
export const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.-]{0,11}$/;

type Got = { ok: true; value: unknown } | { ok: false; notFound: boolean };

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>): Promise<Got> {
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json', ...headers } });
  } catch {
    return { ok: false, notFound: false };
  }
  if (!response.ok) return { ok: false, notFound: response.status === 404 };
  try {
    const text = await response.text();
    if (text.length > MAX_BYTES) return { ok: false, notFound: false };
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, notFound: false };
  }
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** To minor units, from the source's own currency code. Null for anything else. */
export function toMinor(price: number, code: string): { minor: number; currency: Currency } | null {
  if (!(price > 0)) return null;
  switch (code.toUpperCase()) {
    case 'USD':
      return { minor: Math.round(price * 100), currency: 'USD' };
    case 'ILS':
      return { minor: Math.round(price * 100), currency: 'ILS' };
    case 'ILA':
      // Agorot already: TASE quotes shares in them.
      return { minor: Math.round(price), currency: 'ILS' };
    default:
      return null;
  }
}

/**
 * Whether the exchange is trading at `nowMs`, by its own clock: NYSE/Nasdaq
 * 9:30–16:00 New York, Mon–Fri; TASE 9:59–17:25 Jerusalem, Mon–Thu, to 13:50
 * on Friday (the Mon–Fri week since January 2026). Holidays are not known
 * here — a quote older than half an hour means closed, whatever the clock says.
 */
export function marketOpenAt(market: Market, nowMs: number, asOf: number): boolean {
  if (nowMs - asOf > 30 * 60_000) return false;
  const zone = market === 'us' ? 'America/New_York' : 'Asia/Jerusalem';
  const local = localPartsOf(nowMs, zone);
  const minute = local.hour * 60 + local.minute;
  if (local.weekday === 0 || local.weekday === 6) return false;
  if (market === 'us') return minute >= 9 * 60 + 30 && minute < 16 * 60;
  const close = local.weekday === 5 ? 13 * 60 + 50 : 17 * 60 + 25;
  return minute >= 9 * 60 + 59 && minute < close;
}

export function createQuoteSources(fetchImpl: typeof fetch, finnhubKey: string | undefined, now: () => number): QuoteSources {
  const key = (finnhubKey ?? '').trim();
  // A closure, never a method call on a stored fetch: Workers throws "Illegal invocation".
  const get = (url: string, headers: Record<string, string>) => getJson((input, init) => fetchImpl(input, init), url, headers);

  async function us(symbol: string): Promise<SourceResult> {
    if (!key) return { kind: 'error' };
    const got = await get(`${FINNHUB}/quote?symbol=${encodeURIComponent(symbol)}`, { 'X-Finnhub-Token': key });
    if (!got.ok) return { kind: 'error' };
    const body = got.value as Record<string, unknown> | null;
    const price = num(body?.['c']);
    const seconds = num(body?.['t']);
    if (price === null || seconds === null) return { kind: 'error' };
    // Finnhub answers an unknown symbol with zeros and HTTP 200.
    if (price <= 0 || seconds <= 0) return { kind: 'unknown' };
    const minor = toMinor(price, 'USD');
    if (!minor) return { kind: 'error' };
    const prev = num(body?.['pc']);
    const asOf = seconds * 1000;
    return {
      kind: 'ok',
      name: null,
      quote: {
        priceMinor: minor.minor,
        prevCloseMinor: prev !== null && prev > 0 ? Math.round(prev * 100) : null,
        currency: 'USD',
        asOf,
        marketOpen: marketOpenAt('us', now(), asOf),
      },
    };
  }

  async function tase(symbol: string): Promise<SourceResult> {
    const wanted = `${symbol}.TA`;
    const got = await get(`${YAHOO}/${encodeURIComponent(wanted)}?range=1d&interval=1d`, { 'user-agent': YAHOO_AGENT });
    if (!got.ok) return got.notFound ? { kind: 'unknown' } : { kind: 'error' };
    const result = (got.value as { chart?: { result?: unknown[] } } | null)?.chart?.result?.[0] as
      | { meta?: Record<string, unknown> }
      | undefined;
    const meta = result?.meta;
    if (!meta) return { kind: 'unknown' };
    // The answer must be for the symbol asked, exactly.
    if (typeof meta['symbol'] !== 'string' || meta['symbol'].toUpperCase() !== wanted) return { kind: 'error' };
    const code = typeof meta['currency'] === 'string' ? meta['currency'] : '';
    const price = num(meta['regularMarketPrice']);
    const seconds = num(meta['regularMarketTime']);
    if (price === null || seconds === null) return { kind: 'error' };
    const minor = toMinor(price, code);
    if (!minor) return { kind: 'error' };
    const prevRaw = num(meta['chartPreviousClose']) ?? num(meta['previousClose']);
    const prev = prevRaw !== null ? toMinor(prevRaw, code) : null;
    const name = typeof meta['longName'] === 'string' ? meta['longName'] : typeof meta['shortName'] === 'string' ? meta['shortName'] : null;
    const asOf = seconds * 1000;
    return {
      kind: 'ok',
      name: name ? name.slice(0, 80) : null,
      quote: {
        priceMinor: minor.minor,
        prevCloseMinor: prev && prev.currency === minor.currency ? prev.minor : null,
        currency: minor.currency,
        asOf,
        marketOpen: marketOpenAt('tase', now(), asOf),
      },
    };
  }

  return {
    quote(symbol, market) {
      if (!SYMBOL_PATTERN.test(symbol)) return Promise.resolve({ kind: 'unknown' });
      return market === 'us' ? us(symbol) : tase(symbol);
    },
  };
}

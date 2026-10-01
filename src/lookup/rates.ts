/**
 * Representative exchange rates from the Bank of Israel (free, no key).
 * Numbers and currency codes only, so a read does not taint the turn.
 */
import type { Lang } from '../render/format-time.js';
import { isolateLtr } from '../render/bidi.js';
import { getJson, num, str } from './http.js';

const RATES = 'https://boi.org.il/PublicApi/GetExchangeRates';
const DEFAULT_CODES = ['USD', 'EUR', 'GBP'];

const HE_NAMES: Record<string, string> = {
  USD: 'דולר',
  EUR: 'אירו',
  GBP: 'לירה שטרלינג',
  JPY: 'ין יפני',
  CHF: 'פרנק שווייצרי',
  CAD: 'דולר קנדי',
  AUD: 'דולר אוסטרלי',
  JOD: 'דינר ירדני',
  EGP: 'לירה מצרית',
};

type Rate = { code: string; rate: number; unit: number; updated: string | null };

function ratesOf(json: unknown): Rate[] {
  const raw = (json as { exchangeRates?: unknown[] }).exchangeRates;
  if (!Array.isArray(raw)) return [];
  const out: Rate[] = [];
  for (const entry of raw) {
    const record = entry as Record<string, unknown>;
    const code = str(record['key'], 3)?.toUpperCase();
    const rate = num(record['currentExchangeRate']);
    const unit = num(record['unit']) ?? 1;
    if (!code || !/^[A-Z]{3}$/.test(code) || rate === null || rate <= 0 || unit <= 0) continue;
    out.push({ code, rate, unit, updated: str(record['lastUpdate'], 40) });
  }
  return out;
}

const shekels = (n: number) => isolateLtr(`${n.toFixed(n >= 100 ? 2 : 3)} ₪`);

export async function ratesFor(
  fetchImpl: typeof fetch,
  currency: string | undefined,
  amount: number | undefined,
  lang: Lang,
): Promise<string | null> {
  const fetched = await getJson(fetchImpl, RATES);
  if (!fetched.ok) return null;
  const rates = ratesOf(fetched.value);
  if (rates.length === 0) return null;

  const he = lang === 'he';
  const name = (code: string) => (he ? (HE_NAMES[code] ?? code) : code);
  const wanted = currency?.toUpperCase();
  const chosen = wanted ? rates.filter((r) => r.code === wanted) : rates.filter((r) => DEFAULT_CODES.includes(r.code));
  if (wanted && chosen.length === 0) {
    return he ? `לבנק ישראל אין שער יציג ל־${isolateLtr(wanted)}.` : `The Bank of Israel publishes no rate for ${wanted}.`;
  }

  const lines = chosen.map((r) => {
    const perOne = r.rate / r.unit;
    const base = `${name(r.code)} (${isolateLtr(r.code)}): ${shekels(perOne)}`;
    if (amount === undefined || !wanted) return base;
    return `${base}. ${isolateLtr(`${amount} ${r.code}`)} = ${shekels(amount * perOne)}`;
  });
  return [he ? 'שערים יציגים של בנק ישראל:' : 'Bank of Israel representative rates:', ...lines].join('\n');
}

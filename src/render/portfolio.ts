/**
 * The stock portfolio's replies (PLAN §6.24, ROADMAP block H part 19). All
 * private: none of this goes back to the model.
 *
 * Money arrives in minor units with its currency and is shown with two
 * decimals, isolated so it reads left to right inside Hebrew. Value and gain
 * are computed per holding in the holding's own currency; only the total is
 * converted to ₪, at the Bank of Israel's representative rate, and labelled.
 */
import type { Lang } from './format-time.js';
import { isolate, isolateLtr } from './bidi.js';
import type { Currency, Market, Quote } from '../lookup/quotes.js';
import type { Holding } from '../tools/holding-store.js';
import { localPartsOf, ZONE } from '../time/tz.js';

/** `$1,234.56`, `₪118.90`; with `signed`, a leading + or -. */
export function money(minor: number, currency: Currency, signed = false): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100).toLocaleString('en-US');
  const cents = String(abs % 100).padStart(2, '0');
  const sign = negative ? '-' : signed ? '+' : '';
  return isolateLtr(`${sign}${currency === 'USD' ? '$' : '₪'}${whole}.${cents}`);
}

function percent(ratio: number): string {
  const value = ratio * 100;
  return isolateLtr(`${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(2)}%`);
}

/** Thousandths of a share, as a number with at most three decimals. */
export function shares(quantityMilli: number): string {
  return (quantityMilli / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 });
}

const plural = new Intl.PluralRules('he-IL');

function sharesText(quantityMilli: number, lang: Lang): string {
  const count = quantityMilli / 1000;
  if (lang === 'en') return `${shares(quantityMilli)} ${count === 1 ? 'share' : 'shares'}`;
  if (Number.isInteger(count)) {
    switch (plural.select(count)) {
      case 'one':
        return 'מניה אחת';
      case 'two':
        return 'שתי מניות';
    }
  }
  return `${isolateLtr(shares(quantityMilli))} מניות`;
}

/** `quantity × price`, rounded once, in BigInt: a big position must not lose cents. */
export function valueOf(quantityMilli: number, priceMinor: number): number {
  const product = BigInt(quantityMilli) * BigInt(priceMinor);
  const sign = product < 0n ? -1n : 1n;
  const abs = product * sign;
  return Number(((abs + 500n) / 1000n) * sign);
}

function dayMonth(ms: number): string {
  const local = localPartsOf(ms, ZONE);
  return isolateLtr(`${local.day}.${local.month}`);
}

function dayMonthTime(ms: number): string {
  const local = localPartsOf(ms, ZONE);
  return isolateLtr(`${local.day}.${local.month} ${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`);
}

function marketName(market: Market, lang: Lang): string {
  if (lang === 'en') return market === 'us' ? 'US' : 'TASE';
  return market === 'us' ? 'ארה״ב' : 'ת״א';
}

/** `AAPL · ארה״ב` or `TEVA · ת״א · Teva Pharmaceutical`. */
export function holdingLabel(holding: Pick<Holding, 'symbol' | 'market' | 'name'>, lang: Lang): string {
  const parts = [isolateLtr(holding.symbol), marketName(holding.market, lang)];
  if (holding.name) parts.push(isolate(holding.name));
  return parts.join(' · ');
}

export type PricedHolding = {
  holding: Holding;
  /** Null: no quote now and none cached. */
  quote: Quote | null;
  /** The quote is an old one, served because the source failed. */
  stale: boolean;
};

export type UsdRate = { rate: number; date: string | null } | null;

export const portfolioText = {
  /** After a change: what the holding is now, with the price the source gave. */
  updated(holding: Holding | null, before: Holding | null, label: string, quote: Quote | null, lang: Lang): string {
    const he = lang === 'he';
    if (!holding) return he ? `הסרתי מהתיק: ${label}.` : `Removed from the portfolio: ${label}.`;
    const lines = [
      before
        ? he
          ? `עדכנתי בתיק: ${label}`
          : `Updated in the portfolio: ${label}`
        : he
          ? `הוספתי לתיק: ${label}`
          : `Added to the portfolio: ${label}`,
      `${sharesText(holding.quantityMilli, lang)}${
        holding.buyPriceMinor !== null
          ? he
            ? ` · מחיר קנייה ממוצע ${money(holding.buyPriceMinor, holding.currency)}`
            : ` · average buy price ${money(holding.buyPriceMinor, holding.currency)}`
          : he
            ? ' · בלי מחיר קנייה, אז אין חישוב רווח/הפסד'
            : ' · no buy price, so no gain or loss'
      }`,
    ];
    if (quote) {
      lines.push(he ? `מחיר עכשיו: ${money(quote.priceMinor, quote.currency)}` : `Price now: ${money(quote.priceMinor, quote.currency)}`);
    }
    return lines.join('\n');
  },

  unchanged(label: string, lang: Lang): string {
    return lang === 'he' ? `לא היה מה לשנות: ${label}.` : `Nothing to change: ${label}.`;
  },

  undone(lang: Lang): string {
    return lang === 'he' ? 'ביטלתי. התיק חזר למה שהיה.' : 'Undone. The portfolio is back as it was.';
  },

  undoRefused(reason: 'changed' | 'clash' | 'full', lang: Lang): string {
    const he = lang === 'he';
    switch (reason) {
      case 'changed':
        return he ? 'המניה השתנתה מאז, אז לא ביטלתי.' : 'The holding changed since, so nothing was undone.';
      case 'clash':
        return he ? 'המניה כבר שוב בתיק, אז לא ביטלתי.' : 'The stock is back in the portfolio already, so nothing was undone.';
      case 'full':
        return he ? 'התיק מלא, אז לא ביטלתי.' : 'The portfolio is full, so nothing was undone.';
    }
  },

  /** What a confirmation shows: the action and the quantity, so `set` and `add` cannot be confused. */
  preview(op: 'set' | 'add' | 'reduce', label: string, quantityMilli: number, buyPrice: { minor: number; currency: Currency } | null, lang: Lang): string {
    const he = lang === 'he';
    const count = sharesText(quantityMilli, lang);
    const price = buyPrice ? (he ? ` במחיר ${money(buyPrice.minor, buyPrice.currency)}` : ` at ${money(buyPrice.minor, buyPrice.currency)}`) : '';
    switch (op) {
      case 'add':
        return he ? `להוסיף לתיק ${count}${price}: ${label}` : `Add ${count}${price} to the portfolio: ${label}`;
      case 'reduce':
        return he ? `להוריד מהתיק ${count}: ${label}` : `Remove ${count} from the portfolio: ${label}`;
      case 'set':
        return he ? `לקבוע בתיק ${count} בסך הכול${price}: ${label}` : `Set the portfolio to ${count} in all${price}: ${label}`;
    }
  },

  /** The whole portfolio, as `portfolio.show` and the scheduled send render it. */
  show(priced: readonly PricedHolding[], usd: UsdRate, lang: Lang): string {
    const he = lang === 'he';
    const lines: string[] = [he ? 'תיק המניות:' : 'Your portfolio:'];

    let ilsTotal = 0;
    const byCurrency: Record<Currency, number> = { USD: 0, ILS: 0 };
    const gain: Record<Currency, { minor: number; counted: number; of: number }> = {
      USD: { minor: 0, counted: 0, of: 0 },
      ILS: { minor: 0, counted: 0, of: 0 },
    };
    let withPrice = 0;
    let convertible = true;

    for (const { holding, quote, stale } of priced) {
      lines.push(`• ${holdingLabel(holding, lang)} · ${sharesText(holding.quantityMilli, lang)}`);
      gain[holding.currency].of += 1;
      // A quote in another currency than the holding's is not used (PLAN §6.24).
      if (!quote || quote.currency !== holding.currency) {
        lines.push(he ? '  מחיר לא זמין כרגע.' : '  Price unavailable right now.');
        continue;
      }
      withPrice += 1;

      let priceLine = `  ${money(quote.priceMinor, quote.currency)}`;
      if (quote.prevCloseMinor !== null && quote.prevCloseMinor > 0) {
        const change = percent((quote.priceMinor - quote.prevCloseMinor) / quote.prevCloseMinor);
        priceLine += quote.marketOpen
          ? he
            ? ` · היום ${change}`
            : ` · today ${change}`
          : he
            ? ` · סגירה אחרונה ${dayMonth(quote.asOf)} · ${change}`
            : ` · last close ${dayMonth(quote.asOf)} · ${change}`;
      } else {
        priceLine += ' · —';
      }
      lines.push(priceLine);
      if (stale) {
        lines.push(he ? `  מחיר מ-${dayMonthTime(quote.asOf)}: המקור לא זמין כרגע.` : `  Price from ${dayMonthTime(quote.asOf)}: the source is unavailable.`);
      }

      const value = valueOf(holding.quantityMilli, quote.priceMinor);
      byCurrency[holding.currency] += value;
      if (holding.currency === 'ILS') ilsTotal += value;
      else if (usd) ilsTotal += Math.round(value * usd.rate);
      else convertible = false;

      let valueLine = he ? `  שווי ${money(value, holding.currency)}` : `  value ${money(value, holding.currency)}`;
      if (holding.buyPriceMinor !== null) {
        const pl = value - valueOf(holding.quantityMilli, holding.buyPriceMinor);
        gain[holding.currency].minor += pl;
        gain[holding.currency].counted += 1;
        const pct = percent((quote.priceMinor - holding.buyPriceMinor) / holding.buyPriceMinor);
        valueLine += he
          ? ` · רווח/הפסד ${money(pl, holding.currency, true)} (${pct})${holding.currency === 'USD' ? ' בדולרים, לא כולל שינוי שער' : ''}`
          : ` · gain/loss ${money(pl, holding.currency, true)} (${pct})${holding.currency === 'USD' ? ' in dollars, before exchange rate' : ''}`;
      } else {
        valueLine += he ? ' · רווח/הפסד: —' : ' · gain/loss: —';
      }
      lines.push(valueLine);
    }

    lines.push('');
    const partial = withPrice < priced.length;
    const partialNote = partial
      ? he
        ? ` (חלקי: ${isolateLtr(`${withPrice}`)} מתוך ${isolateLtr(`${priced.length}`)})`
        : ` (partial: ${withPrice} of ${priced.length})`
      : '';
    if (convertible) {
      const rateNote =
        byCurrency.USD > 0 && usd
          ? he
            ? `, לפי השער היציג${usd.date ? ` מ-${isolateLtr(usd.date.slice(0, 10))}` : ''} (${isolateLtr(`$1 = ₪${usd.rate.toFixed(3)}`)})`
            : `, at the representative rate${usd.date ? ` of ${usd.date.slice(0, 10)}` : ''} ($1 = ₪${usd.rate.toFixed(3)})`
          : '';
      lines.push(he ? `סה״כ שווי${partialNote}: ${money(ilsTotal, 'ILS')}${rateNote}` : `Total value${partialNote}: ${money(ilsTotal, 'ILS')}${rateNote}`);
    } else {
      // No rate today: each currency on its own.
      const parts = (['USD', 'ILS'] as const).filter((c) => byCurrency[c] > 0).map((c) => money(byCurrency[c], c));
      lines.push(he ? `סה״כ שווי${partialNote}: ${parts.join(' + ')} (שער הדולר לא זמין כרגע)` : `Total value${partialNote}: ${parts.join(' + ')} (no exchange rate right now)`);
    }
    for (const currency of ['USD', 'ILS'] as const) {
      const g = gain[currency];
      if (g.counted === 0) continue;
      const of = he ? ` (${isolateLtr(`${g.counted}`)} מתוך ${isolateLtr(`${g.of}`)})` : ` (${g.counted} of ${g.of})`;
      lines.push(
        currency === 'USD'
          ? he
            ? `רווח/הפסד בדולרים: ${money(g.minor, 'USD', true)}${of}`
            : `Gain/loss in dollars: ${money(g.minor, 'USD', true)}${of}`
          : he
            ? `רווח/הפסד בשקלים: ${money(g.minor, 'ILS', true)}${of}`
            : `Gain/loss in shekels: ${money(g.minor, 'ILS', true)}${of}`,
      );
    }
    return lines.join('\n');
  },

  /** The scheduled send, with nothing held. */
  emptyScheduled(lang: Lang): string {
    return lang === 'he' ? 'התיק ריק. אפשר לבטל את השליחה הקבועה.' : 'The portfolio is empty. The scheduled send can be cancelled.';
  },
};

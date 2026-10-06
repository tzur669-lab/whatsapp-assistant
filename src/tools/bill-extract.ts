/**
 * Reading a bill's amount and due date out of a mail, in code (ROADMAP #24,
 * 2026-10-06). No model reads the mail for this: it is someone else's text,
 * and a number the model copies is a number the model can get wrong.
 *
 * Deliberately narrow. An amount must sit next to a shekel sign or word; a due
 * date must follow words that say "pay by". What is not found is left out of
 * the reply rather than guessed — the user opens the mail for the rest.
 */
import { isRealDate } from '../time/tz.js';

export type BillFacts = {
  /** Shekels, as written: up to two decimals. */
  amount: number | null;
  /** The due day, as a calendar date. */
  due: { year: number; month: number; day: number } | null;
};

const CURRENCY = String.raw`(?:₪|ש"ח|ש״ח|שקלים|שקל|NIS|ILS)`;
const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const AMOUNT_BEFORE = new RegExp(`${CURRENCY}\\s?${NUMBER}`, 'g');
const AMOUNT_AFTER = new RegExp(`${NUMBER}\\s?${CURRENCY}`, 'g');
/** Words that put the amount to pay right after them. */
const TOTAL_WORDS = /(?:לתשלום|סה"כ|סה״כ|סך הכל|סכום|יתרה|total|amount due|balance)/gi;
const NEAR_CHARS = 60;

const DUE_WORDS = String.raw`(?:לתשלום עד|תשלום עד|יש לשלם עד|עד תאריך|מועד(?: ה)?תשלום|תאריך אחרון לתשלום|תאריך תשלום|יחויב ב|due date|due|pay by)`;
const DUE = new RegExp(`${DUE_WORDS}[^\\d]{0,20}(\\d{1,2})[./-](\\d{1,2})(?:[./-](\\d{4}|\\d{2}))?`, 'i');

const MAX_AMOUNT = 1_000_000;

function toNumber(text: string): number | null {
  const value = Number(text.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 && value < MAX_AMOUNT ? value : null;
}

/** Every shekel amount in the text, with where it starts. */
function amounts(text: string): { at: number; value: number }[] {
  const out: { at: number; value: number }[] = [];
  for (const pattern of [AMOUNT_BEFORE, AMOUNT_AFTER]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = toNumber(match[1]!);
      if (value !== null) out.push({ at: match.index ?? 0, value });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * The amount to pay: the first shekel amount shortly after a "total" word;
 * else the first shekel amount at all.
 */
export function billAmount(text: string): number | null {
  const found = amounts(text);
  if (found.length === 0) return null;
  for (const word of text.matchAll(TOTAL_WORDS)) {
    const start = word.index ?? 0;
    const near = found.find((amount) => amount.at >= start && amount.at - start <= NEAR_CHARS);
    if (near) return near.value;
  }
  return found[0]!.value;
}

/**
 * The due date after "pay by" words, day first (the Israeli order). A date
 * without a year is the next such day on or after the mail's own day, less a
 * month's grace: a bill dated 2.1 that says "עד 28.12" means the past December.
 */
export function billDue(text: string, mailLocal: { year: number; month: number; day: number }): BillFacts['due'] {
  const match = DUE.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year: number;
  if (match[3] !== undefined) {
    year = Number(match[3]);
    if (year < 100) year += 2000;
  } else {
    year = mailLocal.year;
    const mailDay = Date.UTC(mailLocal.year, mailLocal.month - 1, mailLocal.day);
    if (Date.UTC(year, month - 1, day) < mailDay - 31 * 86_400_000) year += 1;
  }
  return isRealDate(year, month, day) ? { year, month, day } : null;
}

export function billFacts(text: string, mailLocal: { year: number; month: number; day: number }): BillFacts {
  return { amount: billAmount(text), due: billDue(text, mailLocal) };
}

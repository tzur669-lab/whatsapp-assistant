/**
 * The monthly bookkeeping file's words (block L, L4, 2026-10-15): its CSV
 * headers and notes, the card's preview and the `/monthly` replies. Counts,
 * month names and fixed text only. Gender-neutral, ktiv maleh, dugri.
 */
import { isolate } from './bidi.js';
import type { Lang } from './format-time.js';

const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const monthName = (year: number, month: number, lang: Lang) => `${(lang === 'he' ? MONTHS_HE : MONTHS_EN)[month - 1]} ${year}`;

export type BillsCoverage = { kind: 'read'; count: number; skipped: number; capped: boolean } | { kind: 'unavailable' };

export const monthlyText = {
  header(lang: Lang): string[] {
    return lang === 'he'
      ? ['סוג', 'תאריך', 'סכום', 'מטבע', 'קטגוריה או שולח', 'פירוט']
      : ['Kind', 'Date', 'Amount', 'Currency', 'Category or sender', 'Details'];
  },

  kind: {
    note: (lang: Lang) => (lang === 'he' ? 'הערה' : 'Note'),
    expense: (lang: Lang) => (lang === 'he' ? 'הוצאה' : 'Expense'),
    categoryTotal: (lang: Lang) => (lang === 'he' ? 'סיכום קטגוריה' : 'Category total'),
    total: (lang: Lang) => (lang === 'he' ? 'סך הכול הוצאות' : 'Total expenses'),
    bill: (lang: Lang) => (lang === 'he' ? 'חשבון מהמייל' : 'Bill from mail'),
  },

  /** The notes at the top of the file: what it does not cover is never silent. */
  notes(bills: BillsCoverage, expensesCut: boolean, lang: Lang): string[] {
    const he = lang === 'he';
    const out: string[] = [];
    if (bills.kind === 'unavailable') {
      out.push(he ? 'חשבונות מהמייל לא נכללו: לא הייתה גישה ל־Gmail.' : 'Bills from mail are not included: Gmail was not reachable.');
    } else {
      out.push(he ? 'החשבונות זוהו אוטומטית מהמייל ועלולים להיות חסרים.' : 'Bills were found in mail automatically and may be incomplete.');
      if (bills.capped) out.push(he ? 'ייתכן שיש עוד חשבונות: נבדקו עד 8 מיילים.' : 'There may be more bills: at most 8 mails were checked.');
      if (bills.skipped > 0) {
        out.push(he ? `${bills.skipped === 1 ? 'מייל אחד לא נקרא' : `${bills.skipped} מיילים לא נקראו`}.` : `${bills.skipped} mail(s) could not be read.`);
      }
      out.push(
        he
          ? 'חשבון והוצאה של אותו תשלום לא מאוחדים: ייתכן שתשלום מופיע פעמיים.'
          : 'A bill and an expense for the same payment are not merged: a payment may appear twice.',
      );
    }
    if (expensesCut) out.push(he ? 'רשימת ההוצאות קוצרה כדי שהקובץ לא יהיה גדול מדי.' : 'The expense list was cut to keep the file small.');
    out.push(he ? 'כל הסכומים בשקלים.' : 'All amounts are in shekels.');
    return out;
  },

  dueNote(day: string, lang: Lang): string {
    return lang === 'he' ? `לתשלום עד ${day}` : `due ${day}`;
  },

  preview(year: number, month: number, expenses: number, bills: BillsCoverage, lang: Lang): string {
    const he = lang === 'he';
    const billsPart =
      bills.kind === 'unavailable'
        ? he
          ? 'בלי חשבונות מהמייל (לא הייתה גישה)'
          : 'no bills from mail (not reachable)'
        : he
          ? `${bills.count} חשבונות מהמייל`
          : `${bills.count} bills from mail`;
    return he
      ? `קובץ הנהלת חשבונות ל${monthName(year, month, lang)}: ${expenses} הוצאות, ${billsPart}.`
      : `Bookkeeping file for ${monthName(year, month, lang)}: ${expenses} expenses, ${billsPart}.`;
  },

  status(on: boolean, lang: Lang): string {
    if (lang === 'he') {
      return on
        ? `הקובץ החודשי פעיל: ב־1 לחודש מ־${isolate('09:00')} יגיע קובץ ${isolate('CSV')} עם ההוצאות והחשבונות של החודש הקודם. לכיבוי: ${isolate('/monthly off')}.`
        : `הקובץ החודשי כבוי. להפעלה: ${isolate('/monthly on')}. אפשר גם לבקש בכל זמן: "תכין לי את הקובץ החודשי לרואה החשבון".`;
    }
    return on
      ? 'The monthly file is on: on the 1st from 09:00 a CSV with last month\'s expenses and bills arrives. Turn off: /monthly off.'
      : 'The monthly file is off. Turn on: /monthly on. You can also ask for it any time.';
  },
};

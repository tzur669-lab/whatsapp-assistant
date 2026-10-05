/**
 * Notes and expenses, in words (PLAN §6.22, 2026-10-05).
 *
 * Code-authored like every reply. A note's text is shown to the user and to no
 * one else: the tools that render it are private, so none of this reaches the
 * model.
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatDay } from './format-time.js';
import type { Lang } from './format-time.js';
import type { PersonalQuestion } from '../tools/types.js';
import type { Note } from '../tools/note-store.js';
import type { CategoryTotal, ExpenseCategory } from '../tools/expense-store.js';
import { MAX_NOTES } from '../tools/note-store.js';
import type { ExpensePeriod } from '../time/past-day.js';
import { localPartsOf, ZONE } from '../time/tz.js';

export function personalQuestion(what: PersonalQuestion, lang: Lang): string {
  const he = lang === 'he';
  switch (what) {
    case 'note_text':
      return he ? 'מה לרשום בפתק?' : 'What should the note say?';
    case 'notes_full':
      return he
        ? `יש כבר ${isolateLtr(String(MAX_NOTES))} פתקים, וזה המקסימום. אפשר למחוק פתק ישן ולנסות שוב.`
        : `There are already ${MAX_NOTES} notes, the most kept. Delete an old one and try again.`;
    case 'no_notes':
      return he ? 'אין פתקים שמורים.' : 'No notes saved.';
    case 'expense_amount':
      return he ? 'כמה זה עלה?' : 'How much was it?';
    case 'expense_future':
      return he ? 'התאריך הזה עוד לא הגיע. באיזה יום הייתה ההוצאה?' : 'That day has not come yet. Which day was it?';
    case 'expense_too_old':
      return he
        ? 'אפשר לרשום הוצאה עד שנה אחורה. באיזה יום הייתה ההוצאה?'
        : 'Expenses go back at most a year. Which day was it?';
    case 'expense_invalid_date':
      return he ? 'התאריך הזה לא קיים. באיזה יום הייתה ההוצאה?' : 'That date does not exist. Which day was it?';
    case 'expenses_full':
      return he
        ? 'רשימת ההוצאות מלאה. אפשר לייצא אותה לקובץ.'
        : 'The expense list is full. It can be exported to a file.';
    case 'no_expenses':
      return he ? 'אין הוצאות רשומות בתקופה הזאת.' : 'No expenses recorded for that period.';
  }
}

// -- notes ----------------------------------------------------------------------

export const notesText = {
  saved(text: string, lang: Lang): string {
    return lang === 'he' ? `שמרתי פתק:\n${isolate(text)}` : `Note saved:\n${isolate(text)}`;
  },

  /** `matched`: an answer to a search, rather than the newest notes. */
  list(notes: readonly Note[], matched: boolean, lang: Lang): string {
    const he = lang === 'he';
    const header = matched ? (he ? 'מצאתי:' : 'Found:') : he ? 'הפתקים האחרונים:' : 'Latest notes:';
    const lines = notes.map(
      (note, index) =>
        `${isolateLtr(String(index + 1))}. ${formatDay(localPartsOf(note.createdAt, ZONE), lang)} — ${isolate(note.text)}`,
    );
    return [header, '', ...lines].join('\n');
  },

  /** The confirmation shows the whole note: it is what will be deleted. */
  deletePreview(text: string, lang: Lang): string {
    return lang === 'he' ? `מחיקת הפתק:\n${isolate(text)}` : `Delete the note:\n${isolate(text)}`;
  },

  deleted(lang: Lang): string {
    return lang === 'he' ? 'הפתק נמחק.' : 'Note deleted.';
  },

  gone(lang: Lang): string {
    return lang === 'he' ? 'הפתק הזה כבר לא קיים.' : 'That note no longer exists.';
  },
};

// -- expenses -------------------------------------------------------------------

const CATEGORY_NAMES: Record<ExpenseCategory, readonly [string, string]> = {
  food: ['אוכל', 'Food'],
  groceries: ['סופר', 'Groceries'],
  fuel: ['דלק', 'Fuel'],
  transport: ['תחבורה', 'Transport'],
  shopping: ['קניות', 'Shopping'],
  bills: ['חשבונות', 'Bills'],
  health: ['בריאות', 'Health'],
  fun: ['בילויים', 'Going out'],
  home: ['בית', 'Home'],
  other: ['אחר', 'Other'],
};

export function categoryName(category: ExpenseCategory, lang: Lang): string {
  const [he, en] = CATEGORY_NAMES[category];
  return lang === 'he' ? he : en;
}

const PERIOD_NAMES: Record<ExpensePeriod, readonly [string, string]> = {
  today: ['היום', 'today'],
  this_week: ['השבוע', 'this week'],
  last_week: ['בשבוע שעבר', 'last week'],
  this_month: ['החודש', 'this month'],
  last_month: ['בחודש שעבר', 'last month'],
  this_year: ['השנה', 'this year'],
  all: ['עד היום', 'so far'],
};

export function periodName(period: ExpensePeriod, lang: Lang): string {
  const [he, en] = PERIOD_NAMES[period];
  return lang === 'he' ? he : en;
}

/** `₪45` or `₪12.50`, comma-grouped, isolated so it reads left to right. */
export function shekels(agorot: number): string {
  const whole = Math.floor(agorot / 100).toLocaleString('en-US');
  const cents = agorot % 100;
  return isolateLtr(cents === 0 ? `₪${whole}` : `₪${whole}.${String(cents).padStart(2, '0')}`);
}

const plural = new Intl.PluralRules('he-IL');

/** `הוצאה אחת` · `שתי הוצאות` · `5 הוצאות`. */
function countOf(count: number, lang: Lang): string {
  if (lang === 'en') return `${count} ${count === 1 ? 'expense' : 'expenses'}`;
  switch (plural.select(count)) {
    case 'one':
      return 'הוצאה אחת';
    case 'two':
      return 'שתי הוצאות';
    default:
      return `${isolateLtr(String(count))} הוצאות`;
  }
}

export const expenseText = {
  added(
    view: { agorot: number; category: ExpenseCategory; description: string | null; spentOn: string },
    lang: Lang,
  ): string {
    const day = formatDay(dayParts(view.spentOn), lang);
    const head = `${shekels(view.agorot)} · ${categoryName(view.category, lang)} · ${day}`;
    const line = lang === 'he' ? `נרשמה הוצאה: ${head}` : `Expense recorded: ${head}`;
    return view.description ? `${line}\n${isolate(view.description)}` : line;
  },

  removed(lang: Lang): string {
    return lang === 'he' ? 'ההוצאה נמחקה.' : 'Expense removed.';
  },

  gone(lang: Lang): string {
    return lang === 'he' ? 'ההוצאה הזאת כבר לא קיימת.' : 'That expense no longer exists.';
  },

  summary(totals: readonly CategoryTotal[], period: ExpensePeriod, lang: Lang): string {
    const agorot = totals.reduce((sum, total) => sum + total.agorot, 0);
    const count = totals.reduce((sum, total) => sum + total.count, 0);
    const when = periodName(period, lang);
    const head =
      lang === 'he'
        ? `סך ההוצאות ${when}: ${shekels(agorot)} (${countOf(count, lang)})`
        : `Spent ${when}: ${shekels(agorot)} (${countOf(count, lang)})`;
    if (totals.length <= 1) return head;
    const lines = totals.map((total) => `• ${categoryName(total.category, lang)}: ${shekels(total.agorot)}`);
    return [head, '', ...lines].join('\n');
  },

  /** The card's preview. Never the file's content: that goes only to the claim. */
  exportPreview(rows: number, period: ExpensePeriod, cut: boolean, lang: Lang): string {
    const when = periodName(period, lang);
    const head =
      lang === 'he'
        ? `📄 קובץ הוצאות (${when}): ${countOf(rows, lang)}`
        : `📄 Expenses file (${when}): ${countOf(rows, lang)}`;
    if (!cut) return head;
    return lang === 'he'
      ? `${head}\nהקובץ מלא, ולכן נכנסו רק ההוצאות האחרונות.`
      : `${head}\nThe file is full, so only the latest expenses are in it.`;
  },

  /** The file's header row. */
  csvHeader(lang: Lang): readonly string[] {
    return lang === 'he' ? ['תאריך', 'סכום', 'קטגוריה', 'תיאור'] : ['Date', 'Amount', 'Category', 'Description'];
  },
};

/** A stored local day as the parts `formatDay` reads. Noon UTC is the same day in Israel. */
function dayParts(iso: string) {
  return localPartsOf(Date.parse(`${iso}T12:00:00Z`), ZONE);
}

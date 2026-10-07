/**
 * Named lists, in words (PLAN §6.25, block H, 2026-10-07).
 *
 * Every reply here is private: the tools that make them never hand a list to
 * the model, and the agent's history keeps a placeholder.
 */
import { isolate, isolateLtr } from './bidi.js';
import type { Lang } from './format-time.js';
import type { ListItem, ListSummary } from '../tools/list-store.js';

const pluralHe = new Intl.PluralRules('he-IL');
const pluralEn = new Intl.PluralRules('en');

/** "פריט אחד", "שני פריטים", "5 פריטים" (CLAUDE.md: `Intl.PluralRules('he')`). */
function itemCount(count: number, lang: Lang): string {
  if (lang === 'en') return `${isolateLtr(String(count))} ${pluralEn.select(count) === 'one' ? 'item' : 'items'}`;
  switch (pluralHe.select(count)) {
    case 'one':
      return 'פריט אחד';
    case 'two':
      return 'שני פריטים';
    default:
      return `${isolateLtr(String(count))} פריטים`;
  }
}

const numbered = (items: readonly ListItem[]): string[] =>
  items.map((item, index) => `${isolateLtr(String(index + 1))}. ${isolate(item.text)}`);

export const listText = {
  added(listName: string, added: readonly string[], skipped: readonly string[], created: boolean, lang: Lang): string {
    const he = lang === 'he';
    const lines: string[] = [];
    if (created) lines.push(he ? `יצרתי רשימה חדשה: ${isolate(listName)}` : `New list: ${isolate(listName)}`);
    if (added.length > 0) {
      lines.push(
        he
          ? `הוספתי לרשימת ${isolate(listName)}: ${added.map(isolate).join(', ')}`
          : `Added to ${isolate(listName)}: ${added.map(isolate).join(', ')}`,
      );
    }
    if (skipped.length > 0) {
      lines.push(he ? `כבר ברשימה: ${skipped.map(isolate).join(', ')}` : `Already on it: ${skipped.map(isolate).join(', ')}`);
    }
    return lines.join('\n');
  },

  /** A new list made while others exist: maybe one of them was meant. */
  didYouMean(others: readonly string[], lang: Lang): string {
    const names = others.map(isolate).join(', ');
    return lang === 'he' ? `התכוונת לאחת מהרשימות הקיימות? ${names}` : `Did you mean an existing list? ${names}`;
  },

  one(listName: string, items: readonly ListItem[], lang: Lang): string {
    const he = lang === 'he';
    if (items.length === 0) return he ? `רשימת ${isolate(listName)} ריקה.` : `${isolate(listName)} is empty.`;
    return [he ? `רשימת ${isolate(listName)}:` : `${isolate(listName)}:`, '', ...numbered(items)].join('\n');
  },

  all(lists: readonly ListSummary[], lang: Lang): string {
    const he = lang === 'he';
    const lines = lists.map(
      (list) => `• ${isolate(list.name)} — ${itemCount(list.count, lang)}`,
    );
    return [he ? 'הרשימות שלך:' : 'Your lists:', '', ...lines].join('\n');
  },

  removed(listName: string, removed: readonly string[], lang: Lang): string {
    return lang === 'he'
      ? `הורדתי מרשימת ${isolate(listName)}: ${removed.map(isolate).join(', ')}`
      : `Removed from ${isolate(listName)}: ${removed.map(isolate).join(', ')}`;
  },

  notOnList(listName: string, lang: Lang): string {
    return lang === 'he'
      ? `לא מצאתי את זה ברשימת ${isolate(listName)}.`
      : `That is not on ${isolate(listName)}.`;
  },

  deletePreview(listName: string, count: number, lang: Lang): string {
    return lang === 'he'
      ? `מחיקת רשימת ${isolate(listName)} (${itemCount(count, lang)})`
      : `Delete the list ${isolate(listName)} (${itemCount(count, lang)})`;
  },

  deleted(listName: string, count: number, lang: Lang): string {
    return lang === 'he'
      ? `רשימת ${isolate(listName)} נמחקה, עם ${itemCount(count, lang)}.`
      : `Deleted ${isolate(listName)}, with ${itemCount(count, lang)}.`;
  },

  undone(lang: Lang): string {
    return lang === 'he' ? 'בוטל.' : 'Undone.';
  },

  /** A stale Undo: something changed since, and it is not overwritten. */
  undoRefused(reason: 'changed' | 'full' | 'clash', lang: Lang): string {
    const he = lang === 'he';
    switch (reason) {
      case 'changed':
        return he ? 'הרשימה השתנתה מאז, אז לא ביטלתי.' : 'The list changed since, so nothing was undone.';
      case 'full':
        return he ? 'הרשימה מלאה, אז לא ביטלתי.' : 'The list is full, so nothing was undone.';
      case 'clash':
        return he ? 'יש כבר רשימה או פריט באותו שם, אז לא ביטלתי.' : 'Something with that name exists again, so nothing was undone.';
    }
  },
};

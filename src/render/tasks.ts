/** Replies for Google Tasks (2026-10-01). Code templates, like every reply. */
import { isolate } from './bidi.js';
import { formatDay } from './format-time.js';
import type { Lang } from './format-time.js';
import type { LocalParts } from '../time/tz.js';

const MAX_ITEMS_SHOWN = 15;

export const taskText = {
  lists(sections: ReadonlyArray<{ title: string; items: readonly string[] }>, lang: Lang): string {
    const he = lang === 'he';
    return sections
      .map(({ title, items }) => {
        const head = `${isolate(title)}:`;
        if (items.length === 0) return `${head}\n${he ? '(ריקה)' : '(empty)'}`;
        const shown = items.slice(0, MAX_ITEMS_SHOWN).map((item) => `• ${isolate(item)}`);
        const more = items.length > MAX_ITEMS_SHOWN ? [he ? `ועוד ${items.length - MAX_ITEMS_SHOWN}` : `and ${items.length - MAX_ITEMS_SHOWN} more`] : [];
        return [head, ...shown, ...more].join('\n');
      })
      .join('\n\n');
  },

  noLists(lang: Lang): string {
    return lang === 'he' ? 'אין עדיין רשימות ב־Google Tasks.' : 'There are no Google Tasks lists yet.';
  },

  noSuchList(said: string, titles: readonly string[], lang: Lang): string {
    const names = titles.map(isolate).join(', ');
    return lang === 'he' ? `אין רשימה בשם ${isolate(said)}. הרשימות: ${names}.` : `No list called ${isolate(said)}. The lists: ${names}.`;
  },

  addPreview(title: string, list: string | null, lang: Lang): string {
    const where = list ? isolate(list) : lang === 'he' ? 'הרשימה הראשית' : 'the main list';
    return lang === 'he' ? `להוסיף ${isolate(title)} ל${where}` : `Add ${isolate(title)} to ${where}`;
  },

  added(title: string, list: string, created: boolean, due: LocalParts | null, lang: Lang): string {
    const he = lang === 'he';
    const dueLine = due ? (he ? ` · עד ${formatDay(due, lang)}` : ` · due ${formatDay(due, lang)}`) : '';
    const madeLine = created ? (he ? ' (רשימה חדשה)' : ' (new list)') : '';
    return he
      ? `נוסף לרשימת ${isolate(list)}${madeLine}: ${isolate(title)}${dueLine}`
      : `Added to ${isolate(list)}${madeLine}: ${isolate(title)}${dueLine}`;
  },

  completePreview(title: string, list: string, lang: Lang): string {
    return lang === 'he' ? `לסמן כבוצע: ${isolate(title)} (${isolate(list)})` : `Mark done: ${isolate(title)} (${isolate(list)})`;
  },

  completed(title: string, list: string, lang: Lang): string {
    return lang === 'he' ? `סומן כבוצע: ${isolate(title)} (${isolate(list)}) ✅` : `Done: ${isolate(title)} (${isolate(list)}) ✅`;
  },

  undoneAdd(lang: Lang): string {
    return lang === 'he' ? 'בוטל. הפריט הוסר מהרשימה.' : 'Undone. The item was removed.';
  },

  undoneComplete(lang: Lang): string {
    return lang === 'he' ? 'בוטל. הפריט פתוח שוב.' : 'Undone. The item is open again.';
  },

  unavailable(lang: Lang): string {
    return lang === 'he' ? 'Google Tasks לא זמין כרגע. כדאי לנסות שוב בעוד רגע.' : 'Google Tasks is unavailable right now. Try again in a moment.';
  },
};

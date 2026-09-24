/**
 * Reminder replies (PLAN §6.4, §6.7).
 *
 * Every reply that sets or shows a time echoes weekday + date + time. That echo
 * is not decoration: it is the only chance to catch a wrong parse before the
 * reminder fires, and it is why the system can afford to act on one sentence.
 *
 * Gender-neutral, ktiv maleh, dugri. Numbers and Latin runs are bidi-isolated —
 * `1.` at the start of a Hebrew line jumps to the wrong end without it.
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import type { LocalParts } from '../time/tz.js';

export type ReminderView = {
  id: string;
  text: string;
  local: LocalParts;
};

export const reminderText = {
  /** Tier 1: it is already scheduled. The reply exists to be checked. */
  created(view: ReminderView, lang: Lang): string {
    return lang === 'he'
      ? `נקבעה תזכורת ל${formatWhen(view.local, 'he')}\n${isolate(view.text)}`
      : `Reminder set for ${formatWhen(view.local, 'en')}\n${isolate(view.text)}`;
  },

  /**
   * The same, when the 24-hour window will be shut by then and delivery moves
   * to a calendar popup instead (PLAN §6.7). Said at creation, not at failure.
   */
  createdViaCalendar(view: ReminderView, lang: Lang): string {
    return lang === 'he'
      ? `נקבעה תזכורת ל${formatWhen(view.local, 'he')}\n${isolate(view.text)}\n\nהיא תגיע כהתראה ביומן: חלון ההודעות של וואטסאפ ייסגר עד אז.`
      : `Reminder set for ${formatWhen(view.local, 'en')}\n${isolate(view.text)}\n\nIt will arrive as a calendar alert — the WhatsApp window will be closed by then.`;
  },

  list(views: readonly ReminderView[], lang: Lang): string {
    if (views.length === 0) return reminderText.empty(lang);

    const lines = views.map(
      (view, index) =>
        `${isolateLtr(String(index + 1))}. ${formatWhen(view.local, lang)} — ${isolate(view.text)}`,
    );
    const header = lang === 'he' ? 'תזכורות ממתינות:' : 'Upcoming reminders:';
    return [header, '', ...lines].join('\n');
  },

  empty(lang: Lang): string {
    return lang === 'he' ? 'אין תזכורות ממתינות.' : 'No reminders pending.';
  },

  /** Tier 2: shown with the confirm buttons, before anything is deleted. */
  cancelPreview(view: ReminderView, lang: Lang): string {
    return lang === 'he'
      ? `ביטול התזכורת ל${formatWhen(view.local, 'he')}\n${isolate(view.text)}`
      : `Cancel the reminder for ${formatWhen(view.local, 'en')}\n${isolate(view.text)}`;
  },

  cancelled(lang: Lang): string {
    return lang === 'he' ? 'התזכורת בוטלה.' : 'Reminder cancelled.';
  },

  /** After an Undo on a create: the reminder is gone again. */
  undoneCreate(lang: Lang): string {
    return lang === 'he' ? 'התזכורת בוטלה.' : 'Reminder removed.';
  },

  /** The reminder itself, when it fires. */
  due(text: string, lang: Lang): string {
    return lang === 'he' ? `⏰ ${isolate(text)}` : `⏰ ${isolate(text)}`;
  },

  /**
   * Appended when delivery was late — a redeploy, an outage, a closed window
   * that reopened. Being told a reminder is late is better than quietly getting
   * it at the wrong time and trusting it.
   */
  lateNote(minutesLate: number, lang: Lang): string {
    return lang === 'he'
      ? `(באיחור של ${isolateLtr(String(minutesLate))} דק׳)`
      : `(${isolateLtr(String(minutesLate))} min late)`;
  },

  /** Said once when a reminder has exhausted its delivery attempts. */
  deliveryGaveUp(view: ReminderView, lang: Lang): string {
    return lang === 'he'
      ? `לא הצלחתי לשלוח את התזכורת ל${formatWhen(view.local, 'he')}:\n${isolate(view.text)}`
      : `Could not deliver the reminder for ${formatWhen(view.local, 'en')}:\n${isolate(view.text)}`;
  },
} as const;

/** Button labels. WhatsApp caps a reply button title at 20 characters. */
export const buttonLabels = {
  confirm: (lang: Lang) => (lang === 'he' ? '✅ אישור' : '✅ Confirm'),
  cancel: (lang: Lang) => (lang === 'he' ? '❌ ביטול' : '❌ Cancel'),
  undo: (lang: Lang) => (lang === 'he' ? '↩️ ביטול הפעולה' : '↩️ Undo'),
  snooze10: (lang: Lang) => (lang === 'he' ? '⏱️ עוד 10 דק׳' : '⏱️ +10 min'),
  snooze60: (lang: Lang) => (lang === 'he' ? '⏱️ עוד שעה' : '⏱️ +1 hour'),
  done: (lang: Lang) => (lang === 'he' ? '✔️ בוצע' : '✔️ Done'),
} as const;

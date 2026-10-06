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
import type { ScheduledTopic } from '../nlu/slot-schemas.js';
import { MAX_TITLE_CHARS } from '../nlu/slot-schemas.js';
import { isolate, isolateLtr } from './bidi.js';
import { formatWhen, weekdayName } from './format-time.js';
import type { Lang } from './format-time.js';
import type { LocalParts } from '../time/tz.js';
import type { RecurRule } from '../time/recur.js';

export type ReminderView = {
  id: string;
  text: string;
  local: LocalParts;
  /** Set for an occurrence of a recurring reminder (B6). */
  rule?: RecurRule;
};

/** `כל יום ב׳, יום ה׳ · 08:00` / `Every Mon, Thu · 08:00`. */
export function repeatLabel(rule: RecurRule, lang: Lang): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = isolateLtr(`${pad(rule.hour)}:${pad(rule.minute)}`);
  const he = lang === 'he';

  switch (rule.freq) {
    case 'daily':
      return he ? `כל יום · ${time}` : `Every day · ${time}`;
    case 'weekly': {
      const days = [...(rule.weekdays ?? [])].sort((a, b) => a - b).map((d) => weekdayName(d, lang));
      return he ? `כל ${days.join(', ')} · ${time}` : `Every ${days.join(', ')} · ${time}`;
    }
    case 'monthly': {
      const day = isolateLtr(String(rule.day ?? 1));
      return he ? `כל ${day} בחודש · ${time}` : `Monthly on day ${day} · ${time}`;
    }
  }
}

/** The 🔁 mark and its rule, after a listed occurrence. Empty for a one-off. */
function repeatSuffix(view: ReminderView, lang: Lang): string {
  return view.rule ? ` 🔁 ${repeatLabel(view.rule, lang)}` : '';
}

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

  /** A recurring reminder, Tier 1: the rule, then the first one, to be checked. */
  createdRepeat(view: ReminderView & { rule: RecurRule }, lang: Lang): string {
    return lang === 'he'
      ? `נקבעה תזכורת חוזרת: ${repeatLabel(view.rule, 'he')}\nהראשונה: ${formatWhen(view.local, 'he')}\n${isolate(view.text)}`
      : `Recurring reminder set: ${repeatLabel(view.rule, 'en')}\nFirst: ${formatWhen(view.local, 'en')}\n${isolate(view.text)}`;
  },

  /**
   * The name of a scheduled read (ROADMAP #7). Stored as the reminder's text,
   * so the list shows it and a cancel finds it; the mark in brackets keeps it
   * from reading as a reminder the user typed.
   */
  scheduledLabel(topic: ScheduledTopic, lang: Lang): string {
    const names: Record<ScheduledTopic, readonly [string, string]> = {
      weather: ['מזג האוויר', 'Weather'],
      day_times: ['זמני היום', 'Times of day'],
      uv_air: ['קרינת UV ואיכות האוויר', 'UV and air quality'],
      exchange_rate: ['שערי המטבע', 'Exchange rates'],
      news: ['כותרות החדשות', 'News headlines'],
      jewish_calendar: ['לוח השנה העברי', 'Hebrew calendar'],
    };
    const [he, en] = names[topic];
    return lang === 'he' ? `${he} (שליחה קבועה)` : `${en} (scheduled)`;
  },

  /** A scheduled read, Tier 1: the rule, then the first one, to be checked. */
  createdScheduledRead(view: ReminderView & { rule: RecurRule }, lang: Lang): string {
    return lang === 'he'
      ? `נקבעה שליחה קבועה: ${repeatLabel(view.rule, 'he')}
הראשונה: ${formatWhen(view.local, 'he')}
${isolate(view.text)}`
      : `Scheduled: ${repeatLabel(view.rule, 'en')}
First: ${formatWhen(view.local, 'en')}
${isolate(view.text)}`;
  },

  /**
   * A "time to leave" reminder's stored text (ROADMAP #5): the event's title,
   * capped so the whole text fits a reminder's.
   */
  leaveLabel(title: string, lang: Lang): string {
    const prefix = lang === 'he' ? 'לצאת ל־' : 'Leave for ';
    return `${prefix}${title.trim().slice(0, MAX_TITLE_CHARS - prefix.length)}`;
  },

  /** Tier 1: set, with when to leave and when the event starts. */
  createdLeave(
    view: { text: string; leave: LocalParts; start: LocalParts; minutes: number; hasPlace: boolean },
    lang: Lang,
  ): string {
    const hhmm = (local: LocalParts) =>
      isolate(`${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`);
    if (lang === 'he') {
      const nav = view.hasPlace ? `\nבזמן התזכורת יופיע גם כפתור ניווט ב־${isolateLtr('Waze')}.` : '';
      return `נקבעה תזכורת יציאה ל${formatWhen(view.leave, 'he')}, ${view.minutes} דקות לפני תחילת האירוע (${hhmm(view.start)}).\n${isolate(view.text)}${nav}`;
    }
    const nav = view.hasPlace ? '\nThe reminder will come with a Waze button.' : '';
    return `Leave reminder set for ${formatWhen(view.leave, 'en')}, ${view.minutes} minutes before the event starts (${hhmm(view.start)}).\n${isolate(view.text)}${nav}`;
  },

  /** Appended when the time falls inside Shabbat or a chag and the hold is on (§6.13). */
  heldNote(lang: Lang): string {
    return lang === 'he'
      ? 'הזמן הזה נופל בתוך שבת או חג, ולכן התזכורת תגיע בצאת השבת או החג.'
      : 'That time falls inside Shabbat or a chag, so it will arrive when it ends.';
  },

  /** Tier 2: shown with the confirm buttons, before anything moves (B8). */
  movePreview(view: ReminderView, to: LocalParts, lang: Lang): string {
    const once = view.rule
      ? lang === 'he'
        ? '\nרק הפעם הזאת. התזכורת החוזרת תמשיך כרגיל.'
        : '\nThis time only. The recurring reminder carries on.'
      : '';
    return lang === 'he'
      ? `הזזת התזכורת מ${formatWhen(view.local, 'he')} ל${formatWhen(to, 'he')}\n${isolate(view.text)}${once}`
      : `Move the reminder from ${formatWhen(view.local, 'en')} to ${formatWhen(to, 'en')}\n${isolate(view.text)}${once}`;
  },

  moved(to: LocalParts, lang: Lang): string {
    return lang === 'he'
      ? `התזכורת הוזזה ל${formatWhen(to, 'he')}.`
      : `Reminder moved to ${formatWhen(to, 'en')}.`;
  },

  /** Between the preview and the tap it fired or was cancelled elsewhere. */
  noLongerPending(lang: Lang): string {
    return lang === 'he'
      ? 'התזכורת כבר לא ממתינה — היא נשלחה או בוטלה בינתיים.'
      : 'That reminder is no longer pending — it fired or was cancelled already.';
  },

  list(views: readonly ReminderView[], lang: Lang): string {
    if (views.length === 0) return reminderText.empty(lang);

    const lines = views.map(
      (view, index) =>
        `${isolateLtr(String(index + 1))}. ${formatWhen(view.local, lang)} — ${isolate(view.text)}${repeatSuffix(view, lang)}`,
    );
    const header = lang === 'he' ? 'תזכורות ממתינות:' : 'Upcoming reminders:';
    return [header, '', ...lines].join('\n');
  },

  empty(lang: Lang): string {
    return lang === 'he' ? 'אין תזכורות ממתינות.' : 'No reminders pending.';
  },

  /** Tier 2: shown with the confirm buttons, before anything is deleted. */
  cancelPreview(view: ReminderView, lang: Lang): string {
    if (view.rule) {
      return lang === 'he'
        ? `ביטול התזכורת החוזרת (${repeatLabel(view.rule, 'he')}), כולל כל הפעמים הבאות\n${isolate(view.text)}`
        : `Cancel the recurring reminder (${repeatLabel(view.rule, 'en')}), every future time\n${isolate(view.text)}`;
    }
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

/**
 * The daily digest message (PLAN §6.12).
 *
 * Code-authored like every other reply: the digest is assembled from calendar
 * and reminder data, neither of which ever goes near the model.
 *
 * Only sections with something in them appear. A brief that prints three
 * headers and two empty lists is a brief nobody reads twice, and the whole
 * value of a scheduled message is that it is worth opening.
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatDay, formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import type { ReminderView } from './reminders.js';
import type { CalendarEvent } from '../google/calendar.js';
import type { LocalParts } from '../time/tz.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { eventText } from './events.js';

/** Lines that set the scene (#6). Shown only in a digest that is sent anyway. */
export type DigestContextLines = {
  /** `23 בתשרי 5787`. */
  hebrewDate?: string;
  /** The rendered forecast line for the home city. */
  weather?: string;
};

/** An open Google Task due today or before (#6). */
export type DigestTask = { title: string; overdue: boolean; due: string };

/** One day of the week ahead, with something on it (#8). */
export type DigestWeekDay = {
  local: LocalParts;
  /** Null when the calendar could not be read: no number rather than a wrong one. */
  events: number | null;
  reminders: number;
  birthdays: readonly string[];
};

export type DigestWeek = {
  days: readonly DigestWeekDay[];
  /** A read hit its cap, so the counts are a floor. */
  partial: boolean;
};

export type DigestParts = {
  /** Local hour, so the greeting matches the time it actually arrives. */
  hour: number;
  context?: DigestContextLines;
  events: readonly CalendarEvent[];
  reminders: readonly ReminderView[];
  /** Due and not delivered — held over a shut window, most likely (§6.7). */
  overdue: readonly ReminderView[];
  /** Names with a birthday today (§6.16). */
  birthdays: readonly string[];
  tasks?: readonly DigestTask[];
  /** Sunday's look at the week ahead; null on other days (#8). */
  week?: DigestWeek | null;
  /** Calls missed in the last day, as the phone reported them (#20). Null name: not in the contacts. */
  missedCalls?: readonly { name: string | null; at: number }[];
};

export const digestText = {
  compose(parts: DigestParts, lang: Lang): string {
    const sections: string[] = [greeting(parts.hour, lang)];

    const context = contextBlock(parts.context);
    if (context) sections.push(context);

    if (parts.birthdays.length > 0) {
      // First. It is the one line that is about a person rather than a task,
      // and the one the user would be sorry to scroll past.
      sections.push(birthdayLine(parts.birthdays, lang));
    }

    if (parts.events.length > 0) {
      sections.push(eventText.list(parts.events, lang));
    }

    if (parts.reminders.length > 0) {
      sections.push(section(heading('reminders', lang), parts.reminders, lang));
    }

    if (parts.tasks && parts.tasks.length > 0) {
      sections.push(taskSection(parts.tasks, lang));
    }

    if (parts.missedCalls && parts.missedCalls.length > 0) {
      // Someone tried to reach the user: something to act on, like an overdue reminder.
      sections.push(missedCallSection(parts.missedCalls, lang));
    }

    if (parts.overdue.length > 0) {
      // Last, and named for what it is. A reminder that did not arrive is the
      // one thing in here the user may need to act on immediately.
      sections.push(section(heading('overdue', lang), parts.overdue, lang));
    }

    if (parts.week && parts.week.days.length > 0) {
      // After today's business: the week is a look ahead, not a to-do.
      sections.push(weekSection(parts.week, lang));
    }

    return sections.join('\n\n');
  },
};

function contextBlock(context: DigestContextLines | undefined): string | null {
  if (!context) return null;
  const lines: string[] = [];
  if (context.hebrewDate) lines.push(isolate(context.hebrewDate));
  if (context.weather) lines.push(context.weather);
  return lines.length > 0 ? lines.join('\n') : null;
}

function taskSection(tasks: readonly DigestTask[], lang: Lang): string {
  const header = lang === 'en' ? 'Tasks due:' : 'משימות להיום:';
  const late = lang === 'en' ? ' (overdue)' : ' (באיחור)';
  const lines = tasks.map((task) => `• ${isolate(task.title)}${task.overdue ? late : ''}`);
  return [header, '', ...lines].join('\n');
}

/**
 * One line per caller, the latest call's time, and how many times when more
 * than once: `• דנה (פעמיים) · יום ג׳ 6.10 · 08:12`. Unknown numbers are one line.
 */
function missedCallSection(calls: readonly { name: string | null; at: number }[], lang: Lang): string {
  const he = lang === 'he';
  const byCaller = new Map<string, { label: string; count: number; last: number }>();
  for (const call of calls) {
    const key = call.name ?? '';
    const label = call.name ?? (he ? 'מספר לא מזוהה' : 'Unknown number');
    const entry = byCaller.get(key) ?? { label, count: 0, last: 0 };
    entry.count += 1;
    entry.last = Math.max(entry.last, call.at);
    byCaller.set(key, entry);
  }
  const lines = [...byCaller.values()]
    .sort((a, b) => b.last - a.last)
    .map((entry) => {
      const times = entry.count > 1 ? ` (${timesOf(entry.count, lang)})` : '';
      return `• ${isolate(entry.label)}${times} · ${formatWhen(localPartsOf(entry.last, ZONE), lang)}`;
    });
  return [he ? 'שיחות שלא נענו:' : 'Missed calls:', '', ...lines].join('\n');
}

/** `פעמיים` · `3 פעמים` / `twice` · `3 times`. */
function timesOf(count: number, lang: Lang): string {
  if (lang === 'en') return count === 2 ? 'twice' : `${isolateLtr(String(count))} times`;
  return count === 2 ? 'פעמיים' : `${isolateLtr(String(count))} פעמים`;
}

function weekSection(week: DigestWeek, lang: Lang): string {
  const header =
    lang === 'en'
      ? week.partial ? 'The week ahead (at least):' : 'The week ahead:'
      : week.partial ? 'השבוע הקרוב (לפחות):' : 'השבוע הקרוב:';
  const lines = week.days.map((day) => {
    const parts: string[] = [];
    if (day.events !== null && day.events > 0) parts.push(countOf(day.events, 'event', lang));
    if (day.reminders > 0) parts.push(countOf(day.reminders, 'reminder', lang));
    if (day.birthdays.length > 0) {
      const names = day.birthdays.map(isolate).join(', ');
      parts.push(lang === 'en' ? `birthday: ${names}` : `יום הולדת: ${names}`);
    }
    return `${formatDay(day.local, lang)}: ${parts.join(' · ')}`;
  });
  return [header, '', ...lines].join('\n');
}

/**
 * `אירוע אחד` · `שני אירועים` · `3 אירועים`. Hebrew counts take the dual as a
 * word of its own, so this is Intl's one/two/other, not a suffix.
 */
const HE_COUNTS = {
  event: { one: 'אירוע אחד', two: 'שני אירועים', other: 'אירועים' },
  reminder: { one: 'תזכורת אחת', two: 'שתי תזכורות', other: 'תזכורות' },
} as const;

const EN_COUNTS = {
  event: { one: 'event', other: 'events' },
  reminder: { one: 'reminder', other: 'reminders' },
} as const;

const pluralHe = new Intl.PluralRules('he-IL');
const pluralEn = new Intl.PluralRules('en');

function countOf(count: number, noun: 'event' | 'reminder', lang: Lang): string {
  if (lang === 'en') {
    const form = EN_COUNTS[noun];
    return `${isolateLtr(String(count))} ${pluralEn.select(count) === 'one' ? form.one : form.other}`;
  }
  const form = HE_COUNTS[noun];
  switch (pluralHe.select(count)) {
    case 'one':
      return form.one;
    case 'two':
      return form.two;
    default:
      return `${isolateLtr(String(count))} ${form.other}`;
  }
}


function birthdayLine(names: readonly string[], lang: Lang): string {
  const list = names.map(isolate).join(', ');
  if (lang === 'en') return names.length === 1 ? `Birthday today: ${list}` : `Birthdays today: ${list}`;
  return names.length === 1 ? `יום הולדת היום: ${list}` : `ימי הולדת היום: ${list}`;
}

function section(header: string, views: readonly ReminderView[], lang: Lang): string {
  const lines = views.map(
    (view, index) =>
      `${isolateLtr(String(index + 1))}. ${formatWhen(view.local, lang)} — ${isolate(view.text)}${view.rule ? ' 🔁' : ''}`,
  );
  return [header, '', ...lines].join('\n');
}

function heading(kind: 'reminders' | 'overdue', lang: Lang): string {
  if (lang === 'en') return kind === 'reminders' ? 'Reminders:' : 'Did not arrive:';
  return kind === 'reminders' ? 'תזכורות להיום:' : 'לא הגיעו:';
}

/**
 * Matched to the hour, because the digest hour is configurable and "בוקר טוב"
 * at two in the afternoon reads like a message sent by something that is not
 * paying attention.
 */
function greeting(hour: number, lang: Lang): string {
  if (lang === 'en') {
    if (hour < 12) return 'Good morning. Today:';
    if (hour < 17) return 'Afternoon. What is left today:';
    return 'Evening. What is left today:';
  }
  if (hour < 12) return 'בוקר טוב. מה יש היום:';
  if (hour < 17) return 'צהריים טובים. מה נשאר להיום:';
  return 'ערב טוב. מה נשאר להיום:';
}

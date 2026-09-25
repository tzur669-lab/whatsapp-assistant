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
import { formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import type { ReminderView } from './reminders.js';
import type { CalendarEvent } from '../google/calendar.js';
import { eventText } from './events.js';

export type DigestParts = {
  /** Local hour, so the greeting matches the time it actually arrives. */
  hour: number;
  events: readonly CalendarEvent[];
  reminders: readonly ReminderView[];
  /** Due and not delivered — held over a shut window, most likely (§6.7). */
  overdue: readonly ReminderView[];
};

export const digestText = {
  compose(parts: DigestParts, lang: Lang): string {
    const sections: string[] = [greeting(parts.hour, lang)];

    if (parts.events.length > 0) {
      sections.push(eventText.list(parts.events, lang));
    }

    if (parts.reminders.length > 0) {
      sections.push(section(heading('reminders', lang), parts.reminders, lang));
    }

    if (parts.overdue.length > 0) {
      // Last, and named for what it is. A reminder that did not arrive is the
      // one thing in here the user may need to act on immediately.
      sections.push(section(heading('overdue', lang), parts.overdue, lang));
    }

    return sections.join('\n\n');
  },
};

function section(header: string, views: readonly ReminderView[], lang: Lang): string {
  const lines = views.map(
    (view, index) =>
      `${isolateLtr(String(index + 1))}. ${formatWhen(view.local, lang)} — ${isolate(view.text)}`,
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

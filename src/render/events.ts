/**
 * Calendar replies (PLAN §6.4, §6.6).
 *
 * Event data never goes to the LLM, so every word here is code-authored. The
 * format matches reminders deliberately: one numbered line per item, weekday +
 * date + time, so the two lists read the same even though they come from
 * different places.
 *
 * All-day events print without a time. Showing `00:00` for one would be a
 * number the user has to decide to ignore, and the whole point of the echo is
 * that it can be scanned without thinking.
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatRange, formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import type { CalendarEvent } from '../google/calendar.js';
import { localPartsOf, ZONE } from '../time/tz.js';

const HE_WEEKDAYS = ['יום א׳', 'יום ב׳', 'יום ג׳', 'יום ד׳', 'יום ה׳', 'יום ו׳', 'שבת'] as const;
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export const eventText = {
  list(events: readonly CalendarEvent[], lang: Lang): string {
    if (events.length === 0) return eventText.empty(lang);

    const lines = events.map(
      (event, index) => `${isolateLtr(String(index + 1))}. ${describe(event, lang)}`,
    );
    const header = lang === 'he' ? 'ביומן:' : 'On your calendar:';
    return [header, '', ...lines].join('\n');
  },

  empty(lang: Lang): string {
    return lang === 'he' ? 'אין אירועים ביומן בטווח הזה.' : 'Nothing on the calendar then.';
  },

  /** Google is not connected, or the grant lapsed and has to be renewed. */
  notConnected(lang: Lang): string {
    return lang === 'he'
      ? `יומן Google לא מחובר. יש לשלוח ${isolate('/connect google')}.`
      : `Google Calendar is not connected. Send ${isolate('/connect google')}.`;
  },

  /** Sent once when a grant is revoked mid-use, so the silence is explained. */
  disconnected(lang: Lang): string {
    return lang === 'he'
      ? `ההרשאה ליומן Google פגה או בוטלה. יש לשלוח ${isolate('/connect google')} כדי לחבר מחדש.`
      : `Access to Google Calendar has lapsed. Send ${isolate('/connect google')} to reconnect.`;
  },

  unavailable(lang: Lang): string {
    return lang === 'he'
      ? 'היומן לא זמין כרגע. כדאי לנסות שוב בעוד רגע.'
      : 'The calendar is unavailable right now. Try again in a moment.';
  },

  /** The message carrying the one-time connect link. */
  connectLink(url: string, minutes: number, lang: Lang): string {
    return lang === 'he'
      ? [
          'לחיבור יומן Google:',
          isolate(url),
          '',
          `הקישור תקף ${isolateLtr(String(minutes))} דקות ולשימוש חד-פעמי.`,
        ].join('\n')
      : [
          'Connect Google Calendar:',
          isolate(url),
          '',
          `The link is single-use and valid for ${isolateLtr(String(minutes))} minutes.`,
        ].join('\n');
  },

  connected(lang: Lang): string {
    return lang === 'he' ? 'יומן Google מחובר. ✅' : 'Google Calendar connected. ✅';
  },
} as const;

function describe(event: CalendarEvent, lang: Lang): string {
  const start = localPartsOf(event.startUtc, ZONE);

  if (event.allDay) {
    const names = lang === 'he' ? HE_WEEKDAYS : EN_WEEKDAYS;
    const date = lang === 'he' ? `${start.day}.${start.month}` : `${start.day}/${start.month}`;
    const allDay = lang === 'he' ? 'כל היום' : 'all day';
    return `${names[start.weekday] ?? ''} ${isolateLtr(date)} · ${allDay} — ${isolate(event.title)}`;
  }

  const end = localPartsOf(event.endUtc, ZONE);
  const when =
    event.endUtc > event.startUtc ? formatRange(start, end, lang) : formatWhen(start, lang);
  return `${when} — ${isolate(event.title)}`;
}

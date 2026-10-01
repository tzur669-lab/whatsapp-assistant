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
import { GRANTS } from '../google/grants.js';
import type { GrantName } from '../google/grants.js';
import { isolate, isolateLtr } from './bidi.js';
import { formatRange, formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import type { CalendarEvent } from '../google/calendar.js';
import type { LocalParts } from '../time/tz.js';
import { localPartsOf, ZONE } from '../time/tz.js';

const HE_WEEKDAYS = ['יום א׳', 'יום ב׳', 'יום ג׳', 'יום ד׳', 'יום ה׳', 'יום ו׳', 'שבת'] as const;
const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** What each Google grant is called in a reply (2026-10-01). */
export const GRANT_LABELS: Readonly<Record<GrantName, string>> = {
  calendar: 'יומן Google',
  gmail: 'Gmail',
  tasks: 'Google Tasks',
  drive: 'Google Drive',
};

const GRANT_LABELS_EN: Readonly<Record<GrantName, string>> = {
  calendar: 'Google Calendar',
  gmail: 'Gmail',
  tasks: 'Google Tasks',
  drive: 'Google Drive',
};

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
  connectLink(url: string, minutes: number, lang: Lang, grant: GrantName = 'calendar'): string {
    return lang === 'he'
      ? [
          `לחיבור ${GRANT_LABELS[grant]}:`,
          isolate(url),
          '',
          `הקישור תקף ${isolateLtr(String(minutes))} דקות ולשימוש חד-פעמי.`,
        ].join('\n')
      : [
          `Connect ${GRANT_LABELS_EN[grant]}:`,
          isolate(url),
          '',
          `The link is single-use and valid for ${isolateLtr(String(minutes))} minutes.`,
        ].join('\n');
  },

  connected(lang: Lang, grant: GrantName = 'calendar'): string {
    return lang === 'he' ? `${GRANT_LABELS[grant]} מחובר. ✅` : `${GRANT_LABELS_EN[grant]} connected. ✅`;
  },

  /** A grant other than the calendar's is not connected, or has lapsed (2026-10-01). */
  grantNotConnected(grant: GrantName, lang: Lang): string {
    const command = isolate(`/connect ${GRANTS[grant].command}`);
    return lang === 'he'
      ? `${GRANT_LABELS[grant]} לא מחובר. יש לשלוח ${command}.`
      : `${GRANT_LABELS_EN[grant]} is not connected. Send ${command}.`;
  },

  // -- writing ---------------------------------------------------------------

  /** Shown before an event is created, when the action needs confirming. */
  createPreview(
    title: string,
    start: LocalParts,
    end: LocalParts,
    attendees: readonly string[],
    lang: Lang,
  ): string {
    const when = formatRange(start, end, lang);
    const lines =
      lang === 'he'
        ? [`קביעת ${isolate(title)}`, when]
        : [`Create ${isolate(title)}`, when];

    if (attendees.length > 0) {
      // Named explicitly: inviting someone is the part that leaves the system.
      lines.push(
        lang === 'he'
          ? `משתתפים: ${attendees.map(isolate).join(', ')}`
          : `Attendees: ${attendees.map(isolate).join(', ')}`,
      );
    }
    return lines.join('\n');
  },

  created(title: string, start: LocalParts, end: LocalParts, lang: Lang): string {
    return lang === 'he'
      ? `נקבע ביומן: ${isolate(title)}\n${formatRange(start, end, 'he')}`
      : `Added to your calendar: ${isolate(title)}\n${formatRange(start, end, 'en')}`;
  },

  movePreview(title: string, from: LocalParts, to: LocalParts, lang: Lang): string {
    return lang === 'he'
      ? `העברת ${isolate(title)}\nמ${formatWhen(from, 'he')}\nל${formatWhen(to, 'he')}`
      : `Move ${isolate(title)}\nfrom ${formatWhen(from, 'en')}\nto ${formatWhen(to, 'en')}`;
  },

  moved(title: string, to: LocalParts, lang: Lang): string {
    return lang === 'he'
      ? `${isolate(title)} הועבר ל${formatWhen(to, 'he')}.`
      : `${isolate(title)} moved to ${formatWhen(to, 'en')}.`;
  },

  deletePreview(title: string, start: LocalParts, lang: Lang): string {
    return lang === 'he'
      ? `מחיקת ${isolate(title)}\n${formatWhen(start, 'he')}`
      : `Delete ${isolate(title)}\n${formatWhen(start, 'en')}`;
  },

  deleted(lang: Lang): string {
    return lang === 'he' ? 'האירוע נמחק.' : 'Event deleted.';
  },

  /**
   * The etag check failed: the event was edited between the preview and the
   * tap. Nothing was written — which is the point of sending the etag at all.
   */
  changed(lang: Lang): string {
    return lang === 'he'
      ? 'האירוע השתנה מאז שהוצג, אז לא שיניתי אותו. כדאי לבקש שוב ולבדוק את הפרטים.'
      : 'The event changed since it was shown, so nothing was written. Ask again and check the details.';
  },

  /** It was already deleted elsewhere. Not an error, just not news. */
  gone(lang: Lang): string {
    return lang === 'he' ? 'האירוע כבר לא קיים ביומן.' : 'That event is no longer on the calendar.';
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

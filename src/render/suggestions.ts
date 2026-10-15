/**
 * Proactive calendar suggestions' notices and replies (block L, L3,
 * 2026-10-15). Code-written: an event's title is someone else's words, shown
 * cleaned, capped and isolated, never sent to a model. Gender-neutral, ktiv
 * maleh, dugri.
 */
import { isolate } from './bidi.js';
import { cleanItemText } from './phone-reads.js';
import type { Lang } from './format-time.js';
import { localPartsOf, ZONE } from '../time/tz.js';

const MAX_TITLE_CHARS = 60;

const titleOf = (title: string) => isolate(cleanItemText(title).slice(0, MAX_TITLE_CHARS) || '(ללא כותרת)');
const hhmm = (utcMs: number) => {
  const local = localPartsOf(utcMs, ZONE);
  return isolate(`${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}`);
};

/** The hour the suggestions go out when there is no daily digest. */
export const SUGGEST_FALLBACK_HOUR = 19;

export const suggestText = {
  notice(title: string, startUtc: number, lang: Lang): string {
    return lang === 'he'
      ? `📅 מחר ב־${hhmm(startUtc)}: «${titleOf(title)}», עם מיקום. לקבוע תזכורת יציאה?`
      : `📅 Tomorrow at ${hhmm(startUtc)}: "${titleOf(title)}", with a place. Set a reminder to leave?`;
  },

  yesButton(lang: Lang): string {
    return lang === 'he' ? 'כן, לקבוע' : 'Yes, set it';
  },

  noButton(lang: Lang): string {
    return lang === 'he' ? 'לא, תודה' : 'No, thanks';
  },

  dismissed(lang: Lang): string {
    return lang === 'he' ? 'בסדר, בלי תזכורת.' : 'OK, no reminder.';
  },

  cancelled(lang: Lang): string {
    return lang === 'he' ? 'האירוע בוטל או נמחק מהיומן.' : 'The event was cancelled or deleted from the calendar.';
  },

  started(lang: Lang): string {
    return lang === 'he' ? 'האירוע כבר התחיל, מאוחר לתזכורת יציאה.' : 'The event has already started; too late for a leave reminder.';
  },

  noPlace(lang: Lang): string {
    return lang === 'he' ? 'לאירוע כבר אין מיקום.' : 'The event no longer has a place.';
  },

  unavailable(lang: Lang): string {
    return lang === 'he' ? 'לא הצלחתי לבדוק את האירוע ביומן. אפשר ללחוץ שוב.' : "I couldn't check the event in the calendar. Tap again.";
  },

  /** Old, used, not this sender's, or held by another tap right now. Never says which. */
  gone(lang: Lang): string {
    return lang === 'he' ? 'הכפתור הזה כבר לא פעיל.' : 'This button is no longer active.';
  },

  status(on: boolean, lang: Lang): string {
    if (lang === 'he') {
      return on
        ? `הצעות מהיומן פעילות: פעם ביום, בשעת הסיכום היומי (או ב־${isolate(`${SUGGEST_FALLBACK_HOUR}:00`)} כשאין סיכום), אציע תזכורת יציאה לאירועים של מחר שיש להם מיקום. לכיבוי: ${isolate('/suggest off')}.`
        : `הצעות מהיומן כבויות. להפעלה: ${isolate('/suggest on')}.`;
    }
    return on
      ? `Calendar suggestions are on: once a day, at the digest hour (or ${SUGGEST_FALLBACK_HOUR}:00 without a digest), I'll offer a leave reminder for tomorrow's events that have a place. Turn off: /suggest off.`
      : 'Calendar suggestions are off. Turn on: /suggest on.';
  },
};

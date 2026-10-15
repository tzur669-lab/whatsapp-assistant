/**
 * Mail follow-ups' replies and notices (block L, L2, 2026-10-15).
 *
 * Every string holds only the user's own sent subject, times code computed,
 * counts and fixed text. "Someone replied in the thread" is what the check
 * can tell; no string claims the recipient read or answered, and an unsure
 * check never says nobody answered. Gender-neutral, ktiv maleh, dugri.
 */
import { isolate } from './bidi.js';
import { cleanItemText } from './phone-reads.js';
import { formatWhen } from './format-time.js';
import type { Lang } from './format-time.js';
import { localPartsOf } from '../time/tz.js';
import type { FollowUp } from '../tools/followup-store.js';

const ZONE = 'Asia/Jerusalem';
const MAX_SUBJECT_CHARS = 60;

/** Control and bidi characters out, length capped, isolated: a subject is shown, never trusted. */
const subjectOf = (subject: string) => isolate(cleanItemText(subject).slice(0, MAX_SUBJECT_CHARS) || '(ללא נושא)');
const when = (ms: number, lang: Lang) => formatWhen(localPartsOf(ms, ZONE), lang);

export const followUpText = {
  created(subject: string, dueAt: number, lang: Lang): string {
    return lang === 'he'
      ? `📬 אם אף אחד לא יענה על «${subjectOf(subject)}» עד ${when(dueAt, lang)}, אזכיר.`
      : `📬 If nobody replies to "${subjectOf(subject)}" by ${when(dueAt, lang)}, I'll remind you.`;
  },

  cancelled(lang: Lang): string {
    return lang === 'he' ? 'המעקב אחרי המייל בוטל.' : 'The mail follow-up is cancelled.';
  },

  exists(lang: Lang): string {
    return lang === 'he' ? 'כבר יש מעקב על המייל הזה.' : 'That mail already has a follow-up.';
  },

  full(lang: Lang): string {
    return lang === 'he'
      ? `יש כבר 20 מעקבים פעילים. אפשר לבטל אחד דרך ${isolate('/followups')}.`
      : 'There are already 20 active follow-ups. Cancel one with /followups.';
  },

  /** The deadline passed and nobody wrote in the thread. */
  notified(subject: string, dueAt: number, lang: Lang): string {
    return lang === 'he'
      ? `📭 לא ענו על «${subjectOf(subject)}» עד ${when(dueAt, lang)}. להכין טיוטת תזכורת?`
      : `📭 No reply to "${subjectOf(subject)}" by ${when(dueAt, lang)}. Prepare a reminder draft?`;
  },

  bounced(subject: string, lang: Lang): string {
    return lang === 'he'
      ? `⚠️ המייל «${subjectOf(subject)}» לא נמסר: התקבלה הודעת שגיאה משרת הדואר. אפשר לבדוק ב־${isolate('Gmail')}.`
      : `⚠️ "${subjectOf(subject)}" was not delivered: a mail server sent back a failure report. Check in Gmail.`;
  },

  maybeBounced(subject: string, lang: Lang): string {
    return lang === 'he'
      ? `⚠️ על «${subjectOf(subject)}» התקבלה הודעה אוטומטית משרת דואר. ייתכן שהמייל לא נמסר. אפשר לבדוק ב־${isolate('Gmail')}.`
      : `⚠️ A mail server wrote back about "${subjectOf(subject)}". It may not have been delivered. Check in Gmail.`;
  },

  unsure(subject: string, lang: Lang): string {
    return lang === 'he'
      ? `לא הצלחתי לבדוק אם ענו על «${subjectOf(subject)}». אפשר לבדוק ב־${isolate('Gmail')}.`
      : `I couldn't check whether anyone replied to "${subjectOf(subject)}". Check in Gmail.`;
  },

  /** Gmail is not reachable: once a day, whatever the count. */
  couldNotCheck(count: number, lang: Lang): string {
    return lang === 'he'
      ? `לא הייתה גישה ל־${isolate('Gmail')}, אז לא בדקתי ${count === 1 ? 'מעקב אחד שהגיע מועדו' : `${count} מעקבים שהגיע מועדם`}. אבדוק שוב בהמשך.`
      : `Gmail wasn't reachable, so ${count === 1 ? 'one due follow-up was' : `${count} due follow-ups were`} not checked. I'll try again later.`;
  },

  draftButton(lang: Lang): string {
    return lang === 'he' ? 'להכין טיוטה' : 'Prepare draft';
  },

  dismissButton(lang: Lang): string {
    return lang === 'he' ? 'לא צריך' : 'No need';
  },

  dismissed(lang: Lang): string {
    return lang === 'he' ? 'בסדר, סגרתי את המעקב.' : 'OK, the follow-up is closed.';
  },

  /** A button that is old, used, or not this sender's. Never says which. */
  gone(lang: Lang): string {
    return lang === 'he' ? 'הכפתור הזה כבר לא פעיל.' : 'This button is no longer active.';
  },

  /** The reminder draft's body: fixed text, the user edits it in Gmail before sending. */
  draftBody(lang: Lang): string {
    return lang === 'he'
      ? 'היי,\nרציתי לוודא שהמייל הקודם שלי הגיע. אשמח לתשובה כשיתאפשר.\nתודה!'
      : 'Hi,\nJust making sure my previous email reached you. A reply when you can would be great.\nThanks!';
  },

  none(lang: Lang): string {
    return lang === 'he' ? 'אין מעקבי מייל פעילים.' : 'No active mail follow-ups.';
  },

  list(followUps: readonly FollowUp[], lang: Lang): string {
    const he = lang === 'he';
    const lines = followUps.map((followUp, index) =>
      he
        ? `${index + 1}. «${subjectOf(followUp.subject)}» עד ${when(followUp.dueAt, lang)}${followUp.status === 'notified' ? ' (לא ענו)' : ''}`
        : `${index + 1}. "${subjectOf(followUp.subject)}" by ${when(followUp.dueAt, lang)}${followUp.status === 'notified' ? ' (no reply)' : ''}`,
    );
    return `${he ? 'מעקבי מייל פעילים:' : 'Active mail follow-ups:'}\n${lines.join('\n')}`;
  },

  cancelButton(index: number, lang: Lang): string {
    return lang === 'he' ? `ביטול ${index}` : `Cancel ${index}`;
  },
};

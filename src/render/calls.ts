/**
 * Replies for calls and the device companion (PLAN §6.17).
 *
 * Code templates, like every reply. A contact's name appears in none of them:
 * the Worker never learns which contact the phone matched, only how many, so
 * there is nothing to echo — the phone's own screen shows the name and number.
 */
import { isolateLtr } from './bidi.js';
import type { Lang } from './format-time.js';
import type { CallOutcome } from '../device/store.js';

export const callText = {
  /** How it ended, once the phone reported or the dispatch ran out. */
  outcome(outcome: CallOutcome | 'expired', lang: Lang): string {
    switch (outcome) {
      case 'placed':
        return lang === 'he' ? 'יצאה שיחה.' : 'Calling.';
      case 'cancelled':
        return lang === 'he' ? 'בוטל.' : 'Cancelled.';
      case 'no_match':
        return lang === 'he' ? 'אין איש קשר בשם הזה בטלפון.' : 'No contact by that name on the phone.';
      case 'expired':
        return callText.phoneUnavailable(lang);
    }
  },

  phoneUnavailable(lang: Lang): string {
    return lang === 'he'
      ? 'הטלפון לא היה זמין. לא יצאה שיחה.'
      : 'The phone was not reachable. No call was made.';
  },

  noDevice(lang: Lang): string {
    return lang === 'he'
      ? `אין טלפון מחובר. ${isolateLtr('/pair')} כדי לחבר.`
      : `No phone is paired. Send ${isolateLtr('/pair')} to pair one.`;
  },

  /**
   * A number typed into the message is never dialled: the phone's own contact
   * list is the only allowlist of destinations (§6.17).
   */
  numberRefused(lang: Lang): string {
    return lang === 'he'
      ? 'שיחות יוצאות רק לאנשי קשר ששמורים בטלפון, לפי שם. מספר שנכתב בהודעה לא מחויג.'
      : 'Calls go only to contacts saved on the phone, by name. A number in a message is never dialled.';
  },

  /** For the audit trail and any confirmation text. Never sent with a number. */
  preview(name: string, lang: Lang): string {
    return lang === 'he' ? `שיחה ל${name}` : `Call ${name}`;
  },

  pairingCode(code: string, minutes: number, lang: Lang): string {
    return lang === 'he'
      ? [
          `קוד לחיבור האפליקציה בטלפון. תקף ${isolateLtr(String(minutes))} דקות, לשימוש אחד:`,
          '',
          isolateLtr(code),
          '',
          'יש להעתיק אותו ולהדביק באפליקציה. חיבור חדש מנתק את הטלפון הקודם.',
        ].join('\n')
      : [
          `A code to pair the phone app. Valid for ${minutes} minutes, once:`,
          '',
          code,
          '',
          'Copy it into the app. Pairing a new phone unpairs the previous one.',
        ].join('\n');
  },

  /** In the app a call is confirmed on the same phone, in a notification (§6.18). */
  sentToPhone(lang: Lang): string {
    return lang === 'he'
      ? 'בקשת השיחה נשלחה. האישור בהתראה בטלפון.'
      : 'Call request sent. Confirm it in the notification.';
  },

  /** `/pair` in the app: a code in a reply would be readable on the way (§6.18). */
  pairNotInApp(lang: Lang): string {
    return lang === 'he'
      ? 'באפליקציה מחברים טלפון חדש עם קוד צימוד חדש מסקריפט ההגדרה, לא דרך הצ׳אט.'
      : 'In the app, a new phone is paired with a fresh code from the setup script, not through the chat.';
  },

  /** `/pair off` in the app: this phone stops being ours (§6.18). */
  unpairedApp(lang: Lang): string {
    return lang === 'he'
      ? 'הטלפון נותק. כדי לחבר אותו שוב צריך קוד צימוד חדש. תזכורות שלא נמסרו יחכו לחיבור הבא.'
      : 'The phone is unpaired. Pairing again needs a new code. Undelivered reminders wait for the next pairing.';
  },

  unpaired(lang: Lang): string {
    return lang === 'he'
      ? 'הטלפון נותק. שיחות לא ייצאו עד חיבור מחדש.'
      : 'The phone is unpaired. No calls until it is paired again.';
  },

  nothingPaired(lang: Lang): string {
    return lang === 'he' ? 'אין טלפון מחובר.' : 'No phone is paired.';
  },

  /** The pepper or the push key is missing, so pairing would lead nowhere. */
  notConfigured(lang: Lang): string {
    return lang === 'he' ? 'שיחות עדיין לא מוגדרות בשרת.' : 'Calls are not set up on the server yet.';
  },
};

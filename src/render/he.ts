/**
 * Hebrew reply templates. Every user-facing string is code-authored — the LLM
 * never writes a reply (CLAUDE.md invariant 1).
 *
 * Conventions:
 * - Gender-neutral phrasing throughout ("יש לשלוח", not "תשלח").
 * - Ktiv maleh per the Academy of the Hebrew Language.
 * - Every Latin run, slash command, and time is bidi-isolated (PLAN §6.3).
 * - Dugri register: direct, no softeners. That is the expected tone here.
 */
import { isolate, isolateLtr } from './bidi.js';

const SYSTEM_COMMANDS = ['/help', '/status', '/digest', '/shabbat', '/ical', '/birthday', '/pause', '/resume', '/connect google', '/pair', '/budget']
  .map(isolate)
  .join(' · ');

/** In the app there is no message budget, and a phone is paired with a code, not `/pair` (§6.18). */
const APP_COMMANDS = ['/help', '/status', '/digest', '/shabbat', '/ical', '/birthday', '/pause', '/resume', '/connect google', '/pair off']
  .map(isolate)
  .join(' · ');

function helpText(channel: 'whatsapp' | 'app'): string {
  return [
    'עוזר אישי. אפשר לבקש:',
    '',
    `• תזכורת — תזכיר לי מחר ב${isolateLtr('-8')} להתקשר לאבא`,
    '• רשימת תזכורות — מה התזכורות שלי',
    '• יומן — מה יש לי ביומן מחר',
    `• פגישה — תקבע פגישה עם יוסי מחר ב${isolateLtr('-14:00')}`,
    channel === 'app'
      ? '• שיחה — תתקשר לדוד דני (האישור בהתראה בטלפון)'
      : `• שיחה — תתקשר לדוד דני (מהטלפון, אחרי חיבור ב${isolate('/pair')})`,
    '',
    'אפשר גם להקליט הודעה קולית במקום לכתוב. מה שנשמע יוצג בתשובה.',
    '',
    `לתקציר יומי: ${isolate('/digest 7')} — המספר הוא השעה. ביום ריק לא נשלחת הודעה.`,
    `לחיבור יומן חיצוני: ${isolate('/ical')} ואחריו קישור ה-ics.`,
    `ימי הולדת: ${isolate('/birthday דנה 14.3')} — יופיעו בתקציר ביום עצמו.`,
    '',
    `פקודות מערכת: ${channel === 'app' ? APP_COMMANDS : SYSTEM_COMMANDS}`,
  ].join('\n');
}

export const he = {
  help: helpText('whatsapp'),

  /** `/help` in the app (§6.18). */
  helpApp: helpText('app'),

  pong: 'פונג ✅',

  /** Reply to image, document, location — anything that is not text, audio, or a button. */
  unsupportedType:
    'אפשר לשלוח הודעת טקסט או הקלטה קולית. סוגי קבצים אחרים לא נתמכים כרגע.',

  /**
   * What the recognizer heard, echoed above every answer to a voice note. This
   * is the only way to see what the system actually received, so it is shown
   * even when the recording came through perfectly (PLAN §6.10).
   */
  heard: (transcript: string): string => `שמעתי: ${isolate(transcript)}`,

  /** The recording held no speech — an accidental press, or pure background noise. */
  voiceSilent: 'לא שמעתי דיבור בהקלטה. כדאי להקליט שוב.',

  /** Speech was there, but the recognizer is not sure enough to act on it. */
  voiceUnclear:
    'לא הצלחתי להבין את ההקלטה. כדאי להקליט שוב לאט יותר וקרוב יותר למכשיר, או לכתוב את הבקשה.',

  voiceLanguage: 'ההקלטה אינה בעברית או באנגלית. כדאי להקליט שוב באחת מהשתיים.',

  /** The audio never arrived, or transcription failed. Carries no error detail. */
  voiceFailed: 'לא הצלחתי לתמלל את ההקלטה. כדאי לנסות שוב בעוד רגע, או לכתוב את הבקשה.',

  voiceTooLong: 'ההקלטה ארוכה מדי לתמלול. כדאי להקליט הודעה קצרה יותר.',

  /** More recordings in the last hour than the app channel allows (§6.18). */
  voiceTooMany: 'נשלחו יותר מדי הקלטות בשעה האחרונה. אפשר לכתוב את הבקשה בינתיים.',

  /**
   * Stands in for the echo when the answer to a voice note arrives from the
   * outbox rather than in the HTTP response. The transcript is never stored,
   * so the stored copy cannot carry it (§6.10, §6.18).
   */
  heardNotKept: '(התמלול לא נשמר.)',

  /** NLU could not produce a usable intent. Never guess — ask again. */
  notUnderstood: `לא הבנתי את הבקשה. אפשר לנסח מחדש, או לשלוח ${isolate('/help')} לרשימת הפקודות.`,

  /** Generic failure. Carries no error details — those go to the log only. */
  internalError: 'קרתה תקלה זמנית והפעולה לא בוצעה. כדאי לנסות שוב בעוד רגע.',

  /**
   * A turn that failed part-way in the app. Unlike `internalError` it does not
   * promise that nothing happened: a tool may have run before the failure (§6.18).
   */
  unknownOutcome: 'קרתה תקלה באמצע. לא בטוח שהבקשה בוצעה. כדאי לבדוק לפני ששולחים שוב.',
} as const;

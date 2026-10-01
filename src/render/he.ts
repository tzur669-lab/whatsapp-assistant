/**
 * Hebrew reply templates. Every system reply is code-authored. The agent's own
 * chat answers are model text (PLAN §6.19), but anything that reports, asks to
 * confirm, or refuses an action is written here.
 *
 * Conventions:
 * - Gender-neutral phrasing throughout ("יש לשלוח", not "תשלח").
 * - Ktiv maleh per the Academy of the Hebrew Language.
 * - Every Latin run, slash command, and time is bidi-isolated (PLAN §6.3).
 * - Dugri register: direct, no softeners. That is the expected tone here.
 */
import { isolate, isolateLtr } from './bidi.js';

const SYSTEM_COMMANDS = ['/help', '/status', '/digest', '/shabbat', '/ical', '/city', '/birthday', '/pause', '/resume', '/forget', '/connect google', '/pair', '/budget']
  .map(isolate)
  .join(' · ');

/** In the app there is no message budget, and a phone is paired with a code, not `/pair` (§6.18). */
const APP_COMMANDS = ['/help', '/status', '/digest', '/shabbat', '/ical', '/city', '/birthday', '/pause', '/resume', '/forget', '/connect google', '/connect gmail', '/connect tasks', '/connect drive', '/pair off']
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
    'אפשר גם לשאול שאלות ולשוחח בחופשיות. השיחה נזכרת לכמה שעות, מוצפנת.',
    `למחיקת זיכרון השיחה: ${isolate('/forget')}`,
    '',
    'אפשר גם להקליט הודעה קולית במקום לכתוב. מה שנשמע יוצג בתשובה.',
    '',
    `לתקציר יומי: ${isolate('/digest 7')} — המספר הוא השעה. ביום ריק לא נשלחת הודעה.`,
    `לחיבור יומן חיצוני: ${isolate('/ical')} ואחריו קישור ה-ics.`,
    `מזג אוויר, לוח עברי וזמני שבת, שערי מטבע וחדשות: פשוט לשאול. העיר נקבעת ב${isolate('/city')}.`,
    `מייל, רשימות ו־Drive: אחרי חיבור ב${isolate('/connect gmail')}, ${isolate('/connect tasks')}, ${isolate('/connect drive')}.`,
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

  /** A second message while the agent is still answering the first (PLAN §6.19). */
  agentBusy: 'רגע, אני עוד עונה על ההודעה הקודמת. אפשר לשלוח שוב בעוד כמה שניות.',

  /**
   * The agent stopped after a tool had already run. Nothing is re-run, and the
   * reply does not claim that nothing happened (§6.19).
   */
  agentIncomplete: 'לא הצלחתי להשלים את התשובה. כדאי לבדוק מה כבר בוצע לפני ששולחים שוב.',

  /** `/forget` (§6.19). */
  forgotten: 'זיכרון השיחה נמחק.',

  /**
   * Stands in for a voice note in the conversation history. The transcript is
   * message content and is never stored (invariant 13).
   */
  voicePlaceholder: '[הודעה קולית]',

  /** The phone did not answer a read in time (PLAN §6.21). Nothing was changed. */
  phoneReadTimedOut: 'הטלפון לא החזיר תשובה בזמן. אפשר לשלוח את הבקשה שוב.',

  /** A newer message took over while the phone was still reading (§6.21). */
  phoneReadCancelled: 'הבקשה הזאת בוטלה, כי בינתיים נשלחה הודעה חדשה.',
} as const;

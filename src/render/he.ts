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

const SYSTEM_COMMANDS = ['/help', '/status', '/digest', '/pause', '/resume', '/connect google', '/budget']
  .map(isolate)
  .join(' · ');

export const he = {
  help: [
    'עוזר אישי. אפשר לבקש:',
    '',
    `• תזכורת — תזכיר לי מחר ב${isolateLtr('-8')} להתקשר לאבא`,
    '• רשימת תזכורות — מה התזכורות שלי',
    '• יומן — מה יש לי ביומן מחר',
    `• פגישה — תקבע פגישה עם יוסי מחר ב${isolateLtr('-14:00')}`,
    '',
    'אפשר גם להקליט הודעה קולית במקום לכתוב. מה שנשמע יוצג בתשובה.',
    '',
    `לתקציר יומי: ${isolate('/digest 7')} — המספר הוא השעה. ביום ריק לא נשלחת הודעה.`,
    '',
    `פקודות מערכת: ${SYSTEM_COMMANDS}`,
  ].join('\n'),

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

  /** NLU could not produce a usable intent. Never guess — ask again. */
  notUnderstood: `לא הבנתי את הבקשה. אפשר לנסח מחדש, או לשלוח ${isolate('/help')} לרשימת הפקודות.`,

  /** Generic failure. Carries no error details — those go to the log only. */
  internalError: 'קרתה תקלה זמנית והפעולה לא בוצעה. כדאי לנסות שוב בעוד רגע.',
} as const;

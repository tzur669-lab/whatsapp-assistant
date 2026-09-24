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

const SYSTEM_COMMANDS = ['/help', '/status', '/pause', '/resume', '/connect google', '/budget']
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
    `פקודות מערכת: ${SYSTEM_COMMANDS}`,
  ].join('\n'),

  pong: 'פונג ✅',

  /** Reply to image, audio, document, location — anything that is not text or a button. */
  unsupportedType: 'אני מטפל בפקודות טקסט בלבד. יש לשלוח הודעת טקסט או ללחוץ על אחד הכפתורים.',

  /** NLU could not produce a usable intent. Never guess — ask again. */
  notUnderstood: `לא הבנתי את הבקשה. אפשר לנסח מחדש, או לשלוח ${isolate('/help')} לרשימת הפקודות.`,

  /** Generic failure. Carries no error details — those go to the log only. */
  internalError: 'קרתה תקלה זמנית והפעולה לא בוצעה. כדאי לנסות שוב בעוד רגע.',
} as const;

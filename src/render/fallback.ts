/**
 * "לא הבנתי" with a way forward (block H part 18, 2026-10-07).
 *
 * When nothing ran, the reply adds two phrasings that do work, for the topic
 * the words pointed at (`agent/tool-groups.ts`). Static, code-written — the
 * same examples every time, so they can be trusted to work.
 */
import { isolateLtr } from './bidi.js';
import type { GroupName } from '../agent/tool-groups.js';

const EXAMPLES: Readonly<Record<GroupName, readonly [string, string]>> = {
  time: [`תזכיר לי מחר ב${isolateLtr('-8')} להתקשר לאבא`, 'מה יש לי ביומן ביום חמישי?'],
  records: ['תוסיף חלב לרשימת קניות', 'מה הפתקים שלי'],
  info: ['מה מזג האוויר מחר?', `כמה זה ${isolateLtr('15%')} מ${isolateLtr('-240')}?`],
  mail: ['יש מייל חדש מהבנק?', 'אילו חשבונות יש לשלם?'],
  drive: ['תמצא לי בדרייב את הקובץ של החוזה', 'איפה המסמך של הביטוח?'],
  phone: [`תעיר אותי ב${isolateLtr('-6:30')}`, 'תנווט הביתה'],
};

const GENERAL: readonly [string, string] = [`תזכיר לי מחר ב${isolateLtr('-8')} להתקשר לאבא`, 'מה הפתקים שלי'];

/** Two examples: the first matched group's, or general ones. */
export function examplesFor(groups: readonly GroupName[]): string {
  const [first, second] = groups[0] ? EXAMPLES[groups[0]] : GENERAL;
  return `אפשר לנסות למשל:\n• ${first}\n• ${second}`;
}

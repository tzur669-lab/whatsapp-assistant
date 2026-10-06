/**
 * Tool selection by code (PLAN §6.19, 2026-10-06).
 *
 * Every tool offered is prompt tokens on every call: the full catalog is about
 * 5K tokens of a qwen minute's 8K. So the words of the message pick a group,
 * and only that group is offered — but only on a clean signal. **Exactly one
 * group hit → that group; none, or two or more → the full catalog.** A request
 * that mixes domains, or names none ("כן, את זה"), gets every tool, as before.
 *
 * Code only ever narrows what `agentToolNames` would offer; it never adds a
 * tool. Tools that write similar records (notes, tasks, expenses) share one
 * group, so a near miss between them cannot hide the right one.
 *
 * Pure: no I/O, no Cloudflare (invariant 11).
 */
import { normalizeHebrew } from '../time/hebrew-lexicon.js';
import type { ToolName } from '../tools/registry.js';
import { TOOL_NAMES } from '../tools/registry.js';

export type GroupName = 'time' | 'records' | 'info' | 'mail' | 'drive' | 'phone';

export const GROUPS: Readonly<Record<GroupName, readonly ToolName[]>> = {
  time: [
    'reminders.create',
    'reminders.list',
    'reminders.cancel',
    'reminders.repeat',
    'reminders.move',
    'reminders.at_rest',
    'reminders.scheduled_read',
    'reminders.leave',
    'calendar.list_events',
    'calendar.create_event',
    'calendar.move_event',
    'calendar.delete_event',
    'calendar.free_time',
    'birthdays.upcoming',
  ],
  records: [
    'notes.save',
    'notes.find',
    'notes.delete',
    'tasks.list',
    'tasks.add',
    'tasks.complete',
    'expenses.add',
    'expenses.summary',
    'expenses.export',
  ],
  info: ['info.lookup', 'calc.compute'],
  mail: ['mail.search', 'mail.draft', 'mail.bills'],
  drive: ['drive.search'],
  phone: [
    'calls.place',
    'alarm.set',
    'timer.set',
    'nav.go',
    'app.open',
    'settings.set',
    'message.compose',
    'media.play',
    'phone.contacts',
    'phone.notifications',
    'phone.sms',
    'phone.calls',
  ],
};

/**
 * Hebrew stems match anywhere in a word, so prefixes (ו־, ה־, ל־, ב־, ש־) need
 * no pattern of their own. English words match on word boundaries. Patterns
 * are deliberately broad: a stray hit makes a second group, and two groups
 * mean the full catalog, which is the safe direction.
 */
/**
 * A whole Hebrew word, with up to two one-letter prefixes (ו, ה, ל, ב, ש, מ, כ).
 * For stems short enough to hide inside other words: שיר is in שירות, נגן in
 * מנגנון, מחר in מחרוזת.
 */
function word(stem: string): RegExp {
  return new RegExp(`(?<![א-ת])[והלבשמכ]{0,2}(?:${stem})(?![א-ת])`);
}

const PATTERNS: Readonly<Record<GroupName, readonly RegExp[]>> = {
  time: [
    /תזכ/, /להזכיר/, /הזכר/, /יומן/, /פגיש/, /אירוע/, /לקבוע/, /תקבע/, /קבע לי/, /תזמן/, /לוח זמנים/,
    /פנוי/, /מה יש לי/, word('מחר|מחרתיים'), /השבוע/, /שבוע הבא/, /בשעה/, /תדחה/, /לדחות/, /תזיז/, /להזיז/,
    /\b(?:remind|reminders?|calendar|meetings?|events?|appointments?|agenda|schedule|tomorrow|free time)\b/i,
    // Stems, for typos ("reminde me tomorow").
    /\bremind/i, /\btomm?or/i,
    /יום הולדת/, /יום ההולדת/, /ימי הולדת/, /ימי ההולדת/, /יומולדת/, /\bbirthdays?\b/i,
    // "Which alerts are active?" asks about reminders the user set, and the
    // phone claims the same word for its notifications: both groups, so the
    // full catalog (2026-10-06).
    /התרא/, /\balerts?\b/i,
  ],
  records: [
    /פתק/, word('הערה|הערות'), /רשום/, /רשמ/, /סיסמ/,
    // "Remember that …" is a note, though it shares a stem with reminders.
    /תזכור(?!ו?ת)/, /לזכור/,
    // "Remind me what / where / when …" asks for something written down.
    /תזכיר לי (?:את|מה|איפה|מתי|איך)/, /תרשמ/, /תכתוב לי/, /כתבתי/, /תשמור/, /לשמור/, /שמרתי/, /משימ/,
    word('מטלה|מטלות'), /רשימ/, /הוצא/, /שילמתי/, /שקל/, /₪/, /קניתי/, /עלה לי/, /תקציב/, /אקסל/,
    /מה נשאר לי לעשות/,
    /\b(?:notes?|tasks?|todo|to-do|expenses?|spent|paid|budget|excel)\b/i,
  ],
  info: [
    /מזג/, /גשם/, /טמפרטור/, /קרינה/, /איכות האוויר/, /ויקיפדיה/, /מי זה/, /מי היה/, /מה זה/,
    /חדשות/, /כותרות/, /כמה עולה/, /מחיר/, /תחשב/, /חשב לי/, /חישוב/, word('אחוז|אחוזים'), /כפול/, /חלקי/, /שקיעה/, /זריחה/, word('שבת'), /הדלקת נרות/,
    /\d\s*[-+*/x×÷]\s*\d/, /%/,
    /\b(?:weather|rain|temperature|uv|air quality|wikipedia|calculate|percent|sunset|sunrise|shabbat|news|headlines)\b/i,
  ],
  mail: [
    /מייל/, /דואר/, /ג'ימייל/, /חשבונות לתשלום/, /חשבון לתשלום/, /חשבוני/, /דרישת תשלום/,
    /\b(?:e-?mails?|mail|gmail|inbox|bills?|invoices?)\b/i,
  ],
  drive: [/דרייב/, /קובץ/, /קבצים/, /מסמך/, /מסמכים/, /\b(?:drive|files?|documents?)\b/i],
  phone: [
    // Not להתקשר: "תזכיר לי להתקשר" is a reminder; a call is asked as תתקשר.
    /תתקשר/, /תחייג/, /חייג/, /תצלצל/, /שיחה ל/, /איש קשר/, /אנשי קשר/, /מספר של/, /טלפון של/,
    /התראות/, /נוטיפיקציות/, /התקשר אלי/, /שיחות/, /שיחה שלא נענתה/, /פספסתי/, word('הודעה|הודעות'), /תשלח/, /סמס/, /וואטסאפ/, /ווטסאפ/, /שעון מעורר/,
    /תעיר/, /להעיר/, /השכמה/, /טיימר/, /שעון עצר/, /תנווט/, /ניווט/, /וויז/, /איך מגיעים/, /תפתח/,
    /אפליקצי/, /הגדרות/, /בהירות/, /מצב טיסה/, /בלוטות/, /ווליום/, /עוצמת/, /תנגן/, word('נגן'), /מוזיקה/,
    word('שיר|שירים'), /ספוטיפיי/,
    /\b(?:call|dial|contacts?|notifications?|alerts?|sms|text|whatsapp|missed calls?|who called|alarm|wake me|timer|navigate|waze|open|app|settings|volume|play|music|song|spotify)\b/i,
  ],
};

const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];

/** The groups the message's words point at, in a fixed order. */
export function matchGroups(text: string): GroupName[] {
  const normalized = normalizeHebrew(text);
  return GROUP_NAMES.filter((group) => PATTERNS[group].some((pattern) => pattern.test(normalized)));
}

export type Selection = {
  /** The tools to offer, in the order given (registry order). */
  tools: ToolName[];
  /** The one group narrowed to, or null when the full set is offered. */
  group: GroupName | null;
};

/**
 * Narrow `offered` to the one group the text names, or keep it whole. Never
 * returns a tool `offered` does not contain.
 *
 * A group mostly unavailable here — no more than half its tools offered — keeps
 * the full set too: "wake me at 6" in an app without cards cannot set an alarm,
 * and the reminder it can set is in another group.
 */
export function selectTools(text: string, offered: readonly ToolName[]): Selection {
  const groups = matchGroups(text);
  if (groups.length !== 1) return { tools: [...offered], group: null };
  const group = groups[0]!;
  const members = new Set<ToolName>(GROUPS[group]);
  const tools = offered.filter((tool) => members.has(tool));
  if (tools.length * 2 <= GROUPS[group].length) return { tools: [...offered], group: null };
  return { tools, group };
}

/** Every registry tool's group. Used by the test that every tool has exactly one. */
export function groupOf(tool: ToolName): GroupName | null {
  return GROUP_NAMES.find((group) => GROUPS[group].includes(tool)) ?? null;
}

export const ALL_TOOLS: readonly ToolName[] = TOOL_NAMES;

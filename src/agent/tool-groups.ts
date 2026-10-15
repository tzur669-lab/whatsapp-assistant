/**
 * Tool selection by code (PLAN §6.19, 2026-10-06).
 *
 * Every tool offered is prompt tokens on every call: the full catalog is about
 * 5K tokens of a qwen minute's 8K. So the words of the message pick a group,
 * and only that group is offered — but only on a clean signal. **Exactly one
 * to three group hits → their union; none, or four and more → the full
 * catalog** (2026-10-07; before, two groups meant the full catalog). A message
 * that names no group ("כן, את זה") gets every tool, as before.
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

export type GroupName = 'time' | 'records' | 'info' | 'mail' | 'drive' | 'phone' | 'routine' | 'screen';

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
    'reminders.when',
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
    'expenses.monthly_pack',
    'lists.add',
    'lists.show',
    'lists.remove',
    'lists.delete',
    'memory.remember',
    'memory.forget',
    'portfolio.update',
    'portfolio.show',
  ],
  info: ['info.lookup', 'calc.compute', 'web.read'],
  mail: ['mail.search', 'mail.draft', 'mail.bills', 'mail.follow_up', 'mail.archive'],
  drive: ['drive.search', 'docs.create'],
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
  // Routines (§6.27): offered only when the message names a synced routine
  // (decision D4), and then kept whatever group the words select.
  // A routine draft (docs/plans/routine-builder.md) is offered only when the
  // words ask to build one; kept whatever group the words select, like these.
  routine: ['routine.run', 'routine.draft'],
  // The screen agent (§6.28): offered only when the message names it or an app
  // on its list, and then kept whatever group the words select, like routines.
  screen: ['screen.task'],
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
    // "Send me the weather every morning" is a scheduled read, a time tool
    // (2026-10-07: the whole corpus is now gated, and these were hidden).
    /כל (?:בוקר|ערב|לילה|יום|שבוע|חודש)/, /\bevery (?:day|morning|evening|night|week)\b/i, /\bdaily\b/i,
  ],
  records: [
    /פתק/, word('הערה|הערות'), /רשום/, /רשמ/, /סיסמ/,
    // The monthly bookkeeping file (block L, L4): "קובץ" alone is Drive's word.
    /הנהלת חשבונות/, /רואה ה?חשבון/, /\b(?:bookkeeping|accountant)\b/i,
    // "Remember that …" is a note, though it shares a stem with reminders.
    /תזכור(?!ו?ת)/, /לזכור/,
    // "Remind me what / where / when …" asks for something written down.
    /תזכיר לי (?:את|מה|איפה|מתי|איך)/, /תרשמ/, /תכתוב לי/, /כתבתי/, /תשמור/, /לשמור/, /שמרתי/, /משימ/,
    word('מטלה|מטלות'), /רשימ/, /הוצא/, /שילמתי/, /שקל/, /₪/, /קניתי/, /עלה לי/, /תקציב/, /אקסל/,
    /מה נשאר לי לעשות/,
    /\b(?:notes?|tasks?|todo|to-do|expenses?|spent|paid|budget|excel)\b/i,
    // The stock portfolio (block H part 19).
    word('מניה|מניות|מניית'), /תיק השקעות/, /תיק המניות/, /בורסה/, /בורסת/, /מכרתי/, /שווי התיק/,
    /\b(?:stocks?|shares?|portfolio|ticker)\b/i,
  ],
  info: [
    /מזג/, /גשם/, /טמפרטור/, /קרינה/, /איכות האוויר/, /ויקיפדיה/, /מי זה/, /מי היה/, /מה זה/,
    /חדשות/, /כותרות/, /כמה עולה/, /מחיר/, /תחשב/, /חשב לי/, /חישוב/, word('אחוז|אחוזים'), /כפול/, /חלקי/, /שקיעה/, /זריחה/, word('שבת'), /הדלקת נרות/,
    /\d\s*[-+*/x×÷]\s*\d/, /%/,
    /\b(?:weather|rain|temperature|uv|air quality|wikipedia|calculate|percent|sunset|sunrise|shabbat|news|headlines)\b/i,
  ],
  mail: [
    /מייל/, /דואר/, /ג'ימייל/, /טיוט/, /חשבונות לתשלום/, /חשבון לתשלום/, /חשבוני/, /דרישת תשלום/,
    /\b(?:e-?mails?|mail|gmail|inbox|bills?|invoices?|drafts?)\b/i,
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
  // For "לא הבנתי" examples only: selection never narrows by this group.
  routine: [/שגר/, /רוטינ/, /\broutines?\b/i],
  // Like `routine`: for the examples after "לא הבנתי" only; selection never narrows by it.
  screen: [/סוכן\s*(?:ה)?מסך/, /\bscreen agent\b/i],
};

const GROUP_NAMES = Object.keys(GROUPS) as GroupName[];

/**
 * The user asked to keep a fact about themselves (§6.26): "תזכור עליי",
 * "על עצמי", "תזכור לתמיד", "remember about me". The one list code acts on —
 * without it, `memory.remember` is an offer behind a confirmation (2026-10-14).
 * The tool's description, the help and the hint only describe it.
 */
const REMEMBER_ABOUT_ME: readonly RegExp[] = [
  /(?:תזכור|תזכרי|זכור|זכרי)\s+עלי(?:י)?(?![א-ת])/,
  /(?<![א-ת])על עצמי(?![א-ת])/,
  /(?:תזכור|תזכרי|זכור|זכרי)\s+לתמיד/,
  /\bremember\s+(?:this\s+|that\s+)?about\s+me\b/i,
];

export function namesRememberAboutMe(text: string): boolean {
  const normalized = normalizeHebrew(text);
  return REMEMBER_ABOUT_ME.some((pattern) => pattern.test(normalized));
}

/** The groups the message's words point at, in a fixed order. */
export function matchGroups(text: string): GroupName[] {
  const normalized = normalizeHebrew(text);
  return GROUP_NAMES.filter((group) => PATTERNS[group].some((pattern) => pattern.test(normalized)));
}

export type Selection = {
  /** The tools to offer, in the order given (registry order). */
  tools: ToolName[];
  /** The groups narrowed to, in a fixed order; empty when the full set is offered. */
  groups: GroupName[];
};

/** Up to this many groups are offered as their union; more is the full set. */
export const MAX_UNION_GROUPS = 3;

/**
 * Narrow `offered` to the groups the text names, or keep it whole. Never
 * returns a tool `offered` does not contain.
 *
 * One to three groups: their union (2026-10-07, ROADMAP block H). Before, two
 * groups meant the full catalog; with more tools that no longer fits a turn.
 * None, or four and more: the full set — a message that names nothing, or
 * everything, is not narrowed.
 *
 * A group mostly unavailable here — no more than half its tools offered — keeps
 * the full set too, whichever of the matched groups it is: "wake me at 6" in an
 * app without cards cannot set an alarm, and the reminder it can set is in
 * another group.
 */
export function selectTools(
  text: string,
  offered: readonly ToolName[],
  /**
   * The previous local turn's groups (block J, J2a; `last-selection.ts`):
   * used only where the words would get the full set, and only narrow it.
   */
  inherited?: readonly GroupName[],
): Selection {
  // `routine.run` is offered only when the words name a routine (D4); then it
  // stays in whatever the other words select. The group itself never narrows.
  const named = matchGroups(text).filter((group) => group !== 'routine' && group !== 'screen');
  const full = { tools: [...offered], groups: [] };
  // Code found a routine named and the words name nothing else: the routine and
  // the time tools ("תזכיר לי לפתוח את פיד" is still a reminder). The whole
  // catalog with the routine on top passed the turn cap (2026-10-11). The
  // screen agent, when offered too, stays: a routine named "פיד" must not hide
  // "סוכן מסך תחפש בפיד" (found on the phone, 2026-10-12).
  if (named.length === 0 && offered.includes('routine.run')) {
    const withScreen = offered.includes('screen.task');
    const members = new Set<ToolName>(['routine.run', 'routine.draft', ...GROUPS.time, ...(withScreen ? (['screen.task'] as const) : [])]);
    return {
      tools: offered.filter((tool) => members.has(tool)),
      groups: withScreen ? ['time', 'routine', 'screen'] : ['time', 'routine'],
    };
  }
  // Asked to build a routine and nothing else named (no routine synced): the
  // draft, the screen agent beside it ("do it now"), and the phone's tools.
  if (named.length === 0 && offered.includes('routine.draft')) {
    const withScreen = offered.includes('screen.task');
    const members = new Set<ToolName>(['routine.draft', ...GROUPS.phone, ...(withScreen ? (['screen.task'] as const) : [])]);
    return { tools: offered.filter((tool) => members.has(tool)), groups: withScreen ? ['phone', 'routine', 'screen'] : ['phone', 'routine'] };
  }
  // The screen agent named and nothing else: it, and the phone's tools
  // ("תפתח את פיד" may still mean only opening the app).
  if (named.length === 0 && offered.includes('screen.task')) {
    const members = new Set<ToolName>(['screen.task', ...GROUPS.phone]);
    return { tools: offered.filter((tool) => members.has(tool)), groups: ['phone', 'screen'] };
  }
  const groups =
    named.length === 0 && inherited
      ? inherited.filter((group) => group !== 'routine' && group !== 'screen').slice(0, MAX_UNION_GROUPS)
      : named;
  if (groups.length === 0 || groups.length > MAX_UNION_GROUPS) return full;
  // Offered only when named or linked, these ride along in any selection.
  const members = new Set<ToolName>(offered.filter((tool) => RIDE_ALONG.has(tool)));
  for (const group of groups) {
    const available = GROUPS[group].filter((tool) => offered.includes(tool));
    // A group's size leaves out its named-only tools, which are usually not
    // offered: `drive` is `drive.search` alone unless a document is asked for.
    const size = GROUPS[group].filter((tool) => !RIDE_ALONG.has(tool)).length;
    if (available.filter((tool) => !RIDE_ALONG.has(tool)).length * 2 <= size) return full;
    for (const tool of available) members.add(tool);
  }
  // The screen agent and a routine draft, when offered, ride along and are named in the selection.
  const labelled: GroupName[] = [...groups, ...(members.has('routine.draft') ? (['routine'] as const) : []), ...(members.has('screen.task') ? (['screen'] as const) : [])];
  return { tools: offered.filter((tool) => members.has(tool)), groups: labelled };
}

/** Tools offered only when named or linked: they ride along in any selection. */
const RIDE_ALONG: ReadonlySet<ToolName> = new Set<ToolName>([
  'routine.run',
  'routine.draft',
  'screen.task',
  'web.read',
  'reminders.when',
  'mail.follow_up',
  'expenses.monthly_pack',
  'mail.archive',
  'docs.create',
]);

/** A selection as one word, for logs and the benchmark: `time`, `time+mail`, `full`. */
export function selectionLabel(selection: Selection): string {
  return selection.groups.length === 0 ? 'full' : selection.groups.join('+');
}

/** Every registry tool's group. Used by the test that every tool has exactly one. */
export function groupOf(tool: ToolName): GroupName | null {
  return GROUP_NAMES.find((group) => GROUPS[group].includes(tool)) ?? null;
}

export const ALL_TOOLS: readonly ToolName[] = TOOL_NAMES;

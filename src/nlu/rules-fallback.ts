/**
 * The deterministic parser (PLAN §4, "LLM fallback 2").
 *
 * Last link in the chain: when every model is unavailable, the common phrasings
 * still work. It follows the same contract as the models — never fill a slot the
 * user did not state — and covers a small, well-understood set of patterns
 * rather than trying to be clever. Anything it is unsure of becomes
 * `unsupported`, which the caller turns into a clarification.
 */
import type { NluProvider, NluResponse } from './provider.js';
import type { PromptInput } from './prompt.js';
import { parseHebrewWhen, normalizeHebrew, HEB, HEB_START } from '../time/hebrew-lexicon.js';
import { MAX_TITLE_CHARS } from './slot-schemas.js';

type Draft = Record<string, unknown>;

const REMIND_HE = /תזכיר|תזכורת|להזכיר|תזכרי/;
const REMIND_EN = /\bremind(?:\s+me)?\b|\breminder\b/i;

const LIST_REMINDERS_HE = /(?:מה|אילו).{0,12}תזכורות|התזכורות שלי|רשימת תזכורות/;
const LIST_REMINDERS_EN = /\b(?:my|list|show).{0,12}reminders\b|\bwhat reminders\b/i;

const CALENDAR_LIST_HE = /מה יש לי ביומן|מה ביומן|מה יש ביומן|מה יש לי מחר|לוח הזמנים שלי/;
const CALENDAR_LIST_EN = /\bwhat(?:'s| is| do i have).{0,20}\b(?:calendar|schedule|agenda)\b|\bmy (?:calendar|schedule|agenda)\b/i;

const CREATE_EVENT_HE = /תקבע|לקבוע|קבע לי|פגישה עם|תזמן/;
const CREATE_EVENT_EN = /\b(?:schedule|book|set up|create)\b.{0,20}\b(?:meeting|event|appointment|call)\b/i;

/** Words that mark a request as outside the tool set, whatever else it contains. */
const OFF_TOPIC = /מה השעה|ספר לי בדיחה|מי אתה|\bjoke\b|\bwho are you\b|\bweather\b|מזג האוויר/i;

export function createRulesProvider(): NluProvider {
  return {
    name: 'rules',
    parse(input: PromptInput): Promise<NluResponse> {
      return Promise.resolve({
        ok: true,
        draft: parseByRules(input.text),
        usage: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      });
    },
  };
}

export function parseByRules(rawText: string): Draft {
  const text = normalizeHebrew(rawText);
  const language = /[֐-׿]/.test(text) ? 'he' : 'en';
  const base = { language, missing: [] as string[], ambiguities: [] as { slot: string; note: string }[] };

  if (OFF_TOPIC.test(text)) {
    return { intent: 'unsupported', slots: {}, ...base };
  }

  if (LIST_REMINDERS_HE.test(text) || LIST_REMINDERS_EN.test(text)) {
    return { intent: 'reminders.list', slots: {}, ...base };
  }

  if (CALENDAR_LIST_HE.test(text) || CALENDAR_LIST_EN.test(text)) {
    const when = parseHebrewWhen(text);
    return {
      intent: 'calendar.list_events',
      slots: when.date ? { date: when.date } : {},
      ...base,
      missing: when.date ? [] : ['date'],
    };
  }

  if (CREATE_EVENT_HE.test(text) || CREATE_EVENT_EN.test(text)) {
    const when = parseHebrewWhen(text);
    const title = extractTitle(text, language);
    const missing: string[] = [];
    if (!title) missing.push('title');
    if (!when.date) missing.push('date');
    if (!when.time && when.date?.kind !== 'in_duration') missing.push('time');

    const slots: Draft = {};
    if (title) slots['title'] = title;
    if (when.date) slots['date'] = when.date;
    if (when.time) slots['time'] = when.time;

    return { intent: 'calendar.create_event', slots, ...base, missing };
  }

  if (REMIND_HE.test(text) || REMIND_EN.test(text)) {
    const when = parseHebrewWhen(text);
    const body = extractReminderText(text, language);
    const missing: string[] = [];
    if (!body) missing.push('text');
    if (!when.date) missing.push('date');
    if (!when.time && when.date?.kind !== 'in_duration') missing.push('time');

    const slots: Draft = {};
    if (body) slots['text'] = body;
    if (when.date) slots['date'] = when.date;
    if (when.time) slots['time'] = when.time;

    return { intent: 'reminders.create', slots, ...base, missing };
  }

  return { intent: 'unsupported', slots: {}, ...base };
}

/**
 * The reminder body is what follows the infinitive: "תזכיר לי מחר ב-8 להתקשר
 * לאבא" -> "להתקשר לאבא". If there is no such marker, nothing is guessed.
 */
function extractReminderText(text: string, language: string): string | null {
  if (language === 'he') {
    // `HEB_START`, not `\b`: JavaScript's word boundary is ASCII-only and never
    // fires before a Hebrew letter.
    const infinitive = new RegExp(`${HEB_START}(ל[${HEB}]{2,}.*)$`).exec(text);
    return clean(infinitive?.[1] ?? null);
  }
  const toClause = /\bto\s+(.+)$/i.exec(text);
  return clean(toClause?.[1] ?? null);
}

/** The event title is whoever or whatever the meeting is with. */
function extractTitle(text: string, language: string): string | null {
  if (language === 'he') {
    const withWhom = new RegExp(`${HEB_START}עם\\s+([${HEB}'" ]{2,40})`).exec(text);
    const name = cutAtTimeMarker(withWhom?.[1] ?? null);
    return name ? clean(`פגישה עם ${name}`) : null;
  }
  const withWhom = /\bwith\s+([A-Za-z'\- ]{2,40})/.exec(text);
  const name = cutAtTimeMarker(withWhom?.[1] ?? null);
  return name ? clean(`Meeting with ${name}`) : null;
}

/**
 * A name capture runs on into the rest of the sentence — "יוסי מחר ב-14:00" —
 * so it is cut at the first word that starts the time part.
 */
const TIME_MARKERS = [
  'מחרתיים', 'מחר', 'היום', 'הערב', 'בשעה', 'ביום', 'בבוקר', 'בערב', 'בצהריים', 'בלילה', 'בעוד',
  'ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת',
];

const HE_CUT = new RegExp(`${HEB_START}(?:${TIME_MARKERS.join('|')})`);
const EN_CUT = /\b(?:tomorrow|today|tonight|at|on|next|this|in)\b/i;

function cutAtTimeMarker(value: string | null): string | null {
  if (!value) return null;
  const he = HE_CUT.exec(value);
  const en = EN_CUT.exec(value);
  const cut = Math.min(he?.index ?? value.length, en?.index ?? value.length);
  const head = value.slice(0, cut).trim();
  return head.length >= 2 ? head : null;
}

function clean(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .trim()
    .slice(0, MAX_TITLE_CHARS);
  return trimmed.length >= 2 ? trimmed : null;
}

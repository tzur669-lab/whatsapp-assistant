/**
 * Hebrew time-expression lexicon (PLAN §11.1 "Lexicon tests", §6.2 rules fallback).
 *
 * It produces the same `DateSpec` / `TimeSpec` shape the LLM emits, so it plugs
 * straight into `resolveWhen` and doubles as the deterministic fallback when the
 * NLU provider is unavailable.
 *
 * Hebrew specifics this has to survive:
 * - Prepositions and the article attach to the word: "בשמונה", "ליום", "ובערב".
 *   Every keyword is therefore matched behind an optional prefix cluster.
 * - Nikud is effectively never present, and is stripped when it is. U+05BE MAQAF
 *   sits inside the nikud code range but is punctuation, so it is spared.
 * - Geresh, gershayim, maqaf and quotation marks come in several code points.
 *
 * It is deliberately conservative: an expression it is not sure about yields
 * nothing, and the caller falls back to asking. Never guessing is the point.
 */
import type { DateSpec, TimeSpec } from './resolve.js';

export type LexiconMatch = {
  date?: DateSpec;
  time?: TimeSpec;
};

/**
 * The Hebrew block. JavaScript's word boundary is ASCII-only and never fires
 * between Hebrew letters, so word edges are spelled out as lookarounds instead.
 */
export const HEB = '֐-׿';
/** Left word edge for Hebrew. Use instead of `\b`, which never fires here. */
export const HEB_START = `(?<![${HEB}])`;
/** Right word edge for Hebrew. */
export const HEB_END = `(?![${HEB}])`;

const START = HEB_START;
const END = HEB_END;

/** Prefix particles that attach to a following word: ו ה ב ל מ ש כ, plus a maqaf. */
const PREFIX = '(?:[והבלמשכ]{0,3}-?)';

/** A keyword that may carry attached prefixes, anchored at both word edges. */
function word(literal: string): RegExp {
  return new RegExp(`${START}${PREFIX}${literal}${END}`);
}

/** A bare keyword, with no prefix allowed. */
function exact(literal: string): RegExp {
  return new RegExp(`${START}${literal}${END}`);
}

/**
 * Normalize before matching: NFC, no nikud or cantillation, unified
 * punctuation, collapsed whitespace.
 */
export function normalizeHebrew(text: string): string {
  return text
    .normalize('NFC')
    // Nikud and te'amim, skipping U+05BE MAQAF — it is punctuation, and is
    // normalized to a hyphen below rather than deleted.
    .replace(/[֑-ֽֿ-ׇ]/g, '')
    .replace(/[׳‘’']/g, "'") // geresh variants
    .replace(/[״“”"]/g, '"') // gershayim variants
    .replace(/[־‐-―]/g, '-') // maqaf and dashes
    .replace(/\s+/g, ' ')
    .trim();
}

// -- vocabulary ---------------------------------------------------------------

/** Feminine numerals, used with שעה. */
const HOUR_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['אחת עשרה', 11],
  ['שתים עשרה', 12],
  ['שתיים עשרה', 12],
  ['אחת', 1],
  ['שתיים', 2],
  ['שתים', 2],
  ['שלוש', 3],
  ['ארבע', 4],
  ['חמש', 5],
  ['שש', 6],
  ['שבע', 7],
  ['שמונה', 8],
  ['תשע', 9],
  ['עשר', 10],
];

/** Masculine numerals, used when counting ימים. */
const COUNT_WORDS: ReadonlyArray<readonly [string, number]> = [
  ['אחד', 1],
  ['שניים', 2],
  ['שנים', 2],
  ['שלושה', 3],
  ['שלוש', 3],
  ['ארבעה', 4],
  ['ארבע', 4],
  ['חמישה', 5],
  ['חמש', 5],
  ['שישה', 6],
  ['שש', 6],
  ['שבעה', 7],
  ['שבע', 7],
  ['שמונה', 8],
  ['תשעה', 9],
  ['תשע', 9],
  ['עשרה', 10],
  ['עשר', 10],
];

const WEEKDAYS: ReadonlyArray<readonly [string, 0 | 1 | 2 | 3 | 4 | 5 | 6]> = [
  ['ראשון', 0],
  ['שני', 1],
  ['שלישי', 2],
  ['רביעי', 3],
  ['חמישי', 4],
  ['שישי', 5],
  ['ששי', 5],
  ['שבת', 6],
];

const PARTS_OF_DAY: ReadonlyArray<readonly [string, TimeSpec['part_of_day']]> = [
  ['אחר הצהריים', 'afternoon'],
  ['אחרי הצהריים', 'afternoon'],
  ['אחה"צ', 'afternoon'],
  ['בבוקר', 'morning'],
  ['בוקר', 'morning'],
  ['בצהריים', 'noon'],
  ['בצהרים', 'noon'],
  ['צהריים', 'noon'],
  ['בערב', 'evening'],
  ['ערב', 'evening'],
  ['בלילה', 'night'],
  ['לילה', 'night'],
];

// -- entry point --------------------------------------------------------------

export function parseHebrewWhen(raw: string): LexiconMatch {
  const text = normalizeHebrew(raw);
  const match: LexiconMatch = {};

  // A duration carries its own time, so it short-circuits everything else.
  const duration = parseDuration(text);
  if (duration) return { date: duration };

  const date = parseDate(text);
  if (date) match.date = date;

  const time = parseTime(text);
  if (time) match.time = time;

  return match;
}

// -- durations ("בעוד שעתיים") ------------------------------------------------

const DURATION_UNITS: ReadonlyArray<readonly [RegExp, number]> = [
  [word('דקות?'), 1],
  [word('שעות?'), 60],
  [word('ימים?'), 60 * 24],
];

function parseDuration(text: string): DateSpec | null {
  if (!/בעוד|עוד\s/.test(text)) return null;

  // Fixed phrases first — the dual forms are single words, not "2 X".
  if (/שעתיים/.test(text)) return { kind: 'in_duration', minutes: 120 };
  if (/יומיים/.test(text)) return { kind: 'in_duration', minutes: 60 * 24 * 2 };
  if (/חצי\s*שעה/.test(text)) return { kind: 'in_duration', minutes: 30 };
  if (/רבע\s*שעה/.test(text)) return { kind: 'in_duration', minutes: 15 };

  const count = extractCount(text);
  if (count === null) {
    // "בעוד שעה" — a bare unit with no number means one of it.
    if (word('שעה').test(text)) return { kind: 'in_duration', minutes: 60 };
    return null;
  }

  for (const [pattern, perUnit] of DURATION_UNITS) {
    if (pattern.test(text)) {
      return { kind: 'in_duration', minutes: count * perUnit };
    }
  }
  return null;
}

function extractCount(text: string): number | null {
  const digits = /(\d{1,4})/.exec(text);
  if (digits?.[1]) return Number(digits[1]);

  for (const [literal, value] of COUNT_WORDS) {
    if (word(literal).test(text)) return value;
  }
  return null;
}

// -- dates --------------------------------------------------------------------

function parseDate(text: string): DateSpec | null {
  if (word('מחרתיים').test(text)) return { kind: 'relative_days', offset: 2 };
  if (word('מחר').test(text)) return { kind: 'relative_days', offset: 1 };
  if (word('היום').test(text)) return { kind: 'relative_days', offset: 0 };
  if (exact('הערב').test(text)) return { kind: 'relative_days', offset: 0 };

  // "יום ראשון", "בראשון", "ביום שני הבא"
  for (const [name, weekday] of WEEKDAYS) {
    if (!word(name).test(text)) continue;
    const qualifier = exact('הבא').test(text) ? 'next' : 'unspecified';
    return { kind: 'weekday', weekday, qualifier };
  }

  // Numeric dates: 25.9, 25/9, 25.9.2026 — day first, per Israeli convention.
  const numeric = /(?<!\d)(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?!\d)/.exec(text);
  if (numeric?.[1] && numeric[2]) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const rawYear = numeric[3] === undefined ? undefined : Number(numeric[3]);
      const year = rawYear === undefined ? undefined : rawYear < 100 ? 2000 + rawYear : rawYear;
      return year === undefined
        ? { kind: 'absolute', day, month }
        : { kind: 'absolute', day, month, year };
    }
  }

  return null;
}

// -- times --------------------------------------------------------------------

function parseTime(text: string): TimeSpec | null {
  const base = extractClock(text);
  if (!base) return null;

  return {
    hour: base.hour,
    minute: base.minute,
    meridiem: 'unspecified',
    part_of_day: extractPartOfDay(text),
  };
}

function extractPartOfDay(text: string): TimeSpec['part_of_day'] {
  for (const [literal, value] of PARTS_OF_DAY) {
    if (text.includes(literal)) return value;
  }
  return 'unspecified';
}

function extractClock(text: string): { hour: number; minute: number } | null {
  const hours = HOUR_WORDS.map(([literal]) => literal).join('|');

  // "רבע ל-9" — a quarter to nine is 08:45. Checked first: it names the hour
  // that follows but resolves to the one before it.
  const quarterTo = new RegExp(`רבע\\s*ל-?\\s*(${hours}|\\d{1,2})${END}`).exec(text);
  if (quarterTo?.[1]) {
    const hour = hourValueOf(quarterTo[1]);
    if (hour !== null) return { hour: (hour + 23) % 24, minute: 45 };
  }

  // "10 לשמונה" — ten to eight is 07:50.
  const minutesTo = new RegExp(`(\\d{1,2})\\s*ל-?\\s*(${hours})${END}`).exec(text);
  if (minutesTo?.[1] && minutesTo[2]) {
    const hour = hourValueOf(minutesTo[2]);
    const mins = Number(minutesTo[1]);
    if (hour !== null && mins > 0 && mins < 60) {
      return { hour: (hour + 23) % 24, minute: 60 - mins };
    }
  }

  // "14:30", "8:05"
  const hhmm = /(?<!\d)(\d{1,2})[:.](\d{2})(?!\d)/.exec(text);
  if (hhmm?.[1] && hhmm[2]) {
    const hour = Number(hhmm[1]);
    const minute = Number(hhmm[2]);
    if (hour <= 23 && minute <= 59) return { hour, minute };
  }

  // "ב-8", "בשעה 8", "ב 8"
  const digitHour = new RegExp(
    `${START}(?:בשעה\\s*|ב-\\s*|ב\\s+)(\\d{1,2})(?!\\d)(?!\\s*[:.]\\d)`,
  ).exec(text);
  const wordHour = new RegExp(`${START}${PREFIX}(${hours})${END}`).exec(text);

  const hour =
    digitHour?.[1] !== undefined
      ? Number(digitHour[1])
      : wordHour?.[1] !== undefined
        ? hourValueOf(wordHour[1])
        : null;

  if (hour === null || hour > 23) return null;

  // "שמונה וחצי" -> 08:30, "שמונה ורבע" -> 08:15
  if (exact('וחצי').test(text)) return { hour, minute: 30 };
  if (exact('ורבע').test(text)) return { hour, minute: 15 };

  return { hour, minute: 0 };
}

function hourValueOf(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const n = Number(token);
    return n >= 0 && n <= 23 ? n : null;
  }
  for (const [name, value] of HOUR_WORDS) {
    if (name === token) return value;
  }
  return null;
}

// -- answers ------------------------------------------------------------------
//
// A clarification answer is read under different rules from a request, and the
// difference is the whole point of asking. In "תזכיר לי מחר להתקשר לאבא" a bare
// "8" is just a number in a sentence, and reading it as an hour would be a
// guess. As the answer to "באיזו שעה?" it is the hour and nothing else.
//
// So these are deliberately more permissive than `parseHebrewWhen`, and safe to
// be: they run only when a question is open, only on that question's own slot,
// and only on a short reply — a long message is a new request, not an answer.

/** Past this, a reply is prose, and a number inside it is not the answer. */
const MAX_ANSWER_TOKENS = 8;

const EN_PART_OF_DAY: ReadonlyArray<readonly [RegExp, TimeSpec['part_of_day']]> = [
  [/\bmorning\b/i, 'morning'],
  [/\bnoon\b|\bmidday\b/i, 'noon'],
  [/\bafternoon\b/i, 'afternoon'],
  [/\bevening\b|\btonight\b/i, 'evening'],
  [/\bnight\b/i, 'night'],
];

const EN_WEEKDAYS: ReadonlyArray<readonly [RegExp, 0 | 1 | 2 | 3 | 4 | 5 | 6]> = [
  [/\bsunday\b/i, 0],
  [/\bmonday\b/i, 1],
  [/\btuesday\b/i, 2],
  [/\bwednesday\b/i, 3],
  [/\bthursday\b/i, 4],
  [/\bfriday\b/i, 5],
  [/\bsaturday\b/i, 6],
];

function tooLongForAnAnswer(text: string): boolean {
  return text.split(' ').filter((token) => token.length > 0).length > MAX_ANSWER_TOKENS;
}

/**
 * The hour in a reply to "באיזו שעה?".
 *
 * Returns null when the reply names no clock at all — including when it names
 * only a part of the day ("בערב"), which R11 holds is not a time. The caller
 * asks again rather than defaulting it to an hour nobody said.
 */
export function parseAnswerTime(raw: string): TimeSpec | null {
  const text = normalizeHebrew(raw);
  if (text.length === 0 || tooLongForAnAnswer(text)) return null;

  // Everything a request would accept still counts: "ב-8", "14:30", "רבע ל-9".
  const full = parseTime(text);
  if (full) return full;

  // "8", "8 בערב", "8:30 pm", "20:00"
  const meridiemMatch = /\b(am|pm)\b/i.exec(text);
  const clock = /(?<!\d)(\d{1,2})(?:[:.](\d{2}))?(?!\d)/.exec(text);
  if (!clock?.[1]) return null;

  const hour = Number(clock[1]);
  const minute = clock[2] === undefined ? 0 : Number(clock[2]);
  if (hour > 23 || minute > 59) return null;

  return {
    hour,
    minute,
    meridiem: meridiemMatch?.[1] ? (meridiemMatch[1].toLowerCase() as 'am' | 'pm') : 'unspecified',
    part_of_day: answerPartOfDay(text),
  };
}

function answerPartOfDay(text: string): TimeSpec['part_of_day'] {
  const hebrew = extractPartOfDay(text);
  if (hebrew !== 'unspecified') return hebrew;
  for (const [pattern, value] of EN_PART_OF_DAY) {
    if (pattern.test(text)) return value;
  }
  return 'unspecified';
}

/** The day in a reply to "באיזה יום?" — Hebrew as in a request, plus English. */
export function parseAnswerDate(raw: string): DateSpec | null {
  const text = normalizeHebrew(raw);
  if (text.length === 0 || tooLongForAnAnswer(text)) return null;

  const duration = parseDuration(text);
  if (duration) return duration;

  const hebrew = parseDate(text);
  if (hebrew) return hebrew;

  if (/\bday after tomorrow\b/i.test(text)) return { kind: 'relative_days', offset: 2 };
  if (/\btomorrow\b/i.test(text)) return { kind: 'relative_days', offset: 1 };
  if (/\btoday\b|\btonight\b/i.test(text)) return { kind: 'relative_days', offset: 0 };

  for (const [pattern, weekday] of EN_WEEKDAYS) {
    if (!pattern.test(text)) continue;
    return { kind: 'weekday', weekday, qualifier: /\bnext\b/i.test(text) ? 'next' : 'unspecified' };
  }

  return null;
}

/**
 * Minutes in a reply to "כמה זמן?".
 *
 * A bare number is read as minutes, but only from 5 up: "2" as an answer is far
 * more likely to mean two hours than two minutes, and there is no way to tell,
 * so it is refused and asked again.
 */
export function parseAnswerDuration(raw: string): number | null {
  const text = normalizeHebrew(raw);
  if (text.length === 0 || tooLongForAnAnswer(text)) return null;

  if (/שעה\s*וחצי|\ban? hour and a half\b|\b1\.5\s*(?:hours?|h)\b/i.test(text)) return 90;
  if (/חצי\s*שעה|\bhalf an hour\b/i.test(text)) return 30;
  if (/רבע\s*שעה|\bquarter of an hour\b/i.test(text)) return 15;
  if (/שעתיים|\btwo hours\b/i.test(text)) return 120;

  const numeric = /(?<!\d)(\d{1,4})(?!\d)/.exec(text);
  const count = numeric?.[1] === undefined ? extractCount(text) : Number(numeric[1]);

  // שעה / שעות and דקה / דקות: the singular ends in ה and the plural in ות, so
  // neither is the other with one optional letter.
  const hours = /שע(?:ה|ות)|\bh\b|\bhours?\b|\bhr\b/i.test(text);
  const minutes = /דק(?:ה|ות)|\bmin\b|\bmins\b|\bminutes?\b/i.test(text);

  if (count === null) {
    // "שעה" / "an hour" — a bare unit with no number means one of it.
    if (hours) return 60;
    return null;
  }

  if (hours) return count * 60;
  if (minutes) return count;
  return count >= 5 && count <= 24 * 60 ? count : null;
}

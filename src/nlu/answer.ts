/**
 * Reading the answer to a clarification (PLAN §6.11).
 *
 * The exchange this exists for is the most common one in the system:
 *
 *   "תזכיר לי מחר להתקשר לאבא"  ->  "באיזו שעה?"  ->  "8"
 *
 * Without it the third message is parsed with no memory of the second, matches
 * no tool, and is answered "לא הבנתי" — so the one thing the assistant asks for
 * most often is the one thing it cannot receive.
 *
 * This is deliberately **deterministic code, not a second model call**. The
 * answer to a question code asked is a date, a time, a duration or a phrase, and
 * `src/time/hebrew-lexicon.ts` already reads all four. Parsing it here costs no
 * tokens, works when the provider is down, and keeps the rule that code — never
 * the model — decides what a time means (CLAUDE.md invariant 4).
 *
 * The patch it produces is tool-agnostic. `applyAnswer` maps it onto whichever
 * slot the tool in question actually declares, because the same question means
 * `time` to `reminders.create` and `to_time` to `calendar.move_event`.
 */
import type { DateSpec, TimeSpec } from '../time/resolve.js';
import type { AskedSlot } from '../confirm/questions.js';
import {
  normalizeHebrew,
  parseAnswerDate,
  parseAnswerDuration,
  parseAnswerTime,
} from '../time/hebrew-lexicon.js';
import { parseByRules } from './rules-fallback.js';
import { MAX_QUERY_CHARS, MAX_TITLE_CHARS } from './slot-schemas.js';

/** Neutral slot names, mapped onto each tool's own by `applyAnswer`. */
export type AnswerPatch = {
  text?: string;
  title?: string;
  target?: string[];
  durationMinutes?: number;
  date?: DateSpec;
  time?: TimeSpec;
};

export type AnswerOutcome =
  /** Understood. Merge and re-run the whole request from the top. */
  | { kind: 'filled'; patch: AnswerPatch }
  /** An attempt at an answer that still does not settle it. Ask again. */
  | { kind: 'incomplete' }
  /** "לא" / "בטל". Drop the question and say so. */
  | { kind: 'cancelled' }
  /** Not about the question at all. Drop it and treat this as a new request. */
  | { kind: 'not_an_answer' };

/**
 * Replies that end the exchange. Short and closed: "לא עכשיו, אולי מחר בבוקר"
 * is not on the list, because a sentence that happens to start with "לא" is not
 * reliably a refusal, and reading it as one throws away what the user typed.
 */
const CANCEL = new Set([
  'לא', 'בטל', 'ביטול', 'תבטל', 'עזוב', 'שכח מזה', 'לא משנה', 'לא צריך',
  'no', 'cancel', 'nevermind', 'never mind', 'forget it', 'stop',
]);

export function parseAnswer(asked: AskedSlot, rawText: string): AnswerOutcome {
  const text = normalizeHebrew(rawText);
  if (text.length === 0) return { kind: 'not_an_answer' };

  if (CANCEL.has(text.toLowerCase())) return { kind: 'cancelled' };

  if (looksLikeANewRequest(asked, text)) return { kind: 'not_an_answer' };

  switch (asked) {
    case 'time':
      return timeAnswer(text);

    case 'date': {
      const date = parseAnswerDate(text);
      return date ? { kind: 'filled', patch: { date } } : { kind: 'not_an_answer' };
    }

    case 'when': {
      // "הזמן הזה כבר עבר. למתי לקבוע?" can be answered with a day, an hour, or
      // both, so take whatever is there and let `resolve` judge the result.
      const date = parseAnswerDate(text);
      const time = parseAnswerTime(text);
      if (!date && !time) return timeAnswer(text);
      return {
        kind: 'filled',
        patch: { ...(date ? { date } : {}), ...(time ? { time } : {}) },
      };
    }

    case 'duration': {
      const durationMinutes = parseAnswerDuration(text);
      if (durationMinutes !== null) return { kind: 'filled', patch: { durationMinutes } };
      // A number alone that could be either minutes or hours lands here.
      return /\d/.test(text) ? { kind: 'incomplete' } : { kind: 'not_an_answer' };
    }

    case 'text': {
      const body = phrase(text, MAX_TITLE_CHARS);
      return body ? { kind: 'filled', patch: { text: body } } : { kind: 'incomplete' };
    }

    case 'title': {
      const title = phrase(text, MAX_TITLE_CHARS);
      return title ? { kind: 'filled', patch: { title } } : { kind: 'incomplete' };
    }

    case 'target': {
      const variant = phrase(text, MAX_QUERY_CHARS);
      return variant ? { kind: 'filled', patch: { target: [variant] } } : { kind: 'incomplete' };
    }
  }
}

/**
 * Has the user given up on the question and asked for something else?
 *
 * The test has to differ by slot, and the reason is worth stating. For a time
 * or a date, anything the deterministic parser recognizes as a request is one:
 * those answers are short and structured, and a sentence that parses as a
 * reminder is not an hour.
 *
 * A phrase is the opposite case. "פגישה עם יוסי" is exactly what "מה הפגישה?"
 * is asking for, and it is also what `parseByRules` reads as a request to
 * create an event — so using the same test there would make it impossible to
 * ever answer that question. What marks a real request is that it *opens* with
 * an instruction to the assistant; a title or a reminder body does not.
 */
function looksLikeANewRequest(asked: AskedSlot, text: string): boolean {
  if (asked === 'text' || asked === 'title' || asked === 'target') {
    return IMPERATIVE.test(text);
  }
  return parseByRules(text).intent !== 'unsupported';
}

/**
 * An instruction to the assistant, at the start of the message. Anchored on
 * purpose: "תזכיר לי לקנות חלב" is a request, "לקנות חלב" is an answer, and the
 * difference between them is entirely the opening word.
 */
const IMPERATIVE =
  /^(?:תזכיר|תזכורת|להזכיר|תזכרי|תקבע|לקבוע|קבע|תזמן|תבטל|למחוק|תמחק|מה\s+יש\s+לי|מה\s+ביומן|מה\s+התזכורות)(?![֐-׿])|^(?:remind|schedule|book|cancel|delete|list|show|what)\b/i;

function timeAnswer(text: string): AnswerOutcome {
  const time = parseAnswerTime(text);
  if (time) return { kind: 'filled', patch: { time } };

  // A duration is a legitimate answer to "באיזו שעה?" — "בעוד שעה" names a
  // moment. It arrives as a date, and carries its own time (R1).
  const date = parseAnswerDate(text);
  if (date?.kind === 'in_duration') return { kind: 'filled', patch: { date } };

  // "בערב" names no hour. R11: a part of day is not a time, so ask again rather
  // than default one — a reminder at the wrong hour is the failure this whole
  // system is built to avoid.
  if (PART_OF_DAY_ONLY.test(text)) return { kind: 'incomplete' };

  return { kind: 'not_an_answer' };
}

const PART_OF_DAY_ONLY =
  /בוקר|צהריים|צהרים|ערב|לילה|\bmorning\b|\bnoon\b|\bafternoon\b|\bevening\b|\bnight\b/i;

function phrase(text: string, max: number): string | null {
  const trimmed = text.replace(/\s+/g, ' ').replace(/[.,;:!?]+$/, '').trim().slice(0, max);
  return trimmed.length >= 2 ? trimmed : null;
}

// -- applying -----------------------------------------------------------------

/**
 * Where each neutral key lives on each tool.
 *
 * Written out per tool rather than derived, because the mapping is not
 * mechanical: a move has a `to_time`, a cancel has `query_variants` and no time
 * at all. A tool absent from this table can hold no open question — which is
 * the right default for one added later without thinking about it.
 */
const SLOT_NAMES: Record<string, Partial<Record<keyof AnswerPatch, string>>> = {
  'reminders.create': { text: 'text', date: 'date', time: 'time' },
  'reminders.cancel': { target: 'query_variants', date: 'date' },
  'calendar.list_events': { date: 'date' },
  'calendar.create_event': {
    title: 'title',
    date: 'date',
    time: 'time',
    durationMinutes: 'duration_minutes',
  },
  'calendar.move_event': { target: 'query_variants', date: 'to_date', time: 'to_time' },
  'calendar.delete_event': { target: 'query_variants', date: 'date', time: 'time' },
  'calls.place': { target: 'query_variants' },
  // Agent-only reminders (2026-10-05). "How often?" is not here: its answer is
  // a rule, which no answer parser reads, so the agent takes it from history.
  'reminders.repeat': { text: 'text', time: 'time' },
  'reminders.move': { target: 'query_variants', date: 'to_date', time: 'to_time' },
  'reminders.at_rest': { text: 'text' },
  // Phone actions (§6.20): the two questions code asks itself. The rest are
  // answered through the agent, which has the turn in history.
  'alarm.set': { time: 'time' },
  'timer.set': { durationMinutes: 'duration_minutes' },
};

/**
 * The slot a "which day?" answer fills for this tool, if any. On a move that is
 * `to_date`, so a doubt about `from_date` cannot be settled by one.
 */
export function dateSlotOf(tool: string): string | undefined {
  return SLOT_NAMES[tool]?.date;
}

/** True when a question about this slot can ever be answered for this tool. */
export function canAnswer(tool: string, asked: AskedSlot): boolean {
  const names = SLOT_NAMES[tool];
  if (!names) return false;
  if (asked === 'when') return names.date !== undefined || names.time !== undefined;
  if (asked === 'target') return names.target !== undefined;
  if (asked === 'duration') return names.durationMinutes !== undefined;
  return names[asked] !== undefined;
}

/**
 * Merge an answer into the slots already understood.
 *
 * The answer wins where they overlap — it is the more recent statement of what
 * the user wants. Returns null when the tool declares nothing the patch fits,
 * which the caller treats as "not understood" rather than guessing.
 */
export function applyAnswer(
  tool: string,
  slots: Record<string, unknown>,
  patch: AnswerPatch,
): Record<string, unknown> | null {
  const names = SLOT_NAMES[tool];
  if (!names) return null;

  const merged = { ...slots };
  let applied = false;

  for (const [key, value] of Object.entries(patch) as [keyof AnswerPatch, unknown][]) {
    const name = names[key];
    if (name === undefined || value === undefined) continue;
    merged[name] = value;
    applied = true;
  }

  if (!applied) return null;

  // R1: a duration is a complete moment on its own, so an hour left over from
  // the first message would contradict it. Drop it rather than resolve both.
  if (patch.date?.kind === 'in_duration' && names.time) delete merged[names.time];

  return merged;
}

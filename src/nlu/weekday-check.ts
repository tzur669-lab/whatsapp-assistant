/**
 * Hold the draft's weekdays against the weekdays the message names (PLAN §6.2).
 *
 * The model is a parser, and a parser can miscount. qwen v5 read "ביום שני" —
 * Monday — as `weekday: 2`, counting "second day" on a scale where Sunday is 0
 * (§11.9). A weekday is one of the few things in a draft that code can read out
 * of the words itself, so where the message names a day and the draft names
 * another, the draft's day is not used. The caller asks which day was meant
 * (invariant 12); it never swaps in the day code read, because a message that
 * names two days leaves code guessing too.
 *
 * Only a disagreement does anything. A message that names no day leaves the
 * check with nothing to hold the draft against, and the draft stands.
 */
import { weekdaysNamed } from '../time/hebrew-lexicon.js';
import type { IntentDraft } from './intent-schema.js';

/** Every slot, across all tools, whose value is a `DateSpec`. */
const DATE_SLOTS = ['date', 'from_date', 'to_date'] as const;

export type WeekdayCheck = {
  /** The draft to act on: unchanged, or without the slots that disagreed. */
  draft: IntentDraft;
  /** Names of the slots that disagreed. Names only — never their values. */
  mismatched: readonly string[];
};

export function checkNamedWeekdays(draft: IntentDraft, text: string): WeekdayCheck {
  if (draft.intent === 'unsupported') return { draft, mismatched: [] };

  const slots = draft.slots as Record<string, unknown>;
  const candidates = DATE_SLOTS.filter((name) => weekdayOf(slots[name]) !== null);
  const days = weekdayList(slots[WEEKDAYS_SLOT]);
  const single = weekdayList([slots[WEEKDAY_SLOT]])[0];
  if (candidates.length === 0 && days.length === 0 && single === undefined) return { draft, mismatched: [] };

  const named = weekdaysNamed(text);
  if (named.size === 0) return { draft, mismatched: [] };

  const mismatched: string[] = candidates.filter((name) => {
    const weekday = weekdayOf(slots[name]);
    return weekday !== null && !named.has(weekday);
  });
  // A recurring reminder's days (B6): every one of them must be a day the
  // message names. A series on the wrong day repeats the mistake every week.
  if (days.some((day) => !named.has(day))) mismatched.push(WEEKDAYS_SLOT);
  // An expense's day as a bare number (2026-10-05): the same off-by-one risk.
  if (single !== undefined && !named.has(single)) mismatched.push(WEEKDAY_SLOT);
  if (mismatched.length === 0) return { draft, mismatched: [] };

  const kept = Object.fromEntries(
    Object.entries(slots).filter(([name]) => !mismatched.includes(name)),
  );
  // Removing an optional slot cannot make a valid draft invalid.
  return { draft: { ...draft, slots: kept } as IntentDraft, mismatched };
}

/** The weekday-list slot of `reminders.repeat`, 0 = Sunday. */
const WEEKDAYS_SLOT = 'weekdays';
/** The one-weekday slot of `expenses.add`, 0 = Sunday. */
const WEEKDAY_SLOT = 'weekday';

function weekdayList(value: unknown): (0 | 1 | 2 | 3 | 4 | 5 | 6)[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (day): day is 0 | 1 | 2 | 3 | 4 | 5 | 6 => Number.isInteger(day) && day >= 0 && day <= 6,
  );
}

function weekdayOf(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 | null {
  if (typeof value !== 'object' || value === null) return null;
  const spec = value as { kind?: unknown; weekday?: unknown };
  if (spec.kind !== 'weekday' || typeof spec.weekday !== 'number') return null;
  return spec.weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

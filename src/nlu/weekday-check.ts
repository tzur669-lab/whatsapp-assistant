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
  if (candidates.length === 0) return { draft, mismatched: [] };

  const named = weekdaysNamed(text);
  if (named.size === 0) return { draft, mismatched: [] };

  const mismatched = candidates.filter((name) => {
    const weekday = weekdayOf(slots[name]);
    return weekday !== null && !named.has(weekday);
  });
  if (mismatched.length === 0) return { draft, mismatched: [] };

  const kept = Object.fromEntries(
    Object.entries(slots).filter(([name]) => !mismatched.includes(name as (typeof DATE_SLOTS)[number])),
  );
  // Removing an optional slot cannot make a valid draft invalid.
  return { draft: { ...draft, slots: kept } as IntentDraft, mismatched };
}

function weekdayOf(value: unknown): 0 | 1 | 2 | 3 | 4 | 5 | 6 | null {
  if (typeof value !== 'object' || value === null) return null;
  const spec = value as { kind?: unknown; weekday?: unknown };
  if (spec.kind !== 'weekday' || typeof spec.weekday !== 'number') return null;
  return spec.weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

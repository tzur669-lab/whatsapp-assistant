/**
 * Finding the thing the user described (PLAN §6.4, CLAUDE.md invariant 5).
 *
 * The model never supplies an id. It supplies `query_variants` — spellings of
 * what was said, in Hebrew and English — and the match happens here, in code,
 * against titles the model has never seen.
 *
 * Matching is substring-based and runs both ways, because people under- and
 * over-specify in equal measure: "אבא" for "להתקשר לאבא", and "הפגישה עם יוסי
 * ביום שלישי" for "פגישה עם יוסי".
 *
 * It returns everything that matched, never a best guess. One match executes,
 * several become a numbered question, none becomes "I could not find it" —
 * and that decision belongs to the caller, not here.
 */
import { normalizeHebrew } from '../time/hebrew-lexicon.js';

/** Final letters fold to their base form, so a suffix cannot break a match. */
const FINAL_FORMS: Readonly<Record<string, string>> = {
  'ך': 'כ', // ך -> כ
  'ם': 'מ', // ם -> מ
  'ן': 'נ', // ן -> נ
  'ף': 'פ', // ף -> פ
  'ץ': 'צ', // ץ -> צ
};

export function matchByText<T>(
  candidates: readonly T[],
  variants: readonly string[],
  textOf: (candidate: T) => string,
): T[] {
  const needles = variants.map(foldForMatch).filter((variant) => variant.length > 0);
  if (needles.length === 0) return [];

  return candidates.filter((candidate) => {
    const haystack = foldForMatch(textOf(candidate));
    if (haystack.length === 0) return false;
    return needles.some((needle) => haystack.includes(needle) || needle.includes(haystack));
  });
}

/**
 * Normalize for comparison: strip nikud, fold final letters, drop punctuation.
 *
 * Nikud goes because nobody types it. Final letters fold because "לאמא" and
 * "אמ" differ only by a letter's position in a word.
 */
export function foldForMatch(value: string): string {
  return normalizeHebrew(value)
    .toLowerCase()
    .replace(/[ךםןףץ]/g, (letter) => FINAL_FORMS[letter] ?? letter)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

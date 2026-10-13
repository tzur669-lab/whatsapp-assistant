/**
 * Event-triggered reminders' words (block J, J4, PLAN §6.30): how a watch's
 * keywords and a notification's text are normalized, and when they match.
 *
 * Kept twice, here and in the app's `WatchMatcher.kt`; both are checked
 * against `test/fixtures/watch-normalize.json`. The server only normalizes
 * (the phone gets the keywords ready to match); the phone matches, and no
 * message text ever leaves it.
 *
 * Normalize: lowercase; niqqud and cantillation dropped; geresh, gershayim and
 * ASCII quotes dropped (צה"ל is one word); Hebrew final letters folded
 * (ך ם ן ף ץ → כ מ נ פ צ); anything not a letter or digit is a space; spaces
 * collapsed. Match: every keyword word appears as a whole word, or as a whole
 * word behind one to four Hebrew prefix letters (ו ה ב כ ל מ ש: "החבילה"
 * matches "חבילה"). All keywords must match (AND).
 */
const MARKS = /[\u0591-\u05C7]/g;
const QUOTES = /[\u05F3\u05F4'"`]/g;
const FINALS: Readonly<Record<string, string>> = { ך: 'כ', ם: 'מ', ן: 'נ', ף: 'פ', ץ: 'צ' };
const NOT_WORD = /[^\p{L}\p{N}]+/gu;
const HEBREW_PREFIX = /^[והבכלמש]{1,4}$/;
const HEBREW = /[\u05D0-\u05EA]/;

export function normalizeWatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(MARKS, '')
    .replace(QUOTES, '')
    .replace(/[ךםןףץ]/g, (letter) => FINALS[letter] ?? letter)
    .replace(NOT_WORD, ' ')
    .trim();
}

function wordMatches(word: string, wanted: string): boolean {
  if (word === wanted) return true;
  if (!HEBREW.test(wanted) || !word.endsWith(wanted)) return false;
  return HEBREW_PREFIX.test(word.slice(0, word.length - wanted.length));
}

/** Every keyword's every word is in the text, by the rules above. Keywords already normalized. */
export function watchMatches(text: string, keywords: readonly string[]): boolean {
  const words = normalizeWatchText(text).split(' ').filter((word) => word.length > 0);
  const wanted = keywords.flatMap((keyword) => keyword.split(' ')).filter((word) => word.length > 0);
  if (wanted.length === 0) return false;
  return wanted.every((target) => words.some((word) => wordMatches(word, target)));
}

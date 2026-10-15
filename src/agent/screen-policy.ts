/**
 * The screen agent's risk policy (PLAN §6.28): which taps and Enters stop and
 * ask before they run. Code decides; the model is never asked.
 *
 * The phone keeps the same lists and rules (`ScreenLogic.kt`). Both sides read
 * `test/fixtures/screen-policy.json` in a test: each fails when its lists stop
 * matching the file, and both run its vectors. When the two disagree at run
 * time, the higher class wins (the phone holds the action and asks).
 *
 * Conservative by default: a word that only looks like "send" stops needlessly
 * (a known limitation), and a button with no name, a generic "continue", an
 * Enter outside a search field and a tap after a form was filled all ask.
 */

export type RiskClass = 'safe' | 'uncertain' | 'sensitive';
export type RiskWhy = 'sensitive' | 'ask_every_tap' | 'unlabelled' | 'generic' | 'submit_not_search' | 'after_form';
export type PolicyAction = 'tap' | 'type' | 'submit' | 'scroll' | 'back' | 'wait';

/** What the policy reads of an element: its label, hint, view id and flags. */
export type PolicyElement = { t?: string | undefined; h?: string | undefined; v?: string | undefined; f: string };

export type PolicyContext = {
  /** The app's "ask before every tap" switch. */
  askEveryTap?: boolean;
  /** An earlier `type` in this task went into a field that is not a search field. */
  typedNonSearch?: boolean;
};

/** Hebrew: anywhere in the normalized label. Latin: the start of a token. */
export const SENSITIVE_WORDS: readonly string[] = [
  'שלח', 'שליחה', 'לשלם', 'תשלום', 'שלם', 'קנה', 'קנייה', 'רכישה', 'לרכוש', 'הזמן', 'הזמנה', 'מחק', 'מחיקה',
  'הסר', 'הסרה', 'העבר', 'העברה', 'אשר', 'בטל מנוי', 'ביטול מנוי', 'תרומה', 'הפקד', 'משוך', 'משיכה', 'חתום',
  'send', 'pay', 'buy', 'purchase', 'order', 'checkout', 'delete', 'remove', 'transfer', 'confirm',
  'unsubscribe', 'subscribe', 'donate', 'withdraw', 'deposit', 'erase',
];

/** A whole token, or (a phrase) the whole normalized label. */
export const GENERIC_WORDS: readonly string[] = [
  'המשך', 'הבא', 'סיום', 'סיים', 'שמור', 'שמירה', 'אישור', 'אוקיי', 'אוקי', 'בטל', 'ביטול', 'כן', 'אני מסכים',
  'continue', 'next', 'done', 'save', 'ok', 'okay', 'submit', 'finish', 'yes', 'apply', 'cancel', 'accept', 'agree', 'allow',
];

/** Matched like the sensitive words, over the hint, the view id and the label. */
export const SEARCH_WORDS: readonly string[] = ['חיפוש', 'חפש', 'search', 'find'];

const RANK: Readonly<Record<RiskClass, number>> = { safe: 0, uncertain: 1, sensitive: 2 };

/** The higher of two classes: the rule whenever server and phone disagree. */
export function higherClass(a: RiskClass, b: RiskClass): RiskClass {
  return RANK[a] >= RANK[b] ? a : b;
}

export function classAtMost(cls: RiskClass, max: RiskClass): boolean {
  return RANK[cls] <= RANK[max];
}

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const NIQQUD = /[\u0591-\u05C7]/g;
const CAMEL = /(\p{Ll})(\p{Lu})/gu;
const NOT_WORD = /[^\p{L}\p{N}]+/gu;
const HEBREW = /[\u0590-\u05FF]/;

/** As the phone does it, character for character (the fixture's vectors pin both). */
export function normalizeLabel(text: string): string {
  return text
    .normalize('NFC')
    .replace(INVISIBLE, '')
    .replace(NIQQUD, '')
    .replace(CAMEL, '$1 $2')
    .replace(NOT_WORD, ' ')
    .trim()
    .toLowerCase();
}

function tokensOf(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/** A sensitive or search word in the text: Hebrew anywhere, Latin at a token's start. */
function hasPrefixWord(text: string | undefined, words: readonly string[]): boolean {
  if (text === undefined) return false;
  const normalized = normalizeLabel(text);
  if (normalized.length === 0) return false;
  const tokens = tokensOf(normalized);
  return words.some((word) =>
    HEBREW.test(word) ? normalized.includes(word) : tokens.some((token) => token.startsWith(word)),
  );
}

/** A sensitive word in a text with no element behind it: a routine draft's check, typed text or named word. */
export function hasSensitiveWord(text: string): boolean {
  return hasPrefixWord(text, SENSITIVE_WORDS);
}

function hasGenericWord(text: string | undefined): boolean {
  if (text === undefined) return false;
  const normalized = normalizeLabel(text);
  if (normalized.length === 0) return false;
  const tokens = tokensOf(normalized);
  return GENERIC_WORDS.some((word) => (word.includes(' ') ? normalized === word : tokens.includes(word)));
}

function present(text: string | undefined): boolean {
  return text !== undefined && normalizeLabel(text).length > 0;
}

export function isSearchField(el: PolicyElement): boolean {
  return hasPrefixWord(el.h, SEARCH_WORDS) || hasPrefixWord(el.v, SEARCH_WORDS) || hasPrefixWord(el.t, SEARCH_WORDS);
}

/**
 * The class of one action on one element, and why. First match wins; the
 * order is the spec's (docs/plans/screen-agent.md, section F).
 */
export function riskClass(
  action: PolicyAction,
  el: PolicyElement | null,
  ctx: PolicyContext,
): { cls: RiskClass; why: RiskWhy | null } {
  if (action === 'scroll' || action === 'back' || action === 'wait') return { cls: 'safe', why: null };
  if (action === 'type') return ctx.askEveryTap ? { cls: 'uncertain', why: 'ask_every_tap' } : { cls: 'safe', why: null };

  const element = el ?? { f: '' };
  if (hasPrefixWord(element.t, SENSITIVE_WORDS) || hasPrefixWord(element.v, SENSITIVE_WORDS)) {
    return { cls: 'sensitive', why: 'sensitive' };
  }
  if (ctx.askEveryTap) return { cls: 'uncertain', why: 'ask_every_tap' };
  if (action === 'tap' && !present(element.t) && !present(element.v)) return { cls: 'uncertain', why: 'unlabelled' };
  if (hasGenericWord(element.t) || hasGenericWord(element.v)) return { cls: 'uncertain', why: 'generic' };
  if (action === 'submit' && !isSearchField(element)) return { cls: 'uncertain', why: 'submit_not_search' };
  if (action === 'tap' && ctx.typedNonSearch && !element.f.includes('e')) return { cls: 'uncertain', why: 'after_form' };
  return { cls: 'safe', why: null };
}

/**
 * A heuristic, not proof (PLAN §6.28): a screen with no clickable element that
 * has a label or a view id cannot be worked with. A thin but usable one still
 * goes to the model, which may say it cannot see.
 */
export function usableScreen(elements: readonly PolicyElement[]): boolean {
  return elements.some((el) => el.f.includes('c') && (present(el.t) || present(el.v)));
}

/**
 * Two filters on text that crosses a trust line (plan invariants 2 and 3).
 *
 *   scrubForModel   text going **to the model**: calendar titles, and later mail
 *                   and phone data. Addresses, numbers, codes and links are
 *                   replaced by a placeholder. The model has no use for them, and
 *                   a model that never saw a number cannot put it anywhere.
 *
 *   defangLinks     text going **to the phone**: a link in a reply is the one
 *                   channel an injected instruction could use to carry data out
 *                   with a single tap. Dots in a host become "[.]", which neither
 *                   the app's Linkify nor WhatsApp turns into a link.
 *
 * Both are deliberately broad. A false positive costs a word in a reply; a false
 * negative is the leak these exist to stop.
 */

/** Any letters in the local part, Hebrew included (T10): `דנה.כהן@example.co.il`. */
const EMAIL = /[\p{L}\p{N}._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const SCHEME_URL = /\bhttps?:\/\/[^\s<>"']+/gi;
const WWW_URL = /\bwww\.[^\s<>"']+/gi;
const BARE_DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/[^\s<>"']*)?/gi;
/** A code is a short number right after a word that names one. */
const CODE = /((?:קוד|סיסמה|סיסמא|code|otp|pin|password)[^\d\n]{0,20})\d{4,8}\b/gi;
/**
 * Spaces, hyphens, dots, slashes and parentheses between the digits (T10:
 * `050.123.4567`, `050/123-4567`, `(050) 123-4567`). Dates and times are
 * masked before it runs (`withDatesMasked`), so `25.9.2026` is never one.
 */
const PHONE = /\+?\(?\d[\d\s./()-]{7,}\d/g;
/** A date (`25.9`, `25/9/2026`) or a time (`14:00`): never a number to scrub. */
const DATE_OR_TIME = /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b|\b\d{1,2}:\d{2}\b/g;
/** Stands for a masked date or time; matched by no pattern here. */
const MASK = '\uE000';
const LONG_DIGITS = /\b\d{5,}\b/g;

const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/** Replace a matched link, keeping punctuation that ended the sentence rather than the link. */
function replaceLink(placeholder: string): (match: string) => string {
  return (match) => {
    const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    return placeholder + tail;
  };
}

/** Run `fn` on `text` with its dates and times masked, then put them back in order. */
function withDatesMasked(text: string, fn: (masked: string) => string): string {
  const kept: string[] = [];
  const masked = text.replace(DATE_OR_TIME, (match) => {
    kept.push(match);
    return MASK;
  });
  let next = 0;
  return fn(masked).replace(//g, () => kept[next++] ?? '');
}

export function scrubForModel(text: string): string {
  return text
    .replace(EMAIL, '[אימייל]')
    .replace(SCHEME_URL, replaceLink('[קישור]'))
    .replace(WWW_URL, replaceLink('[קישור]'))
    .replace(BARE_DOMAIN, replaceLink('[קישור]'))
    .replace(CODE, '$1[קוד]')
    .replace(/[\s\S]*/, (all) =>
      withDatesMasked(all, (masked) => masked.replace(PHONE, '[מספר]').replace(LONG_DIGITS, '[מספר]')),
    );
}

const LINK = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})\b(\/[^\s<>"']*)?/gi;

export function defangLinks(text: string): string {
  return text.replace(LINK, (_match, host: string, path: string | undefined) => {
    return host.replace(/\./g, '[.]') + (path ?? '');
  });
}

/**
 * Whether text holds what the model must never be given (block H, 2026-10-07):
 * an email, a link, a phone number, a code, or six digits in a row. A fact the
 * user asks to keep is refused when it does — the model sees facts verbatim, so
 * the check comes before the save, not after.
 */
export function containsPrivateData(text: string): boolean {
  const patterns = [EMAIL, SCHEME_URL, WWW_URL, BARE_DOMAIN, CODE];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  // A phone number, but not a date or a time (T10).
  let phone = false;
  withDatesMasked(text, (masked) => {
    phone = new RegExp(PHONE.source).test(masked);
    return masked;
  });
  return phone || /\d{6,}/.test(text);
}

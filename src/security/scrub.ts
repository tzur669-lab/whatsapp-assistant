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

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SCHEME_URL = /\bhttps?:\/\/[^\s<>"']+/gi;
const WWW_URL = /\bwww\.[^\s<>"']+/gi;
const BARE_DOMAIN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b(?:\/[^\s<>"']*)?/gi;
/** A code is a short number right after a word that names one. */
const CODE = /((?:קוד|סיסמה|סיסמא|code|otp|pin|password)[^\d\n]{0,20})\d{4,8}\b/gi;
const PHONE = /\+?\d[\d\s-]{7,}\d/g;
const LONG_DIGITS = /\b\d{5,}\b/g;

const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/** Replace a matched link, keeping punctuation that ended the sentence rather than the link. */
function replaceLink(placeholder: string): (match: string) => string {
  return (match) => {
    const tail = TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    return placeholder + tail;
  };
}

export function scrubForModel(text: string): string {
  return text
    .replace(EMAIL, '[אימייל]')
    .replace(SCHEME_URL, replaceLink('[קישור]'))
    .replace(WWW_URL, replaceLink('[קישור]'))
    .replace(BARE_DOMAIN, replaceLink('[קישור]'))
    .replace(CODE, '$1[קוד]')
    .replace(PHONE, '[מספר]')
    .replace(LONG_DIGITS, '[מספר]');
}

const LINK = /\b(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})\b(\/[^\s<>"']*)?/gi;

export function defangLinks(text: string): string {
  return text.replace(LINK, (_match, host: string, path: string | undefined) => {
    return host.replace(/\./g, '[.]') + (path ?? '');
  });
}

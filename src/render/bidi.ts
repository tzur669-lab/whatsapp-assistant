/**
 * Bidi isolation for Hebrew replies (PLAN §6.3).
 *
 * WhatsApp renders plain text, so there is no `dir` attribute to lean on. Any
 * Latin run, slash command, time, or range embedded in a Hebrew sentence must
 * be wrapped in Unicode isolates or the bidi algorithm reorders it — "14:00-15:00"
 * is the classic case, where the range flips to "15:00-14:00" on screen.
 */

/** FIRST STRONG ISOLATE — direction is taken from the first strong character inside. */
export const FSI = '\u2068';
/** POP DIRECTIONAL ISOLATE — closes the innermost isolate. */
export const PDI = '\u2069';
/** LEFT-TO-RIGHT ISOLATE — forces LTR regardless of content. */
export const LRI = '\u2066';

/** Wrap a run so surrounding Hebrew cannot reorder it. Empty input is left alone. */
export function isolate(value: string): string {
  if (value.length === 0) return value;
  return `${FSI}${value}${PDI}`;
}

/** Force an LTR run — for strings that start with a digit or punctuation, like "14:00". */
export function isolateLtr(value: string): string {
  if (value.length === 0) return value;
  return `${LRI}${value}${PDI}`;
}

/** Strip isolate controls, for tests and for length accounting. */
export function stripIsolates(value: string): string {
  return value.replace(/[\u2066-\u2069]/g, '');
}

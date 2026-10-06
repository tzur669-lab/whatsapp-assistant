/**
 * Text shared into the app from another one (ROADMAP #17, 2026-10-06).
 *
 * The user's own words come first, then a code-made header and the shared
 * text, quoted. The whole message is someone else's text for the turn's
 * purposes: the caller marks it forwarded, which taints it (invariant 2).
 * The shared text is not scrubbed — the user's decision, 2026-10-06: a shared
 * invitation is useless without its time and place.
 */
import { he } from '../../render/he.js';

export function composeShared(text: string, shared: string): string {
  return `${text.trim()}\n\n${he.sharedHeader}\n«${shared.trim()}»`;
}

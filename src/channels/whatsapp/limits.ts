/** Reject webhook bodies larger than this before doing any work (PLAN §6.1). */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export { STALE_MESSAGE_MS } from '../limits.js';

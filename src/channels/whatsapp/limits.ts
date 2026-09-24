/** Reject webhook bodies larger than this before doing any work (PLAN §6.1). */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/** Messages older than this require confirmation for any write (PLAN §7.1). */
export const STALE_MESSAGE_MS = 10 * 60 * 1000;

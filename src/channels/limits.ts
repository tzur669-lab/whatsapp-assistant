/**
 * Limits that hold whatever the channel (PLAN §7.1).
 */

/** Messages older than this require confirmation for any write (PLAN §7.1). */
export const STALE_MESSAGE_MS = 10 * 60 * 1000;

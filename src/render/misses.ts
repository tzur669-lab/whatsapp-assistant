/**
 * "לא הבנת" and `/misses`, in words (PLAN §6.23, 2026-10-07).
 *
 * Every reply here is private: it shows the user's own words back, and stays
 * off the lock screen.
 */
import { isolate, isolateLtr } from './bidi.js';
import { formatWhen } from './format-time.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import type { Miss } from '../core/exchanges.js';

/** How much of the captured request the confirmation echoes. */
const ECHO_CHARS = 40;
const REPLY_PREVIEW_CHARS = 120;

const shorten = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}…`;

export const missText = {
  /** The echo shows which exchange was kept: it may not be the one meant. */
  saved: (request: string): string =>
    `שמרתי לבדיקה: ${isolate(shorten(request, ECHO_CHARS))}\nאפשר לנסח את הבקשה שוב.`,

  stillRunning: 'התשובה להודעה הקודמת עוד בדרך. אפשר לשלוח "לא הבנת" אחרי שהיא מגיעה.',

  none: 'אין הודעה אחרונה לשמור. אפשר לנסח את הבקשה שוב.',

  empty: 'אין הודעות שמורות לבדיקה.',

  list(misses: readonly Miss[]): string {
    const lines = misses.map((miss, index) => {
      const when = formatWhen(localPartsOf(miss.at, ZONE), 'he');
      const meta = [miss.outcome, miss.intent ?? '—', miss.groups.join('+') || '—'].join(' · ');
      return [
        `${isolateLtr(String(index + 1))}. ${when}`,
        `   בקשה: ${isolate(miss.user)}`,
        `   תשובה: ${isolate(shorten(miss.reply, REPLY_PREVIEW_CHARS))}`,
        `   ${isolateLtr(meta)}`,
      ].join('\n');
    });
    return ['הודעות שנשמרו לבדיקה, מהחדשה לישנה:', ...lines].join('\n\n');
  },
};

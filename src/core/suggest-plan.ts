/**
 * Which of tomorrow's events get a "time to leave?" suggestion (block L, L3,
 * 2026-10-15). Pure: no I/O, no Cloudflare (invariant 11).
 *
 * A timed event with a place, starting tomorrow (local day, `Asia/Jerusalem`),
 * not suggested yet, and with no leave reminder: one linked by `event_id`, or —
 * for reminders made before the link existed — one whose place overlaps the
 * event's and whose time falls in the three hours before it starts. An
 * overlap is enough to skip: a missed suggestion is better than a duplicate.
 */
import type { CalendarEvent } from '../google/calendar.js';
import { addDays, localPartsOf, wallTimeToUtc, ZONE } from '../time/tz.js';
import { MAX_SUGGESTIONS_PER_DAY } from '../tools/suggestion-store.js';

/** A legacy leave reminder counts for an event this long before its start. */
const LEGACY_WINDOW_MS = 3 * 60 * 60 * 1000;

export type PendingLeave = { eventId: string | null; place: string; dueAtUtc: number };

/** The local day `offset` days from `nowMs`, as a key and as UTC bounds [start, end). */
export function localDay(nowMs: number, offset: number): { key: string; startUtc: number; endUtc: number } {
  const today = localPartsOf(nowMs, ZONE);
  const midnight = (days: number) => {
    const wall = addDays({ year: today.year, month: today.month, day: today.day, hour: 0, minute: 0 }, days);
    // Israel changes its clocks at 02:00, never at midnight: 00:00 always exists once.
    const resolved = wallTimeToUtc(wall, ZONE);
    return { wall, utcMs: resolved.kind === 'ok' ? resolved.utcMs : resolved.kind === 'fold' ? resolved.utcMsCandidates[0] : NaN };
  };
  const start = midnight(offset);
  const end = midnight(offset + 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { key: `${start.wall.year}-${pad(start.wall.month)}-${pad(start.wall.day)}`, startUtc: start.utcMs, endUtc: end.utcMs };
}

const normalize = (place: string) => place.trim().toLowerCase().replace(/\s+/g, ' ');

/** Equal, or one contains the other: "Herzl 5, Tel Aviv" and "Herzl 5". */
export function placesOverlap(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

export function eventsToSuggest(params: {
  events: readonly CalendarEvent[];
  leaves: readonly PendingLeave[];
  already: ReadonlySet<string>;
  day: { startUtc: number; endUtc: number };
  nowMs: number;
}): CalendarEvent[] {
  return params.events
    .filter((event) => !event.allDay && event.location !== undefined && event.location.trim().length > 0)
    .filter((event) => event.startUtc >= params.day.startUtc && event.startUtc < params.day.endUtc && event.startUtc > params.nowMs)
    .filter((event) => !params.already.has(event.id))
    .filter((event) => !params.leaves.some((leave) => leave.eventId === event.id))
    .filter(
      (event) =>
        !params.leaves.some(
          (leave) =>
            leave.eventId === null &&
            leave.dueAtUtc >= event.startUtc - LEGACY_WINDOW_MS &&
            leave.dueAtUtc < event.startUtc &&
            placesOverlap(leave.place, event.location!),
        ),
    )
    .sort((a, b) => a.startUtc - b.startUtc)
    .slice(0, MAX_SUGGESTIONS_PER_DAY);
}

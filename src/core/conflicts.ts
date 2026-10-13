/**
 * Calendar conflicts for the digest (block J, J5): timed events that overlap.
 * Code only; no model sees them. Touching ends (one ends at 10:00, the next
 * starts at 10:00) are not a conflict, and all-day events are ignored. Works
 * on UTC instants, so a DST night (2026-10-25) needs nothing special.
 */
import type { CalendarEvent } from '../google/calendar.js';

export type Conflict = { first: CalendarEvent; second: CalendarEvent };

/** Every overlapping pair, in start order, at most `max`. The same event twice (same id and start) is not a conflict. */
export function findConflicts(events: readonly CalendarEvent[], max = 5): Conflict[] {
  const timed = events
    .filter((event) => !event.allDay && event.endUtc > event.startUtc)
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc);
  const out: Conflict[] = [];
  for (let i = 0; i < timed.length && out.length < max; i++) {
    const first = timed[i]!;
    for (let j = i + 1; j < timed.length && out.length < max; j++) {
      const second = timed[j]!;
      if (second.startUtc >= first.endUtc) break;
      if (second.id === first.id && second.startUtc === first.startUtc) continue;
      out.push({ first, second });
    }
  }
  return out;
}

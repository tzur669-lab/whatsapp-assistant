/**
 * Showing feed events beside Google's (PLAN §6.15).
 *
 * The renderers take `CalendarEvent`, and a subscribed event is a calendar
 * event in every way that matters to a reader — so it is adapted rather than
 * given a display path of its own. Two ways to render an event is two ways for
 * them to drift, and the user is not supposed to be able to tell which calendar
 * a line came from.
 *
 * `etag` is null and `createdByAssistant` false, and both are honest: a feed is
 * read-only, nothing here wrote it, and nothing here can move or delete it.
 */
import type { CalendarEvent } from '../google/calendar.js';
import type { IcalEvent } from './parse.js';

export function asCalendarEvents(events: readonly IcalEvent[]): CalendarEvent[] {
  return events.map((event) => ({
    // Prefixed so an id from a feed can never be mistaken for a Google event id
    // and handed to a write call that would fail confusingly.
    id: `ical:${event.uid}`,
    title: event.title,
    startUtc: event.startUtc,
    endUtc: event.endUtc,
    allDay: event.allDay,
    createdByAssistant: false,
    etag: null,
  }));
}

/**
 * The daily digest (PLAN §6.12).
 *
 * One message, once a day, at an hour the user picks: what is on the calendar
 * from now to the end of the day, what reminders are still coming, and anything
 * that was due and did not get through. Field reports on comparable assistants
 * rate a daily brief as the single most valued feature, and here almost all of
 * it already existed — the calendar read, the reminder list, the renderers.
 *
 * Two rules keep it from decaying into noise, which is the only way a scheduled
 * message fails:
 *
 *   1. **Nothing to say means nothing sent.** No "you have no events today".
 *   2. **From now, not from midnight.** A digest at 14:00 is not a list of the
 *      meetings that already happened.
 *
 * It is also a service message and costs one of the thousand in the monthly
 * budget (§5), so the caller checks the window and the budget before asking for
 * one — the same gate a reminder passes.
 *
 * Plain TypeScript: the Durable Object supplies the clock and the collaborators.
 */
import type { CalendarClient, CalendarEvent } from '../google/calendar.js';
import type { ReminderStore, Reminder } from '../tools/reminder-store.js';
import type { IcalStore } from '../ical/store.js';
import type { BirthdayStore } from './birthdays.js';
import { asCalendarEvents } from '../ical/merge.js';
import type { Logger } from '../security/redact.js';
import type { Lang } from '../render/format-time.js';
import { digestText } from '../render/digest.js';
import { endOfLocalDay } from '../time/range.js';
import { localPartsOf, ZONE } from '../time/tz.js';

const MAX_EVENTS = 10;
const MAX_REMINDERS = 10;

export type DigestContext = {
  nowMs: number;
  principal: string;
  lang: Lang;
  reminders: ReminderStore;
  /** Absent when Google is not connected. The digest is then reminders only. */
  calendar?: CalendarClient;
  /** A subscribed iCal feed, merged in beside Google's events (§6.15). */
  ical?: IcalStore;
  /** The local birthday list (§6.16). */
  birthdays?: BirthdayStore;
  log: Logger;
};

/** The composed message, or null when there is nothing worth a notification. */
export async function buildDigest(ctx: DigestContext): Promise<string | null> {
  const endOfDay = endOfLocalDay(ctx.nowMs, ZONE);

  const upcoming = ctx.reminders.listUpcoming(ctx.principal, MAX_REMINDERS);
  const today = upcoming.filter((reminder) => reminder.dueAtUtc <= endOfDay);
  const overdue = ctx.reminders.listOverdue(ctx.principal, MAX_REMINDERS);
  const birthdays = ctx.birthdays?.on(ctx.principal, ctx.nowMs) ?? [];
  const events = await todaysEvents(ctx, endOfDay);

  if (
    events.length === 0 &&
    today.length === 0 &&
    overdue.length === 0 &&
    birthdays.length === 0
  ) {
    // Silence is the feature. A digest that says "nothing today" every day is
    // a notification the user learns to dismiss, and then so is the real one.
    ctx.log.info('digest_skipped', { reason: 'nothing_to_say' });
    return null;
  }

  ctx.log.info('digest_composed', {
    events: events.length,
    reminders: today.length,
    overdue: overdue.length,
    birthdays: birthdays.length,
  });

  return digestText.compose(
    {
      hour: localPartsOf(ctx.nowMs, ZONE).hour,
      events,
      reminders: today.map(view),
      overdue: overdue.map(view),
      birthdays: birthdays.map((entry) => entry.name),
    },
    ctx.lang,
  );
}

/**
 * From now to the end of the local day.
 *
 * A calendar failure is not worth cancelling the digest over: the reminders are
 * ours and are still worth sending. It is logged by code and reported by
 * nothing, because "your calendar did not load" in a morning brief is a line
 * the user can do nothing about at that hour.
 */
async function todaysEvents(ctx: DigestContext, endOfDay: number): Promise<CalendarEvent[]> {
  // A subscribed feed is a calendar like any other, and is read from the cache
  // rather than over the network — a digest must not wait on someone's server.
  const subscribed = ctx.ical
    ? asCalendarEvents(ctx.ical.eventsBetween(ctx.principal, ctx.nowMs, endOfDay, MAX_EVENTS))
    : [];

  if (!ctx.calendar) return subscribed;

  // Every calendar shown in Google Calendar, not only the main one (2026-10-01).
  const result = await ctx.calendar.listAllEvents({
    startUtc: ctx.nowMs,
    endUtc: endOfDay,
    limit: MAX_EVENTS,
  });

  if (!result.ok) {
    ctx.log.warn('digest_calendar_failed', { errorCode: result.error.code });
    return subscribed;
  }
  return [...result.value, ...subscribed].sort((a, b) => a.startUtc - b.startUtc);
}

function view(reminder: Reminder): { id: string; text: string; local: ReturnType<typeof localPartsOf> } {
  return {
    id: reminder.id,
    text: reminder.text,
    local: localPartsOf(reminder.dueAtUtc, reminder.tz),
  };
}

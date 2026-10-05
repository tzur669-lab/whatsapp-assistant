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
 * Since 2026-10-05 (ROADMAP #6, #8) it also carries:
 *
 *   - **Context lines** — the Hebrew date and the weather at the home city.
 *     They ride along with a digest that is being sent anyway and never make a
 *     quiet day send: the weather alone, every morning, is exactly the noise
 *     rule 1 is about. No candle lighting: the user asked for it out
 *     (2026-10-05) — `reminders.at_rest` covers it for whoever wants it.
 *   - **Google Tasks** due today or earlier, when Tasks is connected.
 *   - **The week ahead, on Sunday** — per day, how many events and reminders,
 *     and whose birthday. Counts, not titles: each day's own digest has those.
 *
 * It is also a service message and costs one of the thousand in the monthly
 * budget (§5), so the caller checks the window and the budget before asking for
 * one — the same gate a reminder passes.
 *
 * Plain TypeScript: the Durable Object supplies the clock and the collaborators.
 */
import type { CalendarClient, CalendarEvent } from '../google/calendar.js';
import type { TasksClient } from '../google/tasks.js';
import type { ReminderStore, Reminder } from '../tools/reminder-store.js';
import type { ReminderView } from '../render/reminders.js';
import type { IcalStore } from '../ical/store.js';
import type { BirthdayStore } from './birthdays.js';
import { asCalendarEvents } from '../ical/merge.js';
import type { Logger } from '../security/redact.js';
import type { Lang } from '../render/format-time.js';
import { digestText } from '../render/digest.js';
import type { DigestContextLines, DigestTask, DigestWeek, DigestWeekDay } from '../render/digest.js';
import { endOfLocalDay } from '../time/range.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { nextOccurrence } from '../time/recur.js';
import type { Place } from '../lookup/place.js';
import { weatherFor } from '../lookup/weather.js';
import { hebrewDate } from '../lookup/jewish.js';

const MAX_EVENTS = 10;
const MAX_REMINDERS = 10;
const MAX_TASKS = 10;
/** Task lists read for the digest; each is one request. */
const MAX_TASK_LISTS = 5;
/** The week's reads. A week that reaches this is shown as "at least". */
const MAX_WEEK_ITEMS = 100;
/** Sunday: the Israeli week starts here, and so does the look-ahead. */
const WEEK_DIGEST_DAY = 0;
/** Monday to Saturday. */
const WEEK_DAYS_AHEAD = 6;

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
  /** Absent when Google Tasks is not connected (#6). */
  tasks?: TasksClient;
  /**
   * The home city, resolved by the caller. Absent when it could not be: then
   * there is no weather, rather than Jerusalem's.
   */
  place?: Place;
  /** For the weather. Absent: no weather line. */
  fetchImpl?: typeof fetch;
  log: Logger;
};

/** The composed message, or null when there is nothing worth a notification. */
export async function buildDigest(ctx: DigestContext): Promise<string | null> {
  const endOfDay = endOfLocalDay(ctx.nowMs, ZONE);

  // Reminders only: a scheduled read (#7) is its own message, and counting it
  // would make every day worth a digest.
  const upcoming = ctx.reminders.listUpcoming(ctx.principal, MAX_REMINDERS, { plainOnly: true });
  const today = upcoming.filter((reminder) => reminder.dueAtUtc <= endOfDay);
  const overdue = ctx.reminders.listOverdue(ctx.principal, MAX_REMINDERS, { plainOnly: true });
  const birthdays = ctx.birthdays?.on(ctx.principal, ctx.nowMs) ?? [];
  const events = await todaysEvents(ctx, endOfDay);
  const tasks = await dueTasks(ctx);
  const week =
    localPartsOf(ctx.nowMs, ZONE).weekday === WEEK_DIGEST_DAY ? await weekAhead(ctx, endOfDay) : null;

  if (
    events.length === 0 &&
    today.length === 0 &&
    overdue.length === 0 &&
    birthdays.length === 0 &&
    tasks.length === 0 &&
    (week === null || week.days.length === 0)
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
    tasks: tasks.length,
    weekDays: week?.days.length ?? -1,
  });

  return digestText.compose(
    {
      hour: localPartsOf(ctx.nowMs, ZONE).hour,
      context: await contextLines(ctx),
      events,
      reminders: today.map(view),
      overdue: overdue.map(view),
      birthdays: birthdays.map((entry) => entry.name),
      tasks,
      week,
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

/**
 * The lines that set the scene. Only ever shown inside a digest that has
 * something else to say; each is left out when it cannot be had.
 */
async function contextLines(ctx: DigestContext): Promise<DigestContextLines> {
  const local = localPartsOf(ctx.nowMs, ZONE);
  const lines: DigestContextLines = {};

  const hebrew = hebrewDate(local);
  if (hebrew) lines.hebrewDate = hebrew;

  if (ctx.place && ctx.fetchImpl) {
    let weather: string | null = null;
    try {
      weather = await weatherFor(ctx.fetchImpl, ctx.place, local, true, ctx.lang);
    } catch {
      weather = null;
    }
    if (weather) lines.weather = weather;
    else ctx.log.warn('digest_weather_failed', {});
  }
  return lines;
}

/**
 * Open Google Tasks due today or before. A task's due date is a date, sent as
 * midnight UTC, so it is compared as a date string — read through a zone it
 * would move.
 */
async function dueTasks(ctx: DigestContext): Promise<DigestTask[]> {
  if (!ctx.tasks) return [];
  const local = localPartsOf(ctx.nowMs, ZONE);
  const today = `${local.year}-${pad(local.month)}-${pad(local.day)}`;

  const lists = await ctx.tasks.lists();
  if (!lists.ok) {
    ctx.log.warn('digest_tasks_failed', { errorCode: lists.error.code });
    return [];
  }

  const found: DigestTask[] = [];
  for (const list of lists.value.slice(0, MAX_TASK_LISTS)) {
    const open = await ctx.tasks.openTasks(list.id);
    if (!open.ok) {
      ctx.log.warn('digest_tasks_failed', { errorCode: open.error.code });
      continue;
    }
    for (const task of open.value) {
      const due = task.due?.slice(0, 10);
      if (!due || due > today) continue;
      found.push({ title: task.title, overdue: due < today, due });
    }
  }
  return found.sort((a, b) => a.due.localeCompare(b.due)).slice(0, MAX_TASKS);
}

/**
 * The rest of the week, Monday to Saturday, as counts per day (#8).
 *
 * Events are counted only when every calendar answered: a failed read shows no
 * number at all, never a "0" that is not true. A recurring reminder has one
 * stored occurrence, so its rule is walked across the week to count the rest.
 */
async function weekAhead(ctx: DigestContext, endOfToday: number): Promise<DigestWeek> {
  const bounds: { start: number; end: number }[] = [];
  let start = endOfToday + 1;
  for (let i = 0; i < WEEK_DAYS_AHEAD; i++) {
    const end = endOfLocalDay(start, ZONE);
    bounds.push({ start, end });
    start = end + 1;
  }
  const weekStart = bounds[0]!.start;
  const weekEnd = bounds[bounds.length - 1]!.end;

  let partial = false;
  let eventsKnown = true;
  const eventStarts: number[] = [];

  const subscribed = ctx.ical?.eventsBetween(ctx.principal, weekStart, weekEnd, MAX_WEEK_ITEMS) ?? [];
  if (subscribed.length >= MAX_WEEK_ITEMS) partial = true;
  eventStarts.push(...asCalendarEvents(subscribed).map((event) => event.startUtc));

  if (ctx.calendar) {
    const result = await ctx.calendar.listAllEvents({ startUtc: weekStart, endUtc: weekEnd, limit: MAX_WEEK_ITEMS });
    if (result.ok) {
      if (result.value.length >= MAX_WEEK_ITEMS) partial = true;
      eventStarts.push(...result.value.map((event) => event.startUtc));
    } else {
      ctx.log.warn('digest_week_calendar_failed', { errorCode: result.error.code });
      eventsKnown = false;
    }
  }

  const reminderTimes: number[] = [];
  const upcoming = ctx.reminders.listUpcoming(ctx.principal, MAX_WEEK_ITEMS, { plainOnly: true });
  if (upcoming.length >= MAX_WEEK_ITEMS) partial = true;
  for (const reminder of upcoming) {
    if (reminder.dueAtUtc > weekEnd) continue;
    if (reminder.dueAtUtc >= weekStart) reminderTimes.push(reminder.dueAtUtc);
    if (!reminder.rule) continue;
    // The stored occurrence is counted above; the rest are walked from it.
    let at = reminder.dueAtUtc;
    for (let i = 0; i < WEEK_DAYS_AHEAD + 1; i++) {
      const next = nextOccurrence(reminder.rule, at, reminder.tz);
      if (next === null || next > weekEnd) break;
      if (next >= weekStart) reminderTimes.push(next);
      at = next;
    }
  }

  const days: DigestWeekDay[] = [];
  for (const day of bounds) {
    const within = (t: number) => t >= day.start && t <= day.end;
    const events = eventsKnown ? eventStarts.filter(within).length : null;
    const reminders = reminderTimes.filter(within).length;
    const birthdays = (ctx.birthdays?.on(ctx.principal, day.start) ?? []).map((entry) => entry.name);
    if ((events ?? 0) === 0 && reminders === 0 && birthdays.length === 0) continue;
    days.push({ local: localPartsOf(day.start, ZONE), events, reminders, birthdays });
  }
  return { days, partial };
}

function view(reminder: Reminder): ReminderView {
  return {
    id: reminder.id,
    text: reminder.text,
    local: localPartsOf(reminder.dueAtUtc, reminder.tz),
    ...(reminder.rule ? { rule: reminder.rule } : {}),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

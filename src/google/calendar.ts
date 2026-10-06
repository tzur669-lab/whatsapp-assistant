/**
 * The Google Calendar client (PLAN §6.6).
 *
 * Two responsibilities, and the second is the reason this is a class rather
 * than a few functions: it holds the access token in memory for the life of one
 * Durable Object, refreshes it when it expires, and retries exactly once on a
 * 401 — because a token can be revoked between the check and the call.
 *
 * `invalid_grant` is the one error treated as terminal. It means the user
 * revoked access or the consent lapsed, so there is nothing to retry and the
 * integration is marked disconnected instead of being hammered.
 *
 * Nothing that comes back from here ever reaches the LLM. Event titles, ids and
 * attendees are rendered by code and matched by code (CLAUDE.md invariants 2
 * and 5).
 */
import { GoogleApi } from './api.js';
import type { GoogleFailure } from './api.js';
import type { GoogleStore } from './store.js';
import type { Logger } from '../security/redact.js';
import { ZONE } from '../time/tz.js';

const API_BASE = 'https://www.googleapis.com/calendar/v3';

/** The calendar reminder fallbacks are written to (PLAN §6.7). */
export const REMINDERS_CALENDAR_NAME = 'Assistant Reminders';

export const PRIMARY_CALENDAR = 'primary';

const READ_ALL_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/** Enough for a family, a team and a few subscriptions; each is one more call. */
const MAX_OTHER_CALENDARS = 8;

const eventKey = (event: CalendarEvent) => `${event.startUtc}|${event.title}`;

export type CalendarEvent = {
  id: string;
  title: string;
  /** The calendar it is on, when that is not the main one (2026-10-01). */
  calendarName?: string;
  startUtc: number;
  endUtc: number;
  /** True for a date-only event, which has no meaningful time of day. */
  allDay: boolean;
  /** Set on events this assistant created (PLAN §6.6, event tagging). */
  createdByAssistant: boolean;
  etag: string | null;
  /**
   * Where it is, as the event says (2026-10-06): only for navigating there
   * (`nav.go`), never rendered in a list. Someone else's words for an invitation.
   */
  location?: string;
};

/** `changed`: the event changed since it was previewed. `not_found`: deleted elsewhere. */
export type CalendarFailure = GoogleFailure;

/** What this assistant writes when it creates an event (PLAN §6.6). */
export type EventDraft = {
  title: string;
  startUtc: number;
  endUtc: number;
  calendarId?: string;
  /** Names only. Turning them into addresses is not this layer's business. */
  attendees?: string[];
  /** Ties the event back to the request that made it, for the audit log. */
  intentId?: string;
  /**
   * Fire a popup at the start instead of the calendar's default reminder. This
   * is what makes a backup event actually notify the user (PLAN §6.7).
   */
  popupAtStart?: boolean;
};

export type CalendarResult<T> = { ok: true; value: T } | { ok: false; error: CalendarFailure };

export type CalendarConfig = {
  store: GoogleStore;
  clientId: string;
  clientSecret: string;
  log: Logger;
  now(): number;
  fetchImpl?: typeof fetch;
};

export class CalendarClient {
  private readonly api: GoogleApi;

  constructor(private readonly config: CalendarConfig) {
    this.api = new GoogleApi({ ...config, label: 'calendar' });
  }

  /** Events overlapping a window, in time order. */
  async listEvents(params: {
    startUtc: number;
    endUtc: number;
    calendarId?: string;
    limit?: number;
  }): Promise<CalendarResult<CalendarEvent[]>> {
    const query = new URLSearchParams({
      timeMin: new Date(params.startUtc).toISOString(),
      timeMax: new Date(params.endUtc).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(params.limit ?? 20),
    });

    const result = await this.call(
      `/calendars/${encodeURIComponent(params.calendarId ?? PRIMARY_CALENDAR)}/events?${query}`,
      { method: 'GET' },
    );
    if (!result.ok) return result;

    const items = (result.value as { items?: unknown }).items;
    if (!Array.isArray(items)) return { ok: false, error: { code: 'invalid_response' } };

    return { ok: true, value: items.map(toEvent).filter((event): event is CalendarEvent => event !== null) };
  }

  /**
   * Events from every calendar shown in Google Calendar, merged in time order
   * (2026-10-01): the main one, then each other visible calendar, named. Needs
   * `calendar.readonly`; until the grant has it, the main calendar alone. One
   * failing calendar is left out rather than failing the whole read — unless
   * `strict`, where a missing calendar would make busy time look free
   * (`calendar.free_time`, 2026-10-05): then any failure fails the read.
   */
  async listAllEvents(params: {
    startUtc: number;
    endUtc: number;
    limit?: number;
    strict?: boolean;
  }): Promise<CalendarResult<CalendarEvent[]>> {
    const { strict, ...range } = params;
    const primary = await this.listEvents(range);
    if (!primary.ok) return primary;
    if (!(this.config.store.get()?.scopes ?? []).includes(READ_ALL_SCOPE)) return primary;

    const list = await this.call('/users/me/calendarList?minAccessRole=reader&maxResults=50', { method: 'GET' });
    if (!list.ok) return strict ? list : primary;
    const items = (list.value as { items?: unknown }).items;
    if (!Array.isArray(items)) return strict ? { ok: false, error: { code: 'invalid_response' } } : primary;

    const others = items
      .map((item) => item as Record<string, unknown>)
      .filter((item) => typeof item['id'] === 'string' && item['primary'] !== true && item['selected'] !== false && item['deleted'] !== true)
      .slice(0, MAX_OTHER_CALENDARS);

    const merged = [...primary.value];
    const seen = new Set(merged.map(eventKey));
    for (const item of others) {
      const name = String(item['summaryOverride'] ?? item['summary'] ?? '').slice(0, 60) || undefined;
      const result = await this.listEvents({ ...range, calendarId: String(item['id']) });
      if (!result.ok) {
        if (strict) return result;
        continue;
      }
      for (const event of result.value) {
        // An invitation shows on both calendars; list it once.
        if (seen.has(eventKey(event))) continue;
        seen.add(eventKey(event));
        merged.push(name ? { ...event, calendarName: name } : event);
      }
    }
    merged.sort((a, b) => a.startUtc - b.startUtc);
    return { ok: true, value: merged.slice(0, params.limit ?? 20) };
  }

  /**
   * The app-created calendar reminder fallbacks go to, created on first use.
   *
   * Its id is cached in the integration row: creating it twice would leave the
   * user with two calendars of the same name and reminders split between them.
   */
  async remindersCalendarId(): Promise<CalendarResult<string>> {
    const existing = this.config.store.get()?.remindersCalendarId;
    if (existing) return { ok: true, value: existing };

    const created = await this.call('/calendars', {
      method: 'POST',
      body: JSON.stringify({ summary: REMINDERS_CALENDAR_NAME, timeZone: 'Asia/Jerusalem' }),
    });
    if (!created.ok) return created;

    const id = (created.value as { id?: unknown }).id;
    if (typeof id !== 'string' || !id) return { ok: false, error: { code: 'invalid_response' } };

    this.config.store.setRemindersCalendarId(id);
    return { ok: true, value: id };
  }

  /**
   * Create an event, tagged as ours.
   *
   * `sendUpdates` is `none` unless there are attendees *and* the action was
   * confirmed at Tier 3. An invitation is an outward-facing act: deleting the
   * event afterwards does not unsend it, which is why it is the one thing here
   * that cannot be fixed by an Undo (PLAN §6.4).
   */
  async createEvent(
    draft: EventDraft,
    notifyAttendees = false,
  ): Promise<CalendarResult<CalendarEvent>> {
    const calendarId = draft.calendarId ?? PRIMARY_CALENDAR;
    const query = new URLSearchParams({ sendUpdates: notifyAttendees ? 'all' : 'none' });

    const result = await this.call(`/calendars/${encodeURIComponent(calendarId)}/events?${query}`, {
      method: 'POST',
      body: JSON.stringify(toGoogleEvent(draft)),
    });
    if (!result.ok) return result;

    const event = toEvent(result.value);
    return event ? { ok: true, value: event } : { ok: false, error: { code: 'invalid_response' } };
  }

  /**
   * Move an event, refusing if it changed since it was previewed.
   *
   * The etag goes out as `If-Match`. Without it, a confirmation tapped five
   * minutes late would overwrite whatever happened in between — which is the
   * exact case a confirmation exists to make safe (PLAN §6.5 step 4).
   */
  async moveEvent(params: {
    eventId: string;
    startUtc: number;
    endUtc: number;
    etag: string | null;
    calendarId?: string;
  }): Promise<CalendarResult<CalendarEvent>> {
    const calendarId = params.calendarId ?? PRIMARY_CALENDAR;

    const result = await this.call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}?sendUpdates=none`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          start: { dateTime: new Date(params.startUtc).toISOString(), timeZone: ZONE },
          end: { dateTime: new Date(params.endUtc).toISOString(), timeZone: ZONE },
        }),
        ...(params.etag ? { headers: { 'if-match': params.etag } } : {}),
      },
    );
    if (!result.ok) return result;

    const event = toEvent(result.value);
    return event ? { ok: true, value: event } : { ok: false, error: { code: 'invalid_response' } };
  }

  async deleteEvent(params: {
    eventId: string;
    etag?: string | null;
    calendarId?: string;
  }): Promise<CalendarResult<true>> {
    const calendarId = params.calendarId ?? PRIMARY_CALENDAR;

    const result = await this.call(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(params.eventId)}?sendUpdates=none`,
      { method: 'DELETE', ...(params.etag ? { headers: { 'if-match': params.etag } } : {}) },
    );

    // A delete that finds nothing has reached the state the user asked for.
    if (!result.ok && result.error.code === 'not_found') return { ok: true, value: true };
    return result.ok ? { ok: true, value: true } : result;
  }

  // -- transport --------------------------------------------------------------

  /** One API call, through the grant's shared client (`api.ts`). */
  private call(path: string, init: RequestInit): Promise<CalendarResult<unknown>> {
    return this.api.call(`${API_BASE}${path}`, init);
  }
}

// -- parsing ------------------------------------------------------------------

function toEvent(raw: unknown): CalendarEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;

  const id = typeof record.id === 'string' ? record.id : '';
  if (!id) return null;
  // A cancelled instance of a recurring event still comes back in the list.
  if (record.status === 'cancelled') return null;

  const start = timeOf(record.start);
  const end = timeOf(record.end);
  if (start === null) return null;

  const privateProps = (record.extendedProperties as { private?: Record<string, unknown> } | undefined)
    ?.private;

  return {
    id,
    // Google allows an untitled event; so does its own UI, which shows a dash.
    title: typeof record.summary === 'string' && record.summary.length > 0 ? record.summary : '—',
    startUtc: start.utcMs,
    endUtc: end?.utcMs ?? start.utcMs,
    allDay: start.allDay,
    createdByAssistant: privateProps?.['assistant'] === '1',
    etag: typeof record.etag === 'string' ? record.etag : null,
    ...(locationOf(record.location) ? { location: locationOf(record.location)! } : {}),
  };
}

/** The longest place a navigation card carries (`MAX_DESTINATION_CHARS`). */
const MAX_LOCATION_CHARS = 100;

function locationOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // One line, no control characters: it is shown on a card and searched for in Waze.
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, MAX_LOCATION_CHARS) : null;
}

function timeOf(value: unknown): { utcMs: number; allDay: boolean } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;

  if (typeof record.dateTime === 'string') {
    const parsed = Date.parse(record.dateTime);
    return Number.isFinite(parsed) ? { utcMs: parsed, allDay: false } : null;
  }
  if (typeof record.date === 'string') {
    // A date-only event has no time of day; midnight UTC is a placeholder the
    // renderer must not print as 00:00, which is why `allDay` travels with it.
    const parsed = Date.parse(`${record.date}T00:00:00Z`);
    return Number.isFinite(parsed) ? { utcMs: parsed, allDay: true } : null;
  }
  return null;
}

const ATTENDEES_LABEL = 'משתתפים:';

function toGoogleEvent(draft: EventDraft): Record<string, unknown> {
  return {
    summary: draft.title,
    start: { dateTime: new Date(draft.startUtc).toISOString(), timeZone: ZONE },
    end: { dateTime: new Date(draft.endUtc).toISOString(), timeZone: ZONE },
    // Names only, never `attendees`: Google requires an email for each one and
    // answers 400 without it, and a name is all a message gives us. Nobody is
    // invited either way (`sendUpdates=none`), so the names go in the notes.
    ...(draft.attendees?.length ? { description: `${ATTENDEES_LABEL} ${draft.attendees.join(', ')}` } : {}),
    ...(draft.popupAtStart
      ? { reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 0 }] } }
      : {}),
    // Everything this assistant creates is tagged, so later it can tell its own
    // work from the user's (PLAN §6.6, event tagging).
    extendedProperties: {
      private: { assistant: '1', ...(draft.intentId ? { intent_id: draft.intentId } : {}) },
    },
  };
}

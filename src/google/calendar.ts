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
import { refreshAccessToken } from './oauth.js';
import type { GoogleStore } from './store.js';
import type { Logger } from '../security/redact.js';
import { ZONE } from '../time/tz.js';

const API_BASE = 'https://www.googleapis.com/calendar/v3';
const TIMEOUT_MS = 10_000;

/** Refresh this far before expiry, so a call never races the deadline. */
const REFRESH_MARGIN_MS = 60_000;

/** The calendar reminder fallbacks are written to (PLAN §6.7). */
export const REMINDERS_CALENDAR_NAME = 'Assistant Reminders';

export const PRIMARY_CALENDAR = 'primary';

export type CalendarEvent = {
  id: string;
  title: string;
  startUtc: number;
  endUtc: number;
  /** True for a date-only event, which has no meaningful time of day. */
  allDay: boolean;
  /** Set on events this assistant created (PLAN §6.6, event tagging). */
  createdByAssistant: boolean;
  etag: string | null;
};

export type CalendarFailure =
  | { code: 'not_connected' }
  | { code: 'disconnected' }
  /** The event changed between being previewed and being written (etag mismatch). */
  | { code: 'changed' }
  /** Already gone — deleted in the Google UI, or on another device. */
  | { code: 'not_found' }
  | { code: 'provider_error'; status: number }
  | { code: 'network_error' }
  | { code: 'invalid_response' };

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
  private accessToken: string | null = null;
  private expiresAt = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: CalendarConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
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

  /**
   * One API call, with a single 401 retry.
   *
   * The retry is not defensive padding: a cached access token can be revoked
   * between the expiry check and the request, and that is indistinguishable
   * from a valid token until the 401 comes back.
   */
  private async call(path: string, init: RequestInit): Promise<CalendarResult<unknown>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(attempt > 0);
      if (!token.ok) return token;

      let response: Response;
      try {
        response = await this.fetchImpl(`${API_BASE}${path}`, {
          ...init,
          headers: {
            authorization: `Bearer ${token.value}`,
            'content-type': 'application/json',
            ...(init.headers as Record<string, string> | undefined),
          },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return { ok: false, error: { code: 'network_error' } };
      }

      if (response.status === 401 && attempt === 0) {
        this.accessToken = null;
        continue;
      }

      if (!response.ok) {
        // The body can carry event titles, so it is never read or logged.
        this.config.log.warn('calendar_call_failed', { status: response.status });

        // 412 is the `If-Match` failing: the event changed since it was read.
        if (response.status === 412) return { ok: false, error: { code: 'changed' } };
        if (response.status === 404 || response.status === 410) {
          return { ok: false, error: { code: 'not_found' } };
        }
        return { ok: false, error: { code: 'provider_error', status: response.status } };
      }

      // A DELETE answers 204 with no body. That is a success, not a parse failure.
      if (response.status === 204) return { ok: true, value: {} };

      try {
        return { ok: true, value: await response.json() };
      } catch {
        return { ok: false, error: { code: 'invalid_response' } };
      }
    }

    return { ok: false, error: { code: 'provider_error', status: 401 } };
  }

  private async token(force: boolean): Promise<CalendarResult<string>> {
    if (!force && this.accessToken && this.config.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return { ok: true, value: this.accessToken };
    }

    const refreshToken = await this.config.store.refreshToken();
    if (!refreshToken) return { ok: false, error: { code: 'not_connected' } };

    const result = await refreshAccessToken(
      {
        refreshToken,
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
      },
      this.fetchImpl,
    );

    if (!result.ok) {
      if (result.error.code === 'invalid_grant') {
        // Revoked or lapsed. Nothing to retry; the user has to reconnect.
        this.config.store.disconnect('E_GOOGLE_INVALID_GRANT');
        this.config.log.warn('google_disconnected', { errorCode: 'invalid_grant' });
        return { ok: false, error: { code: 'disconnected' } };
      }
      this.config.log.warn('google_refresh_failed', { errorCode: result.error.code });
      return {
        ok: false,
        error:
          result.error.code === 'network_error'
            ? { code: 'network_error' }
            : { code: 'provider_error', status: 'status' in result.error ? result.error.status : 0 },
      };
    }

    this.accessToken = result.grant.accessToken;
    this.expiresAt = this.config.now() + result.grant.expiresInSeconds * 1000;
    return { ok: true, value: this.accessToken };
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
  };
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

function toGoogleEvent(draft: EventDraft): Record<string, unknown> {
  return {
    summary: draft.title,
    start: { dateTime: new Date(draft.startUtc).toISOString(), timeZone: ZONE },
    end: { dateTime: new Date(draft.endUtc).toISOString(), timeZone: ZONE },
    ...(draft.attendees?.length
      ? { attendees: draft.attendees.map((displayName) => ({ displayName })) }
      : {}),
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

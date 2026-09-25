/**
 * Keeping a subscribed feed current (PLAN §6.15).
 *
 * Fetch, parse into the horizon, replace. Three outcomes, and the one that
 * matters most is the failure: the cached events are left exactly as they were,
 * because yesterday's timetable is a better answer than no timetable and a feed
 * that is briefly unreachable should not empty the calendar.
 *
 * Plain TypeScript — the platform supplies `fetch` and the clock.
 */
import { addDays, localPartsOf, wallTimeToUtc, ZONE } from '../time/tz.js';
import type { Logger } from '../security/redact.js';
import { fetchFeed } from './fetch.js';
import { parseIcal } from './parse.js';
import { HORIZON_DAYS } from './store.js';
import type { Feed, IcalStore } from './store.js';

export type RefreshOutcome = {
  status: 'ok' | 'unchanged' | 'failed';
  events: number;
  errorCode?: string;
};

export async function refreshFeed(params: {
  store: IcalStore;
  feed: Feed;
  nowMs: number;
  log: Logger;
  fetchImpl?: typeof fetch;
  zone?: string;
}): Promise<RefreshOutcome> {
  const { store, feed, nowMs, log } = params;
  const zone = params.zone ?? ZONE;

  const result = await fetchFeed({
    url: feed.url,
    etag: feed.etag,
    ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
  });

  if (result.status === 'unchanged') {
    store.markUnchanged(feed.id);
    log.info('ical_unchanged', { feedId: feed.id });
    return { status: 'unchanged', events: feed.eventCount };
  }

  if (result.status === 'failed') {
    // The URL is never logged: a private feed's token lives in its query string.
    store.markFailed(feed.id, result.errorCode);
    log.warn('ical_fetch_failed', { feedId: feed.id, errorCode: result.errorCode });
    return { status: 'failed', events: feed.eventCount, errorCode: result.errorCode };
  }

  const window = { startUtc: startOfDay(nowMs, zone), endUtc: horizonEnd(nowMs, zone) };
  const parsed = parseIcal(result.text, window, zone);

  store.replaceEvents(feed.id, parsed.events, result.etag);
  log.info('ical_refreshed', {
    feedId: feed.id,
    events: parsed.events.length,
    skipped: parsed.skipped,
    truncated: parsed.truncated,
  });

  return { status: 'ok', events: parsed.events.length };
}

/**
 * Refresh only if it has gone stale. Used before a read, so a calendar asked
 * about at nine in the morning is not answered from a file fetched at midnight
 * two days ago — without fetching it on every single question either.
 */
export async function ensureFresh(params: {
  store: IcalStore;
  principal: string;
  nowMs: number;
  log: Logger;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  const feed = params.store.feedFor(params.principal);
  if (!feed || !params.store.isStale(feed)) return;
  await refreshFeed({ ...params, feed });
}

function startOfDay(nowMs: number, zone: string): number {
  const local = localPartsOf(nowMs, zone);
  return toUtc({ ...local, hour: 0, minute: 0 }, zone);
}

function horizonEnd(nowMs: number, zone: string): number {
  const local = localPartsOf(nowMs, zone);
  return toUtc(addDays({ ...local, hour: 0, minute: 0 }, HORIZON_DAYS), zone);
}

function toUtc(wall: { year: number; month: number; day: number; hour: number; minute: number }, zone: string): number {
  const resolved = wallTimeToUtc({ ...wall, hour: 0, minute: 0 }, zone);
  if (resolved.kind === 'ok') return resolved.utcMs;
  if (resolved.kind === 'fold') return Math.min(...resolved.utcMsCandidates);
  return Date.UTC(wall.year, wall.month - 1, wall.day);
}

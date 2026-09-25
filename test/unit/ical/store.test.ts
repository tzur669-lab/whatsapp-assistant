/**
 * Subscribed feeds and their cached events (PLAN §6.15, §11.3).
 *
 * The cache exists so a calendar read does not wait on someone else's server.
 * The property that matters most is what happens when a refresh fails: the
 * cached events must survive it, because yesterday's timetable is a better
 * answer than an empty calendar.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { IcalStore, STALE_AFTER_MS } from '../../../src/ical/store.js';
import { refreshFeed } from '../../../src/ical/refresh.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import type { IcalEvent } from '../../../src/ical/parse.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const NOW = Date.parse('2026-09-25T06:00:00Z');
const SENDER = 'p_sender000000';
const OTHER = 'p_other0000000';
const URL_A = 'https://calendar.example.test/a.ics';

const event = (startIso: string, title: string): IcalEvent => ({
  uid: `u-${startIso}`,
  title,
  startUtc: Date.parse(startIso),
  endUtc: Date.parse(startIso) + 3_600_000,
  allDay: false,
});

describe('IcalStore', () => {
  let driver: TestSqlDriver;
  let store: IcalStore;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    store = new IcalStore(driver, () => now);
  });
  afterEach(() => driver.close());

  it('subscribes and reports back', () => {
    store.subscribe(SENDER, URL_A);
    expect(store.feedFor(SENDER)?.url).toBe(URL_A);
  });

  it('keeps one feed per sender, replacing the old one', () => {
    // A second would need naming, removing one of them, and saying which feed
    // an event came from — none of which is worth building before one is used.
    store.subscribe(SENDER, URL_A);
    store.subscribe(SENDER, 'https://calendar.example.test/b.ics');

    expect(store.feedFor(SENDER)?.url).toBe('https://calendar.example.test/b.ics');
    expect(driver.exec('SELECT COUNT(*) AS n FROM ical_feeds')[0]?.['n']).toBe(1);
  });

  it('shows one sender nothing of another\'s', () => {
    store.subscribe(OTHER, URL_A);
    expect(store.feedFor(SENDER)).toBeNull();
    expect(store.eventsBetween(SENDER, 0, Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  it('stores events and reads back the ones overlapping a window', () => {
    const feed = store.subscribe(SENDER, URL_A);
    store.replaceEvents(
      feed.id,
      [event('2026-09-25T08:00:00Z', 'Lecture'), event('2026-09-27T08:00:00Z', 'Later')],
      null,
    );

    const today = store.eventsBetween(
      SENDER,
      Date.parse('2026-09-25T00:00:00Z'),
      Date.parse('2026-09-26T00:00:00Z'),
    );
    expect(today.map((e) => e.title)).toEqual(['Lecture']);
  });

  it('replaces wholesale, so an event deleted from the feed disappears here', () => {
    // A merge would leave it behind forever, and a meeting that was cancelled
    // is exactly the thing a stale cache must not keep showing.
    const feed = store.subscribe(SENDER, URL_A);
    store.replaceEvents(feed.id, [event('2026-09-25T08:00:00Z', 'Cancelled later')], null);
    store.replaceEvents(feed.id, [event('2026-09-25T10:00:00Z', 'Still there')], null);

    const all = store.eventsBetween(SENDER, 0, Number.MAX_SAFE_INTEGER);
    expect(all.map((e) => e.title)).toEqual(['Still there']);
  });

  it('unsubscribing takes the events with it', () => {
    const feed = store.subscribe(SENDER, URL_A);
    store.replaceEvents(feed.id, [event('2026-09-25T08:00:00Z', 'X')], null);

    expect(store.unsubscribe(SENDER)).toBe(true);
    expect(store.feedFor(SENDER)).toBeNull();
    expect(driver.exec('SELECT COUNT(*) AS n FROM ical_events')[0]?.['n']).toBe(0);
  });

  it('goes stale, so a read refreshes it before answering', () => {
    const feed = store.subscribe(SENDER, URL_A);
    expect(store.isStale(feed)).toBe(true);

    store.replaceEvents(feed.id, [], null);
    expect(store.isStale(store.feedFor(SENDER)!)).toBe(false);

    now = NOW + STALE_AFTER_MS + 1;
    expect(store.isStale(store.feedFor(SENDER)!)).toBe(true);
  });
});

describe('refreshing', () => {
  let driver: TestSqlDriver;
  let store: IcalStore;
  let log: ReturnType<typeof createFakeLogger>;

  const feedBody = (summary: string) =>
    [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'UID:x@test',
      `SUMMARY:${summary}`,
      'DTSTART:20260925T080000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

  const serving = (response: Response): typeof fetch =>
    (async () => response) as unknown as typeof fetch;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    store = new IcalStore(driver, () => NOW);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('parses and stores what it fetched', async () => {
    const feed = store.subscribe(SENDER, URL_A);
    const result = await refreshFeed({
      store,
      feed,
      nowMs: NOW,
      log,
      fetchImpl: serving(new Response(feedBody('Lecture'), { status: 200, headers: { etag: '"v1"' } })),
    });

    expect(result.status).toBe('ok');
    expect(result.events).toBe(1);
    expect(store.feedFor(SENDER)?.etag).toBe('"v1"');
  });

  it('keeps the cached events when the fetch fails', async () => {
    // Yesterday's timetable is a better answer than no timetable, and a feed
    // that is briefly unreachable must not empty the calendar.
    const feed = store.subscribe(SENDER, URL_A);
    await refreshFeed({
      store,
      feed,
      nowMs: NOW,
      log,
      fetchImpl: serving(new Response(feedBody('Lecture'), { status: 200 })),
    });

    const stored = store.feedFor(SENDER)!;
    const result = await refreshFeed({
      store,
      feed: stored,
      nowMs: NOW,
      log,
      fetchImpl: serving(new Response('down', { status: 503 })),
    });

    expect(result.status).toBe('failed');
    expect(store.eventsBetween(SENDER, 0, Number.MAX_SAFE_INTEGER)).toHaveLength(1);
    expect(store.feedFor(SENDER)?.lastError).toBe('E_ICAL_HTTP_503');
  });

  it('clears a previous error once a refresh works again', async () => {
    const feed = store.subscribe(SENDER, URL_A);
    store.markFailed(feed.id, 'E_ICAL_NETWORK');

    await refreshFeed({
      store,
      feed: store.feedFor(SENDER)!,
      nowMs: NOW,
      log,
      fetchImpl: serving(new Response(feedBody('Lecture'), { status: 200 })),
    });

    expect(store.feedFor(SENDER)?.lastError).toBeNull();
  });

  it('treats 304 as checked and unchanged', async () => {
    const feed = store.subscribe(SENDER, URL_A);
    const result = await refreshFeed({
      store,
      feed,
      nowMs: NOW,
      log,
      fetchImpl: serving(new Response(null, { status: 304 })),
    });

    expect(result.status).toBe('unchanged');
    expect(store.feedFor(SENDER)?.lastFetchedAt).toBe(NOW);
  });

  it('logs no URL and no event title', async () => {
    // The URL carries the token that makes a private feed private, and titles
    // are message content by another route (§6.9).
    const feed = store.subscribe(SENDER, 'https://calendar.example.test/f.ics?token=s3cr3t');
    await refreshFeed({
      store,
      feed,
      nowMs: NOW,
      log,
      fetchImpl: serving(new Response(feedBody('פגישה עם יוסי'), { status: 200 })),
    });

    const serialized = JSON.stringify(log.captured);
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('יוסי');
    expect(serialized).not.toContain('calendar.example.test');
  });
});

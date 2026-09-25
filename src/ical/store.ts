/**
 * Subscribed feeds and their cached events (PLAN §6.15).
 *
 * The cache is the point. A feed is a file over the network, and fetching a
 * semester's timetable every time someone asks what is on today would be slow,
 * wasteful, and rate-limited by the other end. It is refreshed on the daily
 * cron and on demand when it has gone stale.
 *
 * **Replaced wholesale, never merged.** An event deleted from the feed must
 * disappear here too, and a merge would leave it behind forever. A refresh
 * therefore deletes the feed's rows and writes the new ones.
 *
 * Titles are content: stored, never logged.
 */
import type { SqlDriver } from '../core/sql.js';
import type { IcalEvent } from './parse.js';

/** How far ahead events are expanded and kept. A digest asks about today; a
 * calendar read asks about next week. Sixty days covers both with room. */
export const HORIZON_DAYS = 60;

/** Past this, a read refreshes the feed before answering. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export type Feed = {
  id: string;
  url: string;
  etag: string | null;
  lastFetchedAt: number | null;
  lastError: string | null;
  eventCount: number;
};

export class IcalStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /**
   * Subscribe, replacing any existing feed for this sender.
   *
   * One feed, not many. A second would need a way to name them, to remove one
   * of them, and to say which a given event came from — and none of that is
   * worth building before one has been used.
   */
  subscribe(principal: string, url: string): Feed {
    this.unsubscribe(principal);

    const id = randomHex(8);
    this.sql.exec(
      `INSERT INTO ical_feeds (id, principal, url, created_at) VALUES (?, ?, ?, ?)`,
      id,
      principal,
      url,
      this.now(),
    );
    return { id, url, etag: null, lastFetchedAt: null, lastError: null, eventCount: 0 };
  }

  unsubscribe(principal: string): boolean {
    const rows = this.sql.exec(
      'DELETE FROM ical_feeds WHERE principal = ? RETURNING id',
      principal,
    );
    for (const row of rows) {
      this.sql.exec('DELETE FROM ical_events WHERE feed_id = ?', String(row['id']));
    }
    return rows.length > 0;
  }

  feedFor(principal: string): Feed | null {
    const row = this.sql.exec('SELECT * FROM ical_feeds WHERE principal = ?', principal)[0];
    return row ? toFeed(row) : null;
  }

  /** Every feed, for the daily refresh. */
  all(): Array<Feed & { principal: string }> {
    return this.sql
      .exec('SELECT * FROM ical_feeds')
      .map((row) => ({ ...toFeed(row), principal: String(row['principal']) }));
  }

  /** Replace a feed's events and record a successful refresh. */
  replaceEvents(feedId: string, events: readonly IcalEvent[], etag: string | null): void {
    this.sql.exec('DELETE FROM ical_events WHERE feed_id = ?', feedId);

    for (const event of events) {
      this.sql.exec(
        `INSERT INTO ical_events (feed_id, uid, title, start_utc, end_utc, all_day)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(feed_id, uid, start_utc) DO NOTHING`,
        feedId,
        event.uid,
        event.title,
        event.startUtc,
        event.endUtc,
        event.allDay ? 1 : 0,
      );
    }

    this.sql.exec(
      `UPDATE ical_feeds
       SET etag = ?, last_fetched_at = ?, last_error = NULL, event_count = ?
       WHERE id = ?`,
      etag,
      this.now(),
      events.length,
      feedId,
    );
  }

  /**
   * Record a refresh that failed.
   *
   * The cached events are deliberately left alone. Yesterday's timetable is a
   * better answer than no timetable, and the error is what `/ical` reports.
   */
  markFailed(feedId: string, errorCode: string): void {
    this.sql.exec(
      'UPDATE ical_feeds SET last_fetched_at = ?, last_error = ? WHERE id = ?',
      this.now(),
      errorCode,
      feedId,
    );
  }

  /** A refresh that returned 304: nothing changed, but it was checked. */
  markUnchanged(feedId: string): void {
    this.sql.exec(
      'UPDATE ical_feeds SET last_fetched_at = ?, last_error = NULL WHERE id = ?',
      this.now(),
      feedId,
    );
  }

  /** Cached events overlapping a window, oldest first. */
  eventsBetween(principal: string, startUtc: number, endUtc: number, limit = 20): IcalEvent[] {
    return this.sql
      .exec(
        `SELECT e.* FROM ical_events e
         JOIN ical_feeds f ON f.id = e.feed_id
         WHERE f.principal = ? AND e.end_utc > ? AND e.start_utc < ?
         ORDER BY e.start_utc ASC
         LIMIT ?`,
        principal,
        startUtc,
        endUtc,
        limit,
      )
      .map((row) => ({
        uid: String(row['uid']),
        title: String(row['title']),
        startUtc: Number(row['start_utc']),
        endUtc: Number(row['end_utc']),
        allDay: Number(row['all_day']) === 1,
      }));
  }

  isStale(feed: Feed): boolean {
    return feed.lastFetchedAt === null || this.now() - feed.lastFetchedAt > STALE_AFTER_MS;
  }
}

function toFeed(row: Record<string, unknown>): Feed {
  return {
    id: String(row['id']),
    url: String(row['url']),
    etag: row['etag'] === null || row['etag'] === undefined ? null : String(row['etag']),
    lastFetchedAt: row['last_fetched_at'] === null ? null : Number(row['last_fetched_at']),
    lastError: row['last_error'] === null || row['last_error'] === undefined ? null : String(row['last_error']),
    eventCount: Number(row['event_count'] ?? 0),
  };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

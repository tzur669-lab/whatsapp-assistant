/**
 * Event-triggered reminders' store (block J, J4, PLAN §6.30).
 *
 * A watch waits for a mail, a notification or an SMS whose words hold all its
 * keywords, then fires its reminder once (or up to five times, an hour apart).
 * The phone matches notifications and SMS itself and sends only the watch's id
 * (`/app/watch/fired`); mail is matched by Gmail on the hourly tick.
 *
 * A fire is `fire`: one synchronous transaction that claims the watch with one
 * conditional UPDATE — active, owned, not expired, fires left, out of cooldown
 * — and schedules a due-now reminder with its text. Delivery is then any due
 * reminder's: `alarm()` → the rest hold → outbox → push. Two fires race and one
 * claims; a crash before the transaction spends nothing, after it leaves a
 * reminder the next alarm delivers. Never retried.
 */
import type { SqlDriver, SqlRow } from '../core/sql.js';
import { normalizeWatchText } from '../core/watch-match.js';
import type { ReminderStore } from './reminder-store.js';
import { localPartsOf } from '../time/tz.js';

export const WATCH_SOURCES = ['mail', 'notification', 'sms'] as const;
export type WatchSource = (typeof WATCH_SOURCES)[number];

export const MAX_ACTIVE_WATCHES = 10;
export const WATCH_DEFAULT_DAYS = 30;
export const WATCH_MAX_DAYS = 90;
export const WATCH_REPEAT_FIRES = 5;
export const WATCH_COOLDOWN_MS = 60 * 60 * 1000;
/** How far back past the last check a mail tick looks: Gmail's indexing delay. */
export const MAIL_OVERLAP_MS = 15 * 60 * 1000;
/** Gmail ids remembered per watch, so the overlap never fires twice. */
export const MAX_SEEN_IDS = 50;
/** An ended watch is kept this long, like a reminder (`SETTLED_RETENTION_MS`). */
export const WATCH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const ZONE = 'Asia/Jerusalem';

export type Watch = {
  id: string;
  source: WatchSource;
  /** Normalized for matching (`watch-match.ts`). */
  keywords: string[];
  /** As the user said them. */
  said: string[];
  sender: string | null;
  text: string;
  firesLeft: number;
  expiresAt: number;
  createdAt: number;
};

export type MailWatch = Watch & { lastChecked: number | null; seen: string[] };

export type FireOutcome = 'claimed' | 'none';

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stringList(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function isSource(value: unknown): value is WatchSource {
  return typeof value === 'string' && (WATCH_SOURCES as readonly string[]).includes(value);
}

function watchOf(row: SqlRow): Watch | null {
  const source = row['source'];
  if (!isSource(source)) return null;
  return {
    id: String(row['id']),
    source,
    keywords: stringList(row['keywords']),
    said: stringList(row['said']),
    sender: typeof row['sender'] === 'string' ? row['sender'] : null,
    text: String(row['text']),
    firesLeft: Number(row['fires_left']),
    expiresAt: Number(row['expires_at']),
    createdAt: Number(row['created_at']),
  };
}

function wallTime(utcMs: number): string {
  const p = localPartsOf(utcMs, ZONE);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export class WatchStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** A new watch, or `full` at `MAX_ACTIVE_WATCHES`. The count and the insert are one transaction. */
  create(params: {
    principal: string;
    source: WatchSource;
    said: readonly string[];
    sender?: string | null;
    text: string;
    repeat: boolean;
    expiresAt: number;
  }): { ok: true; id: string } | { ok: false; reason: 'full' } {
    const now = this.now();
    const id = randomHex(16);
    const keywords = params.said.map(normalizeWatchText).filter((keyword) => keyword.length > 0);
    return this.sql.transaction(() => {
      const count = this.sql.exec(
        "SELECT COUNT(*) AS n FROM watches WHERE principal = ? AND status = 'active' AND expires_at > ?",
        params.principal,
        now,
      )[0]?.['n'];
      if (Number(count) >= MAX_ACTIVE_WATCHES) return { ok: false as const, reason: 'full' as const };
      this.sql.exec(
        `INSERT INTO watches
           (id, principal, source, keywords, said, sender, text, fires_left, expires_at, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        id,
        params.principal,
        params.source,
        JSON.stringify(keywords),
        JSON.stringify(params.said),
        params.sender ?? null,
        params.text,
        params.repeat ? WATCH_REPEAT_FIRES : 1,
        params.expiresAt,
        now,
        now,
      );
      return { ok: true as const, id };
    });
  }

  /** True when an active watch of this principal was cancelled. */
  cancel(principal: string, id: string): boolean {
    return (
      this.sql.exec(
        "UPDATE watches SET status = 'cancelled', updated_at = ? WHERE id = ? AND principal = ? AND status = 'active' RETURNING id",
        this.now(),
        id,
        principal,
      ).length > 0
    );
  }

  /** Active, unexpired watches, oldest first; `source` narrows them. */
  active(principal: string, source?: WatchSource): Watch[] {
    const rows = this.sql.exec(
      `SELECT * FROM watches WHERE principal = ? AND status = 'active' AND expires_at > ?
       ${source ? 'AND source = ?' : ''} ORDER BY created_at, id`,
      ...[principal, this.now(), ...(source ? [source] : [])],
    );
    return rows.map(watchOf).filter((watch): watch is Watch => watch !== null);
  }

  /** Active mail watches with what the tick needs. */
  mailWatches(principal: string): MailWatch[] {
    return this.sql
      .exec(
        "SELECT * FROM watches WHERE principal = ? AND status = 'active' AND source = 'mail' AND expires_at > ? ORDER BY created_at, id",
        principal,
        this.now(),
      )
      .flatMap((row) => {
        const watch = watchOf(row);
        if (!watch) return [];
        const checked = row['last_checked'];
        return [{ ...watch, lastChecked: typeof checked === 'number' ? checked : null, seen: stringList(row['seen_ids']) }];
      });
  }

  /**
   * After a successful Gmail list: the tick's start time and the ids seen, the
   * newest `MAX_SEEN_IDS`. Conditional, so a watch cancelled during the list
   * stays cancelled. A failed list writes nothing: the next tick looks further back.
   */
  recordMailCheck(id: string, tickStart: number, seen: readonly string[]): void {
    this.sql.exec(
      "UPDATE watches SET last_checked = ?, seen_ids = ?, updated_at = ? WHERE id = ? AND status = 'active'",
      tickStart,
      JSON.stringify(seen.slice(-MAX_SEEN_IDS)),
      this.now(),
      id,
    );
  }

  /**
   * Claim one fire and schedule its reminder now, in one transaction. `none`:
   * not this principal's, cancelled, spent, expired or cooling down — nothing
   * changed. Synchronous on purpose: nothing may await between claim and schedule.
   */
  fire(principal: string, id: string, reminders: ReminderStore, sources: readonly WatchSource[] = WATCH_SOURCES): FireOutcome {
    const now = this.now();
    const allowed = sources.filter((source) => (WATCH_SOURCES as readonly string[]).includes(source));
    if (allowed.length === 0) return 'none';
    return this.sql.transaction(() => {
      const claimed = this.sql.exec(
        `UPDATE watches
           SET fires_left = fires_left - 1,
               cooldown_until = ?,
               status = CASE WHEN fires_left - 1 <= 0 THEN 'spent' ELSE status END,
               updated_at = ?
         WHERE id = ? AND principal = ? AND status = 'active' AND expires_at > ? AND fires_left > 0
           AND (cooldown_until IS NULL OR cooldown_until <= ?)
           AND source IN (${allowed.map(() => '?').join(', ')})
         RETURNING text`,
        now + WATCH_COOLDOWN_MS,
        now,
        id,
        principal,
        now,
        now,
        ...allowed,
      )[0];
      if (!claimed) return 'none' as const;
      reminders.schedule({ principal, text: String(claimed['text']), dueAtUtc: now, localWallTime: wallTime(now), tz: ZONE });
      return 'claimed' as const;
    });
  }

  /** Delete watches that ended or expired more than `WATCH_RETENTION_MS` ago. */
  purge(): number {
    const cutoff = this.now() - WATCH_RETENTION_MS;
    return this.sql.exec(
      `DELETE FROM watches
       WHERE (status != 'active' AND updated_at < ?) OR (status = 'active' AND expires_at < ?)
       RETURNING id`,
      cutoff,
      cutoff,
    ).length;
  }
}

/** The Gmail query for a mail watch, built by code from the words the user said. Never model text. */
export function mailQuery(watch: Pick<MailWatch, 'said' | 'sender' | 'createdAt' | 'lastChecked'>): string {
  const since = Math.max(watch.createdAt, (watch.lastChecked ?? watch.createdAt) - MAIL_OVERLAP_MS);
  // Letters, digits and spaces only: nothing Gmail would read as an operator.
  const clean = (words: string) => words.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const terms = watch.said.map(clean).filter((term) => term.length > 0).map((term) => `"${term}"`);
  const sender = watch.sender ? clean(watch.sender) : '';
  return [`after:${Math.floor(since / 1000)}`, ...(sender ? [`from:(${sender})`] : []), ...terms].join(' ');
}

/** What the mail tick needs from Gmail: ids for a query, one page. */
export type MailIdLister = {
  listIds(query: string, max: number): Promise<{ ok: true; value: string[] } | { ok: false; error: { code: string } }>;
};

/**
 * The hourly tick's mail watches (PLAN §6.30): one list per watch, ids only, by
 * a query code built. Any id not seen before makes one claim attempt, whatever
 * the count. `last_checked` is the tick's start, written only after a
 * successful list, conditionally; a failed one (a 429 included) waits for the
 * next tick, no retry. Returns how many watches fired.
 */
export async function checkMailWatches(params: {
  principal: string;
  watches: WatchStore;
  reminders: ReminderStore;
  gmail: MailIdLister;
  tickStart: number;
  onListFailed?: (errorCode: string) => void;
}): Promise<number> {
  let fired = 0;
  for (const watch of params.watches.mailWatches(params.principal)) {
    const listed = await params.gmail.listIds(mailQuery(watch), MAX_SEEN_IDS);
    if (!listed.ok) {
      params.onListFailed?.(listed.error.code);
      continue;
    }
    const seen = new Set(watch.seen);
    const fresh = listed.value.filter((id) => !seen.has(id));
    // After the await: the conditional UPDATE leaves a watch cancelled meanwhile as it is.
    params.watches.recordMailCheck(watch.id, params.tickStart, [...watch.seen, ...fresh]);
    if (fresh.length > 0 && params.watches.fire(params.principal, watch.id, params.reminders, ['mail']) === 'claimed') fired++;
  }
  return fired;
}

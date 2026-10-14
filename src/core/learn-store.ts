/**
 * The bot learns the user (block K, K1, PLAN §6.31, 2026-10-14).
 *
 * A journal of small things: what the user said the bot missed, what they had
 * to say twice, the Undo and "no" taps, the travel time they give. Off by
 * default (`/learn on`). Code-built, AES-GCM where it holds text, and never
 * given to a model: the agent's services do not carry this store, and nothing
 * here changes policy, tiers or limits (invariant 8). What it learns ends only
 * in a preference with its own command (K2) or in the monthly export (K3).
 *
 * Disclosure first. A kind is collected only once the notice that names it
 * was delivered (`KIND_SINCE[kind] <= learn_notice_seen`): on the app, when
 * the phone acks the notice's own outbox row; on WhatsApp, when its send
 * succeeded. Every computation reads only data from its own start on
 * (`startOf`), so nothing from before `/learn on`, or before a `/learn forget`,
 * ever shapes anything.
 *
 * Settings are global: this object serves one user.
 */
import type { SqlDriver } from './sql.js';
import type { Repository } from './repo.js';
import type { Keyring } from '../security/crypto.js';
import { decryptToken, encryptToken } from '../security/crypto.js';
import { sha256Hex } from '../confirm/pending.js';
import { COMMAND_KINDS } from './router.js';
import { REGISTRY } from '../tools/registry.js';
import { addDays, localPartsOf, ZONE } from '../time/tz.js';

/** The notice the code renders now. Bump it when a kind is added, with `KIND_SINCE`. */
export const LEARN_NOTICE_VERSION = 1;

export const LEARN_KINDS = ['miss', 'rephrase', 'undo', 'confirm_no', 'leave'] as const;
export type LearnKind = (typeof LEARN_KINDS)[number];

/** Stored kinds, and the features derived from other tables (K2), each with the notice that disclosed it. */
export type LearnFeature = LearnKind | 'weeks' | 'first_message';
export const KIND_SINCE: Readonly<Record<LearnFeature, number>> = {
  miss: 1,
  rephrase: 1,
  undo: 1,
  confirm_no: 1,
  leave: 1,
  weeks: 1,
  first_message: 1,
};

export const LEARN_EVENT_TTL_MS = 60 * 24 * 60 * 60 * 1000;
export const MAX_LEARN_EVENTS = 200;
export const LEARN_WEEKS_KEPT = 26;
/** Each text is cut here, as the misses are. */
export const MAX_LEARN_TEXT_CHARS = 1_200;
/** A rephrase is the next request within this long. */
export const REPHRASE_WINDOW_MS = 3 * 60 * 1000;

const ON_KEY = 'learn_on';
const SEEN_KEY = 'learn_notice_seen';
const SENT_KEY = 'learn_notice_sent';
const SINCE_KEY = 'learn_since';
const VERSION_SINCE_KEY = 'learn_version_since';
const REVIEW_SENT_KEY = 'learn_review_sent_on';

/** What a proposal may change: a preference with its own command (K2). Closed. */
export const PROPOSAL_KINDS = ['digest_hour', 'leave_min'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_STATUSES = ['pending', 'accepted', 'declined', 'superseded', 'expired', 'cancelled'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
/** A proposal's buttons stay good this long. */
export const PROPOSAL_TTL_MS = 6 * 24 * 60 * 60 * 1000;
/** Ended proposals are kept this long, for the export's outcome counts. */
export const PROPOSAL_KEPT_MS = 90 * 24 * 60 * 60 * 1000;

export type NewProposal = { id: string; nonce: string; kind: ProposalKind; value: number };

/** What a tap did, read from the row after the transaction. */
export type ProposalAnswer =
  | { kind: 'gone' }
  | { kind: 'applied'; proposal: ProposalKind; value: number }
  | { kind: 'declined' }
  | { kind: 'answered' }
  | { kind: 'expired' };

export type LearnState = {
  on: boolean;
  /** The highest notice version delivered; null until the first. */
  seen: number | null;
  /** A notice queued on the app and not yet acked. */
  sent: { version: number; seq: number } | null;
  since: number | null;
};

export type LearnStatus = LearnState & {
  counts: Record<LearnKind, number>;
  oldest: number | null;
};

/** One side of a failed exchange or its rephrase: the words and what the turn settled on. */
export type LearnTurn = { user: string; reply: string; outcome: string; intent: string | null };

export type SealedEvent = {
  id: string;
  principal: string;
  kind: 'miss' | 'rephrase';
  ciphertext: string;
  meta: string;
  createdAt: number;
};

export type WeekCounter = 'messages' | 'misses' | 'rephrases';

export type WeekRow = { week: string; messages: number; misses: number; rephrases: number };

/** A `learn_events` row as stored: text only as ciphertext. */
export type StoredEvent = {
  id: string;
  kind: string;
  confidence: string | null;
  ciphertext: string | null;
  meta: string;
  createdAt: number;
};

export class LearnStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly repo: Repository,
    private readonly now: () => number,
    private readonly keyring: () => Keyring,
  ) {}

  // -- state ----------------------------------------------------------------

  state(): LearnState {
    const seen = this.numberSetting(SEEN_KEY);
    const since = this.numberSetting(SINCE_KEY);
    return { on: this.repo.getSetting(ON_KEY) === '1', seen, sent: this.sentNotice(), since };
  }

  /** On, its notice delivered, and started. */
  collectable(feature: LearnFeature): boolean {
    const state = this.state();
    return state.on && state.since !== null && state.seen !== null && KIND_SINCE[feature] <= state.seen;
  }

  /** The first instant a feature may read data from, or null while it is not collectable. */
  startOf(feature: LearnFeature): number | null {
    if (!this.collectable(feature)) return null;
    const since = this.numberSetting(SINCE_KEY) ?? 0;
    const versionSince = this.versionSince()[KIND_SINCE[feature]] ?? since;
    return Math.max(since, versionSince);
  }

  /**
   * `/learn on`. `already`: on, the current notice delivered, nothing waiting —
   * nothing changes. Otherwise the caller sends the current notice, and only
   * its delivery starts collecting.
   */
  turnOn(): 'already' | 'notice' {
    const state = this.state();
    if (state.on && state.seen !== null && state.seen >= LEARN_NOTICE_VERSION && state.sent === null) return 'already';
    this.repo.setSetting(ON_KEY, '1');
    return 'notice';
  }

  /**
   * `/learn off`: stops every learning write and send. Data stays (`/learn
   * forget` removes it). Turning on again sends the notice again, and collects
   * only from its delivery.
   */
  turnOff(): boolean {
    return this.sql.transaction(() => {
      const wasOn = this.state().on;
      for (const key of [ON_KEY, SEEN_KEY, SENT_KEY, SINCE_KEY, VERSION_SINCE_KEY]) {
        this.sql.exec('DELETE FROM settings WHERE key = ?', key);
      }
      // Their buttons then answer "expired" (K2).
      this.sql.exec("UPDATE learn_proposals SET status = 'cancelled', settled_at = ? WHERE status = 'pending'", this.now());
      return wasOn;
    });
  }

  /** The app queued the notice as this outbox row. Inside the caller's transaction. */
  noticeQueued(version: number, seq: number): void {
    if (!this.state().on) return;
    this.repo.setSetting(SENT_KEY, JSON.stringify({ version, seq }));
  }

  /**
   * The notice reached the user: the phone acked its row, or WhatsApp took it.
   * `seen` never goes down; the first delivery starts the journal, and each
   * newer version starts its own features now.
   */
  noticeDelivered(version: number): void {
    const state = this.state();
    if (!state.on) return;
    const now = this.now();
    const before = state.seen ?? 0;
    const seen = Math.max(before, version);
    this.repo.setSetting(SEEN_KEY, String(seen));
    if (state.since === null) this.repo.setSetting(SINCE_KEY, String(now));
    const versionSince = this.versionSince();
    for (let v = before + 1; v <= seen; v++) versionSince[v] ??= now;
    this.repo.setSetting(VERSION_SINCE_KEY, JSON.stringify(versionSince));
    this.sql.exec('DELETE FROM settings WHERE key = ?', SENT_KEY);
  }

  /** The phone acked these rows. Only the exact outstanding seq counts. Inside the ack's transaction. */
  acked(seqs: readonly number[]): void {
    const sent = this.sentNotice();
    if (sent && seqs.includes(sent.seq)) this.noticeDelivered(sent.version);
  }

  /** These rows expired unacked. The outstanding notice among them is queued again by the next tick. */
  expired(seqs: readonly number[]): void {
    const sent = this.sentNotice();
    if (sent && seqs.includes(sent.seq)) this.sql.exec('DELETE FROM settings WHERE key = ?', SENT_KEY);
  }

  /** The notice version the hourly tick should send, or null. Never while one is outstanding. */
  staleNotice(): number | null {
    const state = this.state();
    if (!state.on || state.sent !== null) return null;
    if (state.seen !== null && state.seen >= LEARN_NOTICE_VERSION) return null;
    return LEARN_NOTICE_VERSION;
  }

  status(principal: string): LearnStatus {
    const counts = Object.fromEntries(LEARN_KINDS.map((kind) => [kind, 0])) as Record<LearnKind, number>;
    for (const row of this.sql.exec(
      'SELECT kind, COUNT(*) AS n FROM learn_events WHERE principal = ? GROUP BY kind',
      principal,
    )) {
      const kind = String(row['kind']);
      if ((LEARN_KINDS as readonly string[]).includes(kind)) counts[kind as LearnKind] = Number(row['n']);
    }
    const oldest = this.sql.exec('SELECT MIN(created_at) AS at FROM learn_events WHERE principal = ?', principal)[0]?.['at'];
    return { ...this.state(), counts, oldest: typeof oldest === 'number' ? oldest : null };
  }

  /**
   * `/learn forget`: the journal and the counters go. The misses (§6.23) keep
   * their own rules, and a file already exported is not ours to touch. While
   * collecting, the journal starts again now.
   */
  forget(principal: string): { events: number; weeks: number; proposals: number } {
    return this.sql.transaction(() => {
      const events = this.sql.exec('DELETE FROM learn_events WHERE principal = ? RETURNING id', principal).length;
      const weeks = this.sql.exec('DELETE FROM learn_weeks WHERE principal = ? RETURNING week_start', principal).length;
      const proposals = this.sql.exec('DELETE FROM learn_proposals WHERE principal = ? RETURNING id', principal).length;
      if (this.state().since !== null) this.repo.setSetting(SINCE_KEY, String(this.now()));
      return { events, weeks, proposals };
    });
  }

  // -- events ---------------------------------------------------------------

  /** A copy of what "לא הבנת" kept, with its own ciphertext. */
  async sealMiss(principal: string, miss: LearnTurn): Promise<SealedEvent | null> {
    if (!this.collectable('miss')) return null;
    return this.seal(principal, 'miss', { failed: cutTurn(miss) }, {});
  }

  /** A failed request and its rephrase: one row, one ciphertext, never split. */
  async sealRephrase(
    principal: string,
    failed: LearnTurn,
    fixed: LearnTurn,
    meta: { gapSeconds: number; tools: readonly string[] },
  ): Promise<SealedEvent | null> {
    if (!this.collectable('rephrase')) return null;
    const tools = meta.tools.filter(isToolName).slice(0, 4);
    return this.seal(principal, 'rephrase', { failed: cutTurn(failed), fixed: cutTurn(fixed) }, {
      gap_s: Math.max(0, Math.round(meta.gapSeconds)),
      tools,
    });
  }

  /** Write a sealed event. Synchronous: callable inside the caller's transaction. */
  insertSealed(event: SealedEvent): void {
    this.sql.exec(
      'INSERT INTO learn_events (id, principal, kind, confidence, ciphertext, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      event.id,
      event.principal,
      event.kind,
      event.kind === 'miss' ? 'reported' : 'heuristic',
      event.ciphertext,
      event.meta,
      event.createdAt,
    );
    this.trim(event.principal);
  }

  /** An Undo or a declined confirmation: the tool and how long after, no text. */
  addTap(principal: string, kind: 'undo' | 'confirm_no', tool: string, seconds: number): void {
    if (!this.collectable(kind) || !isToolName(tool)) return;
    this.insertPlain(principal, kind, { tool, seconds: Math.max(0, Math.round(seconds)) });
  }

  /** A "time to leave" reminder that was set: its minutes, and whether the user said them. */
  addLeave(principal: string, minutes: number, stated: boolean): void {
    if (!this.collectable('leave') || !Number.isInteger(minutes)) return;
    this.insertPlain(principal, 'leave', { minutes, stated: stated ? 1 : 0 });
  }

  /** This week's counter, only while the counters are collectable. */
  bumpWeek(principal: string, counter: WeekCounter): void {
    if (!this.collectable('weeks')) return;
    const column = WEEK_COLUMNS[counter];
    this.sql.exec(
      `INSERT INTO learn_weeks (principal, week_start, ${column}) VALUES (?, ?, 1)
       ON CONFLICT(principal, week_start) DO UPDATE SET ${column} = ${column} + 1`,
      principal,
      weekStartOf(this.now()),
    );
  }

  /** Daily: events older than 60 days, weeks older than 26. Runs whether on or off. */
  purge(): { events: number; weeks: number } {
    const now = this.now();
    const events = this.sql.exec('DELETE FROM learn_events WHERE created_at <= ? RETURNING id', now - LEARN_EVENT_TTL_MS).length;
    const oldestWeek = weekStartOf(now - LEARN_WEEKS_KEPT * 7 * 24 * 60 * 60 * 1000);
    const weeks = this.sql.exec('DELETE FROM learn_weeks WHERE week_start < ? RETURNING week_start', oldestWeek).length;
    return { events, weeks };
  }

  // -- the weekly review (K2) -------------------------------------------------

  /** The local day the weekly review was dealt with, or null. */
  reviewSentOn(): string | null {
    return this.repo.getSetting(REVIEW_SENT_KEY);
  }

  /** Inside the review's transaction, with its outbox rows. */
  markReviewSent(dayKey: string): void {
    this.repo.setSetting(REVIEW_SENT_KEY, dayKey);
  }

  /** The counters of the weeks starting at or after `fromWeek` (a `YYYY-MM-DD` Sunday), oldest first. */
  weeks(principal: string, fromWeek: string): WeekRow[] {
    return this.sql
      .exec(
        'SELECT week_start, messages, misses, rephrases FROM learn_weeks WHERE principal = ? AND week_start >= ? ORDER BY week_start',
        principal,
        fromWeek,
      )
      .map((row) => ({
        week: String(row['week_start']),
        messages: Number(row['messages']),
        misses: Number(row['misses']),
        rephrases: Number(row['rephrases']),
      }));
  }

  /** The travel times the user said (`stated`), at or after `fromMs`. */
  statedLeaves(principal: string, fromMs: number): number[] {
    const out: number[] = [];
    for (const row of this.sql.exec(
      "SELECT meta FROM learn_events WHERE principal = ? AND kind = 'leave' AND created_at >= ? ORDER BY created_at",
      principal,
      fromMs,
    )) {
      try {
        const meta = JSON.parse(String(row['meta'])) as { minutes?: unknown; stated?: unknown };
        if (meta.stated === 1 && Number.isInteger(meta.minutes)) out.push(meta.minutes as number);
      } catch {
        // A damaged row teaches nothing.
      }
    }
    return out;
  }

  /**
   * When the user wrote, at or after `fromMs`: the existing `inbound_messages`
   * (one row per message, kept 30 days). Buttons and commands are left out, so
   * `/digest 7` as the day's first message is never a habit. Plain integers;
   * the day grouping is done in `habits.ts`.
   */
  firstMessageTimes(principal: string, fromMs: number): number[] {
    const placeholders = COMMAND_KINDS.map(() => '?').join(', ');
    return this.sql
      .exec(
        `SELECT received_at FROM inbound_messages
         WHERE principal = ? AND received_at >= ? AND kind != 'button'
           AND (decision IS NULL OR decision != 'BUTTON')
           AND (intent IS NULL OR intent NOT IN (${placeholders}))
         ORDER BY received_at`,
        principal,
        fromMs,
        ...COMMAND_KINDS,
      )
      .map((row) => Number(row['received_at']));
  }

  /** The kinds with a proposal still waiting: a new one of the same kind waits too. */
  pendingKinds(principal: string): Set<ProposalKind> {
    const kinds = new Set<ProposalKind>();
    for (const row of this.sql.exec(
      "SELECT DISTINCT kind FROM learn_proposals WHERE principal = ? AND status = 'pending' AND expires_at > ?",
      principal,
      this.now(),
    )) {
      const kind = String(row['kind']);
      if (isProposalKind(kind)) kinds.add(kind);
    }
    return kinds;
  }

  /**
   * A group of answers: one row each, one `group_id`. Synchronous, inside the
   * review's transaction. Returns the button nonces; only their hashes are stored.
   */
  insertGroup(principal: string, answers: ReadonlyArray<{ kind: ProposalKind; value: number }>): NewProposal[] {
    const now = this.now();
    const groupId = randomHex(8);
    return answers.map((answer) => {
      const id = randomHex(8);
      const nonce = randomHex(8);
      this.sql.exec(
        `INSERT INTO learn_proposals (id, principal, group_id, kind, value, status, nonce_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        id,
        principal,
        groupId,
        answer.kind,
        answer.value,
        nonceHash(nonce),
        now,
        now + PROPOSAL_TTL_MS,
      );
      return { id, nonce, kind: answer.kind, value: answer.value };
    });
  }

  /**
   * A tapped proposal button (`lp:`). One transaction, no awaits: claim the
   * row only while it is pending, unexpired, its nonce matches and no sibling
   * was taken; then supersede the siblings and apply the stored value through
   * the command's own setter. A throw rolls all of it back. `no` declines a
   * proposal (a group of one) and does nothing to a question's answer. The
   * reply comes from the row's status afterwards, never from the tap.
   */
  answerProposal(principal: string, id: string, nonce: string, accept: boolean): ProposalAnswer {
    return this.sql.transaction((): ProposalAnswer => {
      const now = this.now();
      const row = this.sql.exec(
        'SELECT group_id, kind, value, nonce_hash FROM learn_proposals WHERE id = ? AND principal = ?',
        id,
        principal,
      )[0];
      if (!row || String(row['nonce_hash']) !== nonceHash(nonce)) return { kind: 'gone' };
      const groupId = String(row['group_id']);
      const kind = String(row['kind']);
      const value = Number(row['value']);
      if (!isProposalKind(kind)) return { kind: 'gone' };

      if (accept) {
        const claimed = this.sql.exec(
          `UPDATE learn_proposals SET status = 'accepted', settled_at = ?
           WHERE id = ? AND status = 'pending' AND expires_at > ?
             AND NOT EXISTS (SELECT 1 FROM learn_proposals WHERE group_id = ? AND status = 'accepted')
           RETURNING id`,
          now,
          id,
          now,
          groupId,
        ).length;
        if (claimed === 1) {
          this.sql.exec(
            "UPDATE learn_proposals SET status = 'superseded', settled_at = ? WHERE group_id = ? AND id != ? AND status = 'pending'",
            now,
            groupId,
            id,
          );
          this.apply(kind, value);
          return { kind: 'applied', proposal: kind, value };
        }
      } else {
        const size = Number(this.sql.exec('SELECT COUNT(*) AS n FROM learn_proposals WHERE group_id = ?', groupId)[0]?.['n']);
        if (size === 1) {
          const declined = this.sql.exec(
            "UPDATE learn_proposals SET status = 'declined', settled_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ? RETURNING id",
            now,
            id,
            now,
          ).length;
          if (declined === 1) return { kind: 'declined' };
        }
      }
      return this.answerFromStatus(id, now);
    });
  }

  /**
   * Daily: pending rows past their time become `expired`, then ended rows
   * older than 90 days go. Pending rows are never deleted.
   */
  purgeProposals(): { expired: number; deleted: number } {
    const now = this.now();
    const expired = this.sql.exec(
      "UPDATE learn_proposals SET status = 'expired', settled_at = ? WHERE status = 'pending' AND expires_at <= ? RETURNING id",
      now,
      now,
    ).length;
    const deleted = this.sql.exec(
      "DELETE FROM learn_proposals WHERE status != 'pending' AND COALESCE(settled_at, created_at) <= ? RETURNING id",
      now - PROPOSAL_KEPT_MS,
    ).length;
    return { expired, deleted };
  }

  /** Outcome counts per kind, from the rows still kept (K3). */
  proposalOutcomes(principal: string): Array<{ kind: ProposalKind; status: ProposalStatus; count: number }> {
    const out: Array<{ kind: ProposalKind; status: ProposalStatus; count: number }> = [];
    for (const row of this.sql.exec(
      'SELECT kind, status, COUNT(*) AS n FROM learn_proposals WHERE principal = ? GROUP BY kind, status ORDER BY kind, status',
      principal,
    )) {
      const kind = String(row['kind']);
      const status = String(row['status']);
      if (isProposalKind(kind) && (PROPOSAL_STATUSES as readonly string[]).includes(status)) {
        out.push({ kind, status: status as ProposalStatus, count: Number(row['n']) });
      }
    }
    return out;
  }

  /** Every event of a principal, newest first, for the export (K3). Ciphertext as stored. */
  eventsForExport(principal: string): StoredEvent[] {
    return this.sql
      .exec(
        'SELECT id, kind, confidence, ciphertext, meta, created_at FROM learn_events WHERE principal = ? ORDER BY created_at DESC, id DESC',
        principal,
      )
      .map((row) => ({
        id: String(row['id']),
        kind: String(row['kind']),
        confidence: row['confidence'] === null || row['confidence'] === undefined ? null : String(row['confidence']),
        ciphertext: row['ciphertext'] === null || row['ciphertext'] === undefined ? null : String(row['ciphertext']),
        meta: String(row['meta']),
        createdAt: Number(row['created_at']),
      }));
  }

  /** Decrypt one sealed event's body (K3). */
  async open(principal: string, event: StoredEvent): Promise<unknown> {
    if (event.ciphertext === null) return null;
    return JSON.parse(await decryptToken(event.ciphertext, this.keyring(), learnAad(principal, event.id)));
  }

  private answerFromStatus(id: string, now: number): ProposalAnswer {
    const row = this.sql.exec('SELECT status, expires_at FROM learn_proposals WHERE id = ?', id)[0];
    const status = String(row?.['status'] ?? '');
    if (status === 'accepted' || status === 'superseded' || status === 'declined') return { kind: 'answered' };
    if (status === 'pending' && Number(row?.['expires_at']) > now) return { kind: 'answered' };
    return { kind: 'expired' };
  }

  /** The same setters as `/digest N` and `/leave N`. */
  private apply(kind: ProposalKind, value: number): void {
    if (kind === 'digest_hour') {
      if (!Number.isInteger(value) || value < 0 || value > 23) throw new RangeError('digest_hour_out_of_range');
      this.repo.setDigestHour(value);
      return;
    }
    this.repo.setLeaveDefaultMinutes(value);
  }

  // -- internals ------------------------------------------------------------

  private async seal(
    principal: string,
    kind: 'miss' | 'rephrase',
    body: Record<string, unknown>,
    meta: Record<string, unknown>,
  ): Promise<SealedEvent> {
    const id = randomHex(12);
    const ciphertext = await encryptToken(JSON.stringify(body), this.keyring(), learnAad(principal, id));
    return { id, principal, kind, ciphertext, meta: JSON.stringify(meta), createdAt: this.now() };
  }

  private insertPlain(principal: string, kind: 'undo' | 'confirm_no' | 'leave', meta: Record<string, unknown>): void {
    this.sql.exec(
      'INSERT INTO learn_events (id, principal, kind, confidence, ciphertext, meta, created_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)',
      randomHex(12),
      principal,
      kind,
      JSON.stringify(meta),
      this.now(),
    );
    this.trim(principal);
  }

  /** The newest 200 stay. A rephrase is one row, so a pair is never split. */
  private trim(principal: string): void {
    this.sql.exec(
      `DELETE FROM learn_events WHERE principal = ? AND id NOT IN
         (SELECT id FROM learn_events WHERE principal = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
      principal,
      principal,
      MAX_LEARN_EVENTS,
    );
  }

  private numberSetting(key: string): number | null {
    const raw = this.repo.getSetting(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  private sentNotice(): { version: number; seq: number } | null {
    const raw = this.repo.getSetting(SENT_KEY);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown; seq?: unknown };
      if (Number.isInteger(parsed.version) && Number.isInteger(parsed.seq)) {
        return { version: parsed.version as number, seq: parsed.seq as number };
      }
    } catch {
      // A damaged marker is no marker: the tick sends the notice again.
    }
    return null;
  }

  private versionSince(): Record<number, number> {
    const raw = this.repo.getSetting(VERSION_SINCE_KEY);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const out: Record<number, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        if (Number.isInteger(Number(key)) && typeof value === 'number') out[Number(key)] = value;
      }
      return out;
    } catch {
      return {};
    }
  }
}

const WEEK_COLUMNS: Readonly<Record<WeekCounter, string>> = {
  messages: 'messages',
  misses: 'misses',
  rephrases: 'rephrases',
};

/** The local date (`YYYY-MM-DD`) of the Sunday that starts this instant's week in Jerusalem. */
export function weekStartOf(atMs: number): string {
  const local = localPartsOf(atMs, ZONE);
  const sunday = addDays({ year: local.year, month: local.month, day: local.day, hour: 0, minute: 0 }, -local.weekday);
  return `${sunday.year}-${pad(sunday.month)}-${pad(sunday.day)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

const learnAad = (principal: string, id: string) => ({ provider: 'learn', account: `${principal}:${id}` });

function cutTurn(turn: LearnTurn): LearnTurn {
  return {
    user: turn.user.slice(0, MAX_LEARN_TEXT_CHARS),
    reply: turn.reply.slice(0, MAX_LEARN_TEXT_CHARS),
    outcome: turn.outcome.slice(0, 60),
    intent: turn.intent?.slice(0, 60) ?? null,
  };
}

function isToolName(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

function isProposalKind(kind: string): kind is ProposalKind {
  return (PROPOSAL_KINDS as readonly string[]).includes(kind);
}

function nonceHash(nonce: string): string {
  return sha256Hex(new TextEncoder().encode(`learn:${nonce}`));
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * What one turn tells the journal, filled by the orchestrator and written by
 * the pipeline once the turn is over (block K, K1). Never stored, never seen
 * by a model; carries tool names and a validated input, not words.
 */
export type LearnSignal =
  | { kind: 'executed'; tool: string; input: unknown }
  | { kind: 'undo' | 'confirm_no'; tool: string; createdAt: number };

export type LearnSink = {
  /** A tool ran, or a confirmation or card was shown. */
  understood: boolean;
  /** The tools that did, in order. */
  tools: string[];
  signals: LearnSignal[];
};

export function newLearnSink(): LearnSink {
  return { understood: false, tools: [], signals: [] };
}

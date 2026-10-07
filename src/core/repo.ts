/**
 * Data access over `SqlDriver`. Plain TypeScript: no Cloudflare imports, so it
 * runs unchanged on the Node Plan B (PLAN §3.4) and in unit tests.
 */
import type { SqlDriver, SqlRow } from './sql.js';

const SCHEMA_VERSION_KEY = 'schema_version';
const DIGEST_HOUR_KEY = 'digest_hour';
const DIGEST_SENT_KEY = 'digest_sent_on';
const REST_HOLD_KEY = 'rest_hold';
/** A durable counter: never reset, unlike the pruned table's rowid (§6.23). */
const INBOUND_SEQ_KEY = 'inbound_seq';

export type InboundRecord = {
  wamid: string;
  principal: string;
  receivedAt: number;
  sentAt: number;
  kind: string;
};

export type OutboundRecord = {
  wamid: string;
  /** `reply` | `reminder` | `system`. Never the message itself. */
  kind: string;
  sentAt: number;
  principal?: string;
  reminderId?: string;
};

export type DeliveryUpdate = {
  wamid: string;
  status: string;
  atMs: number;
  /** The stable `E_WA_*` code, never Meta's prose. */
  errorCode?: string;
  pricingCategory?: string;
};

/**
 * How far a message has got. Meta's own order, with `accepted` in front for the
 * 200 that is not a delivery.
 */
const STATUS_ORDER = ['accepted', 'sent', 'delivered', 'read'] as const;

function rank(status: string): number {
  const index = (STATUS_ORDER as readonly string[]).indexOf(status);
  // An unknown status ranks above everything known, so a status Meta adds later
  // is recorded rather than silently dropped.
  return index === -1 ? STATUS_ORDER.length : index;
}

export class Repository {
  constructor(private readonly sql: SqlDriver) {}

  /**
   * Apply migrations that have not run yet. Each migration is numbered; the
   * highest applied number is stored in `settings`.
   */
  migrate(migrations: readonly { readonly id: number; readonly sql: string }[]): number {
    this.sql.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const current = this.schemaVersion();

    const pending = [...migrations].filter((m) => m.id > current).sort((a, b) => a.id - b.id);
    for (const migration of pending) {
      // One transaction per migration, version bump included: a migration cut
      // off half-way leaves nothing behind, and the next start runs it whole.
      this.sql.transaction(() => {
        for (const statement of splitStatements(migration.sql)) {
          this.sql.exec(statement);
        }
        this.setSetting(SCHEMA_VERSION_KEY, String(migration.id));
      });
    }
    return this.schemaVersion();
  }

  /** See `SqlDriver.transaction`. Synchronous callbacks only. */
  transaction<T>(fn: () => T): T {
    return this.sql.transaction(fn);
  }

  schemaVersion(): number {
    // Before the first migration the settings table does not exist yet, which
    // reads as version 0 rather than an error.
    let raw: string | null;
    try {
      raw = this.getSetting(SCHEMA_VERSION_KEY);
    } catch {
      return 0;
    }
    const n = raw === null ? 0 : Number(raw);
    return Number.isFinite(n) ? n : 0;
  }

  getSetting(key: string): string | null {
    const rows = this.sql.exec('SELECT value FROM settings WHERE key = ?', key);
    const value = rows[0]?.['value'];
    return typeof value === 'string' ? value : null;
  }

  setSetting(key: string, value: string): void {
    this.sql.exec(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  /**
   * Record an inbound message. Returns false if this `wamid` was already seen,
   * which is how Meta's at-least-once retries are collapsed (PLAN §7.1).
   */
  recordInbound(record: InboundRecord): boolean {
    // The insert and its sequence number land together, or neither does: a
    // duplicate consumes no number, and two messages never share one (§6.23).
    return this.sql.transaction(() => {
      const rows = this.sql.exec(
        `INSERT INTO inbound_messages (wamid, principal, received_at, sent_at, kind)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(wamid) DO NOTHING
         RETURNING wamid`,
        record.wamid,
        record.principal,
        record.receivedAt,
        record.sentAt,
        record.kind,
      );
      if (rows.length === 0) return false;
      const next = Number(this.getSetting(INBOUND_SEQ_KEY) ?? '0') + 1;
      this.setSetting(INBOUND_SEQ_KEY, String(next));
      this.sql.exec('UPDATE inbound_messages SET seq = ? WHERE wamid = ?', next, record.wamid);
      return true;
    });
  }

  /**
   * The message's place in arrival order (§6.23). Null for a message recorded
   * before migration 0022, or already pruned.
   */
  inboundSeq(wamid: string): number | null {
    const value = this.sql.exec('SELECT seq FROM inbound_messages WHERE wamid = ?', wamid)[0]?.['seq'];
    return typeof value === 'number' ? value : null;
  }

  markInboundOutcome(wamid: string, fields: { intent?: string; decision?: string; errorCode?: string }): void {
    this.sql.exec(
      `UPDATE inbound_messages
       SET intent = COALESCE(?, intent),
           decision = COALESCE(?, decision),
           error_code = COALESCE(?, error_code)
       WHERE wamid = ?`,
      fields.intent ?? null,
      fields.decision ?? null,
      fields.errorCode ?? null,
      wamid,
    );
  }

  /** How many messages of one kind arrived since `sinceMs` — the voice cap in the app (§6.18). */
  inboundCountSince(kind: string, sinceMs: number): number {
    return Number(
      this.sql.exec('SELECT COUNT(*) AS n FROM inbound_messages WHERE kind = ? AND received_at >= ?', kind, sinceMs)[0]?.[
        'n'
      ] ?? 0,
    );
  }

  getInbound(wamid: string): SqlRow | null {
    return this.sql.exec('SELECT * FROM inbound_messages WHERE wamid = ?', wamid)[0] ?? null;
  }

  /** Purge inbound records past their retention window (PLAN §6.8: 30 days). */
  purgeInboundBefore(cutoffMs: number): void {
    this.sql.exec('DELETE FROM inbound_messages WHERE received_at < ?', cutoffMs);
  }

  // -- the daily digest (PLAN §6.12) -----------------------------------------

  /** The local hour the digest is sent at, or null when it is off. */
  digestHour(): number | null {
    const raw = this.getSetting(DIGEST_HOUR_KEY);
    if (raw === null) return null;
    const hour = Number(raw);
    return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
  }

  setDigestHour(hour: number | null): void {
    if (hour === null) {
      this.sql.exec('DELETE FROM settings WHERE key = ?', DIGEST_HOUR_KEY);
      return;
    }
    this.setSetting(DIGEST_HOUR_KEY, String(hour));
  }

  /**
   * Whether today's digest has already been dealt with.
   *
   * The cron runs hourly and only one of those hours is the digest hour, so this
   * is belt and braces — but a cron that fires twice in the same hour is a
   * documented possibility, and a duplicate digest costs a message and looks
   * broken.
   */
  digestDoneOn(): string | null {
    return this.getSetting(DIGEST_SENT_KEY);
  }

  markDigestDone(dayKey: string): void {
    this.setSetting(DIGEST_SENT_KEY, dayKey);
  }

  /**
   * Whether to hold reminders over Shabbat and chagim (PLAN §6.13).
   *
   * Off unless explicitly stored. Observance is not something to assume, and a
   * held reminder is one that arrives late — the wrong trade for anyone who did
   * not ask for it.
   */
  restHoldEnabled(): boolean {
    return this.getSetting(REST_HOLD_KEY) === 'on';
  }

  setRestHold(enabled: boolean): void {
    if (!enabled) {
      this.sql.exec('DELETE FROM settings WHERE key = ?', REST_HOLD_KEY);
      return;
    }
    this.setSetting(REST_HOLD_KEY, 'on');
  }

  // -- outbound (PLAN §6.8) ---------------------------------------------------
  //
  // A 200 from the Cloud API means *accepted*, not *delivered*. It answers with
  // a valid wamid for messages that never arrive — most famously while the app
  // is still in Development mode, but also on re-engagement and undeliverable
  // errors. So every send is written down here and the delivery status webhook
  // is what moves it forward.

  /** One row per message that left the system. Never its text. */
  recordOutbound(record: OutboundRecord): void {
    this.sql.exec(
      `INSERT INTO outbound_messages
         (wamid, kind, sent_at, delivery_status, principal, reminder_id)
       VALUES (?, ?, ?, 'accepted', ?, ?)
       ON CONFLICT(wamid) DO NOTHING`,
      record.wamid,
      record.kind,
      record.sentAt,
      record.principal ?? null,
      record.reminderId ?? null,
    );
  }

  /**
   * Apply a delivery status webhook.
   *
   * Statuses arrive out of order — `delivered` can land before the `sent` that
   * preceded it — so progress only ever moves forward. `failed` is the one
   * exception and always wins: a message that failed did not later succeed, and
   * a late `sent` must not hide it.
   *
   * Returns the row's reminder id when the message has now failed, which is the
   * caller's cue to reschedule it. Null in every other case.
   */
  applyDeliveryStatus(update: DeliveryUpdate): { failedReminderId: string | null } {
    const row = this.sql.exec(
      'SELECT delivery_status, reminder_id FROM outbound_messages WHERE wamid = ?',
      update.wamid,
    )[0];

    // A status for a message we have no record of. It is not an error — a
    // redeploy loses nothing but this table is written per send, so an old
    // message can outlive its row — and there is nothing to update.
    if (!row) return { failedReminderId: null };

    const current = String(row['delivery_status'] ?? 'accepted');
    if (current === 'failed') return { failedReminderId: null };

    const incoming = update.status;
    if (incoming !== 'failed' && rank(incoming) <= rank(current)) {
      return { failedReminderId: null };
    }

    this.sql.exec(
      `UPDATE outbound_messages
       SET delivery_status = ?, status_at = ?, error_code = ?, pricing_category = COALESCE(?, pricing_category)
       WHERE wamid = ?`,
      incoming,
      update.atMs,
      update.errorCode ?? null,
      update.pricingCategory ?? null,
      update.wamid,
    );

    const reminderId = row['reminder_id'];
    return {
      failedReminderId:
        incoming === 'failed' && typeof reminderId === 'string' ? reminderId : null,
    };
  }

  /** Messages that never arrived, since a cutoff. Surfaced by `/status`. */
  undeliveredSince(cutoffMs: number): number {
    const rows = this.sql.exec(
      `SELECT COUNT(*) AS n FROM outbound_messages
       WHERE delivery_status = 'failed' AND sent_at >= ?`,
      cutoffMs,
    );
    return Number(rows[0]?.['n'] ?? 0);
  }

  getOutbound(wamid: string): SqlRow | null {
    return this.sql.exec('SELECT * FROM outbound_messages WHERE wamid = ?', wamid)[0] ?? null;
  }

  /** Outbound rows age out with the inbound ones (PLAN §6.8: 30 days). */
  purgeOutboundBefore(cutoffMs: number): void {
    this.sql.exec('DELETE FROM outbound_messages WHERE sent_at < ?', cutoffMs);
  }

  touchWindow(principal: string, atMs: number): void {
    this.sql.exec(
      `INSERT INTO window_state (principal, last_inbound_at) VALUES (?, ?)
       ON CONFLICT(principal) DO UPDATE SET last_inbound_at = MAX(excluded.last_inbound_at, window_state.last_inbound_at)`,
      principal,
      atMs,
    );
  }

  lastInboundAt(principal: string): number | null {
    const rows = this.sql.exec('SELECT last_inbound_at FROM window_state WHERE principal = ?', principal);
    const value = rows[0]?.['last_inbound_at'];
    return typeof value === 'number' ? value : null;
  }

  // -- counters and settings (PLAN §6.8, §6.9) -------------------------------

  /** Month key for the counters table, in the user's zone rather than UTC. */
  static monthKey(atMs: number, timeZone = 'Asia/Jerusalem'): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
    }).formatToParts(new Date(atMs));
    const year = parts.find((p) => p.type === 'year')?.value ?? '0000';
    const month = parts.find((p) => p.type === 'month')?.value ?? '00';
    return `${year}-${month}`;
  }

  /**
   * Day key for counters that reset daily, in the user's zone.
   *
   * The `counters` table's key column is named `month` for historical reasons
   * but holds a *period* key: a month for the message budget, a day for the
   * NLU fallback count that `/status` reports. One table, two periods, no
   * migration — the keys cannot collide, since they are different lengths.
   */
  static dayKey(atMs: number, timeZone = 'Asia/Jerusalem'): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(atMs));
  }

  /** The most recent error code, for `/status`. Never an error message. */
  lastErrorCode(): string | null {
    return this.getSetting('last_error_code');
  }

  setLastErrorCode(code: string, atMs?: number): void {
    this.setSetting('last_error_code', code.slice(0, 64));
    if (atMs !== undefined) this.setSetting('last_error_at', String(Math.round(atMs)));
  }

  /** The most recent error code and when, for the quota screen (2026-10-01). */
  lastError(): { code: string; at: number | null } | null {
    const code = this.lastErrorCode();
    if (code === null) return null;
    const at = Number(this.getSetting('last_error_at'));
    return { code, at: Number.isFinite(at) && at > 0 ? at : null };
  }

  /** Add to a counter for the given period, creating the row if needed. */
  bumpCounter(month: string, field: 'wa_sent' | 'llm_calls' | 'llm_tokens' | 'fallbacks', by = 1): number {
    this.sql.exec(
      `INSERT INTO counters (month, wa_sent, llm_calls, llm_tokens, fallbacks)
       VALUES (?, 0, 0, 0, 0)
       ON CONFLICT(month) DO NOTHING`,
      month,
    );
    const rows = this.sql.exec(
      `UPDATE counters SET ${field} = ${field} + ? WHERE month = ? RETURNING ${field} AS value`,
      by,
      month,
    );
    const value = rows[0]?.['value'];
    return typeof value === 'number' ? value : 0;
  }

  counters(month: string): { waSent: number; llmCalls: number; llmTokens: number; fallbacks: number } {
    const row = this.sql.exec('SELECT * FROM counters WHERE month = ?', month)[0];
    return {
      waSent: Number(row?.['wa_sent'] ?? 0),
      llmCalls: Number(row?.['llm_calls'] ?? 0),
      llmTokens: Number(row?.['llm_tokens'] ?? 0),
      fallbacks: Number(row?.['fallbacks'] ?? 0),
    };
  }

  /** `/pause` and `/resume`. Stored, so it survives a redeploy. */
  isPaused(): boolean {
    return this.getSetting('paused') === '1';
  }

  setPaused(paused: boolean): void {
    this.setSetting('paused', paused ? '1' : '0');
  }

  /**
   * How often a tool has run recently, for the policy engine's rate limits.
   *
   * Counted from the audit log rather than a separate counter, so the number
   * the limiter sees is the same one an audit would show. Only actions that
   * actually happened count: a refused or unconfirmed request is not usage.
   */
  toolUsage(principal: string, tool: string, nowMs: number): { perHour: number; perDay: number } {
    const rows = this.sql.exec(
      `SELECT
         SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS per_hour,
         COUNT(*) AS per_day
       FROM audit_log
       WHERE principal = ? AND tool = ? AND outcome = 'ok' AND ts >= ?`,
      nowMs - 60 * 60 * 1000,
      principal,
      tool,
      nowMs - 24 * 60 * 60 * 1000,
    );
    const row = rows[0];
    return {
      perHour: Number(row?.['per_hour'] ?? 0),
      perDay: Number(row?.['per_day'] ?? 0),
    };
  }

  audit(entry: {
    ts: number;
    principal?: string | null;
    tool?: string | null;
    tier?: number | null;
    decision: string;
    inputDigest?: string | null;
    outcome?: string | null;
    externalRef?: string | null;
  }): void {
    this.sql.exec(
      `INSERT INTO audit_log (ts, principal, tool, tier, decision, input_digest, outcome, external_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.ts,
      entry.principal ?? null,
      entry.tool ?? null,
      entry.tier ?? null,
      entry.decision,
      entry.inputDigest ?? null,
      entry.outcome ?? null,
      entry.externalRef ?? null,
    );
  }
}

/** Split a migration file into statements. Migrations contain no `;` inside literals. */
function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => stripComments(statement).length > 0);
}

function stripComments(sql: string): string {
  return sql.replace(/--.*/g, '').trim();
}

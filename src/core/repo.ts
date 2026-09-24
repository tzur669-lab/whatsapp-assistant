/**
 * Data access over `SqlDriver`. Plain TypeScript: no Cloudflare imports, so it
 * runs unchanged on the Node Plan B (PLAN §3.4) and in unit tests.
 */
import type { SqlDriver, SqlRow } from './sql.js';

const SCHEMA_VERSION_KEY = 'schema_version';

export type InboundRecord = {
  wamid: string;
  principal: string;
  receivedAt: number;
  sentAt: number;
  kind: string;
};

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
      for (const statement of splitStatements(migration.sql)) {
        this.sql.exec(statement);
      }
      this.setSetting(SCHEMA_VERSION_KEY, String(migration.id));
    }
    return this.schemaVersion();
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
    return rows.length > 0;
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

  getInbound(wamid: string): SqlRow | null {
    return this.sql.exec('SELECT * FROM inbound_messages WHERE wamid = ?', wamid)[0] ?? null;
  }

  /** Purge inbound records past their retention window (PLAN §6.8: 30 days). */
  purgeInboundBefore(cutoffMs: number): void {
    this.sql.exec('DELETE FROM inbound_messages WHERE received_at < ?', cutoffMs);
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

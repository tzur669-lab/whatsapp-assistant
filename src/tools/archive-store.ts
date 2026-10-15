/**
 * Mail cleanup's store (block L, L5, 2026-10-15). See migration 0040 for the
 * two axes (`op`, `label_state`), the execution fence and the restore lease.
 *
 * Every move is one conditional UPDATE. An archive's own writes require
 * `op = 'pending'`; nothing else changes `op` while its fence holds, because
 * `/unarchive` and the cleanup both refuse a fenced row in their own
 * conditions — re-checked inside the UPDATE, so no select-then-act gap.
 */
import type { SqlDriver, SqlRow } from '../core/sql.js';

/** How long a running archive fences its row: far beyond any write's time (`agent/limits.ts`). */
export const ARCHIVE_FENCE_MS = 5 * 60 * 1000;
/** `/unarchive`'s lease. */
export const RESTORE_LEASE_MS = 5 * 60 * 1000;
/** How long a batch can be restored, and how long its message ids are kept. */
export const ARCHIVE_UNDO_MS = 7 * 24 * 60 * 60 * 1000;
/** An uncertain label create is looked for this long before it is taken as never made. */
export const LABEL_RECONCILE_MS = 24 * 60 * 60 * 1000;
export const LABEL_PREFIX = 'בוט/ארכוב-';
export const MAX_CLEANUPS_PER_TICK = 3;
/** Cleanup failures before one warning; retries go on daily after it. */
export const CLEANUP_WARN_AFTER = 10;

export type ArchiveOp = 'pending' | 'done' | 'failed' | 'restored';
export type LabelState = 'unknown' | 'present' | 'none' | 'deleted' | 'kept';

export type ArchiveBatch = {
  id: string;
  createdAt: number;
  ids: string[] | null;
  op: ArchiveOp;
  execUntil: number | null;
  labelName: string;
  labelId: string | null;
  labelState: LabelState;
  cleanupAttempts: number;
};

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function batchOf(row: SqlRow): ArchiveBatch {
  let ids: string[] | null = null;
  if (typeof row['ids_json'] === 'string') {
    try {
      const parsed = JSON.parse(row['ids_json']) as unknown;
      ids = Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
    } catch {
      ids = null;
    }
  }
  return {
    id: String(row['id']),
    createdAt: Number(row['created_at']),
    ids,
    op: String(row['op']) as ArchiveOp,
    execUntil: row['exec_until'] === null || row['exec_until'] === undefined ? null : Number(row['exec_until']),
    labelName: String(row['label_name']),
    labelId: typeof row['label_id'] === 'string' ? row['label_id'] : null,
    labelState: String(row['label_state']) as LabelState,
    cleanupAttempts: Number(row['cleanup_attempts']),
  };
}

/** Whether a stored name is one the bot generated: the only labels it ever touches. */
export function isBotLabel(name: string): boolean {
  return name.startsWith(LABEL_PREFIX) && /^[0-9a-f]{8}$/.test(name.slice(LABEL_PREFIX.length));
}

export class ArchiveStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** Step 1 of an archive: the row, before any Gmail call, fenced. */
  begin(principal: string, ids: readonly string[]): ArchiveBatch {
    const now = this.now();
    const id = randomHex(16);
    const labelName = `${LABEL_PREFIX}${randomHex(4)}`;
    this.sql.exec(
      `INSERT INTO mail_archives (id, principal, created_at, ids_json, op, exec_until, label_name, label_state)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, 'unknown')`,
      id,
      principal,
      now,
      JSON.stringify(ids),
      now + ARCHIVE_FENCE_MS,
      labelName,
    );
    return { id, createdAt: now, ids: [...ids], op: 'pending', execUntil: now + ARCHIVE_FENCE_MS, labelName, labelId: null, labelState: 'unknown', cleanupAttempts: 0 };
  }

  /** The label exists, with this id. */
  labelCreated(id: string, labelId: string): void {
    this.sql.exec("UPDATE mail_archives SET label_id = ?, label_state = 'present' WHERE id = ? AND label_state = 'unknown'", labelId, id);
  }

  /** Google answered the create with an error: no label was made. */
  labelNotCreated(id: string): void {
    this.sql.exec("UPDATE mail_archives SET label_state = 'none' WHERE id = ? AND label_state = 'unknown' AND label_id IS NULL", id);
  }

  /** The archive's outcome, written by the archive itself; it lifts the fence. */
  settle(id: string, op: 'done' | 'failed' | 'pending'): void {
    this.sql.exec("UPDATE mail_archives SET op = ?, exec_until = NULL WHERE id = ? AND op = 'pending'", op, id);
  }

  get(id: string): ArchiveBatch | null {
    const row = this.sql.exec('SELECT * FROM mail_archives WHERE id = ?', id)[0];
    return row ? batchOf(row) : null;
  }

  /** The newest retained batch of this principal, whatever its state. */
  newest(principal: string): ArchiveBatch | null {
    const row = this.sql.exec('SELECT * FROM mail_archives WHERE principal = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', principal)[0];
    return row ? batchOf(row) : null;
  }

  /** A pending batch whose archive died before it had a label: nothing was archived. Fence re-checked. */
  failOrphan(id: string): boolean {
    return (
      this.sql.exec(
        `UPDATE mail_archives SET op = 'failed', exec_until = NULL
         WHERE id = ? AND op = 'pending' AND label_id IS NULL AND (exec_until IS NULL OR exec_until < ?) RETURNING id`,
        id,
        this.now(),
      ).length === 1
    );
  }

  /** `/unarchive`'s claim: not fenced, not done already, lease free. */
  claimRestore(id: string): string | null {
    const now = this.now();
    const token = randomHex(16);
    const claimed = this.sql.exec(
      `UPDATE mail_archives SET claim_at = ?, claim_token = ?
       WHERE id = ? AND op IN ('done', 'pending') AND label_id IS NOT NULL
         AND (exec_until IS NULL OR exec_until < ?)
         AND (claim_at IS NULL OR claim_at < ?)
       RETURNING id`,
      now,
      token,
      id,
      now,
      now - RESTORE_LEASE_MS,
    ).length;
    return claimed === 1 ? token : null;
  }

  releaseRestore(id: string, token: string): void {
    this.sql.exec('UPDATE mail_archives SET claim_at = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?', id, token);
  }

  /** Restored: `op` moves once, under this claim; the label is due for cleanup now. */
  finishRestore(id: string, token: string): boolean {
    const now = this.now();
    return (
      this.sql.exec(
        `UPDATE mail_archives SET op = 'restored', restored_at = ?, claim_at = NULL, claim_token = NULL, next_cleanup_at = ?
         WHERE id = ? AND claim_token = ? RETURNING id`,
        now,
        now,
        id,
        token,
      ).length === 1
    );
  }

  /** The user deleted the label in Gmail: nothing to restore by; `op` unchanged. */
  labelGone(id: string, token: string): void {
    this.sql.exec(
      "UPDATE mail_archives SET label_state = 'deleted', claim_at = NULL, claim_token = NULL WHERE id = ? AND claim_token = ?",
      id,
      token,
    );
  }

  /** Rows whose label needs cleaning now, outside any fence, at most `MAX_CLEANUPS_PER_TICK`. */
  cleanupDue(): ArchiveBatch[] {
    const now = this.now();
    return this.sql
      .exec(
        `SELECT * FROM mail_archives
         WHERE label_state IN ('present', 'unknown')
           AND (exec_until IS NULL OR exec_until < ?)
           AND (claim_at IS NULL OR claim_at < ?)
           AND (op IN ('restored', 'failed') OR created_at < ?)
           AND (next_cleanup_at IS NULL OR next_cleanup_at <= ?)
         ORDER BY created_at LIMIT ?`,
        now,
        now - RESTORE_LEASE_MS,
        now - ARCHIVE_UNDO_MS,
        now,
        MAX_CLEANUPS_PER_TICK,
      )
      .map(batchOf);
  }

  /** The cleanup's outcome for one row. A failure backs off, doubling up to a day. */
  cleanupResult(id: string, result: { kind: 'state'; state: 'deleted' | 'kept' | 'none' | 'present'; labelId?: string } | { kind: 'failed' } | { kind: 'wait' }): number {
    const now = this.now();
    if (result.kind === 'state') {
      this.sql.exec(
        'UPDATE mail_archives SET label_state = ?, label_id = COALESCE(?, label_id), cleanup_attempts = 0, next_cleanup_at = NULL WHERE id = ?',
        result.state,
        result.labelId ?? null,
        id,
      );
      return 0;
    }
    if (result.kind === 'wait') {
      this.sql.exec('UPDATE mail_archives SET next_cleanup_at = ? WHERE id = ?', now + 60 * 60 * 1000, id);
      return 0;
    }
    const row = this.sql.exec('UPDATE mail_archives SET cleanup_attempts = cleanup_attempts + 1 WHERE id = ? RETURNING cleanup_attempts', id)[0];
    const attempts = Number(row?.['cleanup_attempts'] ?? 1);
    const backoff = Math.min(2 ** attempts * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
    this.sql.exec('UPDATE mail_archives SET next_cleanup_at = ? WHERE id = ?', now + backoff, id);
    return attempts;
  }

  /** The user renamed the label: kept, never deleted, and the one notice queued in the same transaction. */
  markKept(id: string, notice: () => void): void {
    this.sql.transaction(() => {
      const moved = this.sql.exec(
        "UPDATE mail_archives SET label_state = 'kept', next_cleanup_at = NULL WHERE id = ? AND label_state = 'present' RETURNING id",
        id,
      ).length;
      if (moved === 1) notice();
    });
  }

  /**
   * Retention: message ids go at 7 days whatever else is pending; a row goes
   * once its 7 days passed and its label is settled. Returns rows deleted.
   */
  purge(): number {
    const cutoff = this.now() - ARCHIVE_UNDO_MS;
    this.sql.exec('UPDATE mail_archives SET ids_json = NULL WHERE created_at < ? AND ids_json IS NOT NULL', cutoff);
    return this.sql.exec(
      "DELETE FROM mail_archives WHERE created_at < ? AND label_state IN ('none', 'deleted', 'kept') RETURNING id",
      cutoff,
    ).length;
  }
}

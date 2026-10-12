/**
 * Routines on the server (PLAN §6.27, stage 2): the names the paired app
 * synced, and the runs scheduled for them.
 *
 * The server never holds a routine's steps. It holds the user's name for one,
 * its app's label, and the SHA-256 of its steps (`stepHash`), and it
 * authorizes exactly one run per confirmed request:
 *
 *   scheduled -> noticed (two minutes before, a cancel button)
 *             -> pushed (at the due time, the phone is woken)
 *             -> claimed (the phone's signed claim, once)
 *             -> done | unverified | failed | unknown
 *   or        -> cancelled | expired | changed
 *
 * Every step is one conditional UPDATE inside a synchronous transaction, so a
 * second push, a second claim or a late cancel finds the row already moved
 * on. Authorizing a run once is all the server can promise; the phone keeps
 * its own record and never runs a claimed run again.
 *
 * Synchronous over `SqlDriver`; no platform imports (invariant 11).
 */
import type { SqlDriver } from '../core/sql.js';
import { sha256Hex } from '../confirm/pending.js';
import { timingSafeEqualHex } from '../security/hmac.js';

export const MAX_ROUTINES = 20;
export const MAX_ROUTINE_NAME = 40;
export const MAX_APP_LABEL = 60;
/** How far ahead a run may be scheduled (decision D4, the user's choice: 7 days). */
export const ROUTINE_HORIZON_MS = 7 * 24 * 60 * 60_000;
/** The notice with the cancel button comes this long before the run. */
export const ROUTINE_NOTICE_MS = 2 * 60_000;
/** A run later than this is not run at all: a punch an hour late is wrong (invariant 12). */
export const ROUTINE_MAX_LATE_MS = 10 * 60_000;
/** A pushed run the phone has not claimed is pushed once more after this. */
export const ROUTINE_REPUSH_MS = 60_000;
/**
 * A claimed run with no result after this is reported as unknown. Longer than
 * the phone's own deadline (4 minutes of steps) plus the time to report.
 */
export const ROUTINE_STALE_CLAIM_MS = 10 * 60_000;

export type RunStatus =
  | 'scheduled'
  | 'noticed'
  | 'pushed'
  | 'claimed'
  | 'done'
  | 'unverified'
  | 'failed'
  | 'unknown'
  | 'cancelled'
  | 'expired'
  | 'changed';

/** What the phone says happened. Codes only, never screen text. */
export type RunOutcome = 'verified' | 'tapped_unverified' | 'failed_before_tap' | 'failed_after_tap' | 'blocked' | 'changed';

export type RoutineName = {
  routineId: string;
  name: string;
  stepHash: string;
  appLabel: string;
  /** Its place in the phone's list, from 1 (`names` only; 2026-10-12). */
  number?: number;
};

export type Run = {
  runId: string;
  principal: string;
  routineId: string;
  name: string;
  appLabel: string;
  stepHash: string;
  dueAtUtc: number;
  tz: string;
  status: RunStatus;
  reason: string | null;
};

/** What `claim` returns: the run's routine, or why not. */
export type ClaimResult =
  | { ok: true; routineId: string; stepHash: string }
  | { ok: false; reason: 'not_found' | 'cancelled' | 'late' | 'already' | 'changed' };

export type CancelResult = 'cancelled' | 'started' | 'gone';

/** The outcome as stored, and whether it settled a run that was `unknown` already. */
export type SettleResult = { run: Run; status: RunStatus; wasUnknown: boolean } | null;

const OPEN: readonly RunStatus[] = ['scheduled', 'noticed', 'pushed'];

export class RoutineStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number = Date.now,
  ) {}

  // -- names -----------------------------------------------------------------

  names(principal: string): RoutineName[] {
    return this.sql
      .exec(
        // The phone's order; a row from before 0029 (no position yet) last.
        `SELECT routine_id, name, step_hash, app_label FROM routine_names WHERE principal = ?
         ORDER BY position IS NULL, position, name LIMIT ?`,
        principal,
        MAX_ROUTINES,
      )
      .map((row, index) => ({
        routineId: String(row['routine_id']),
        name: String(row['name']),
        stepHash: String(row['step_hash']),
        appLabel: String(row['app_label']),
        number: index + 1,
      }));
  }

  /**
   * The phone's whole list replaces the stored one. A run still waiting whose
   * routine is gone or whose steps changed is closed now, as `changed`, and
   * returned so the user hears it now rather than at the due time.
   */
  replaceNames(principal: string, list: readonly RoutineName[]): Run[] {
    const now = this.now();
    return this.sql.transaction(() => {
      this.sql.exec(`DELETE FROM routine_names WHERE principal = ?`, principal);
      list.slice(0, MAX_ROUTINES).forEach((item, position) => {
        this.sql.exec(
          `INSERT OR REPLACE INTO routine_names (principal, routine_id, name, step_hash, app_label, position, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          principal,
          item.routineId,
          item.name,
          item.stepHash,
          item.appLabel,
          position,
          now,
        );
      });
      const current = new Map(list.map((item) => [item.routineId, item.stepHash]));
      const changed = this.open(principal).filter((run) => current.get(run.routineId) !== run.stepHash);
      for (const run of changed) this.move(run.runId, OPEN, 'changed', now);
      return changed.map((run) => ({ ...run, status: 'changed' as const }));
    });
  }

  // -- runs ------------------------------------------------------------------

  /**
   * A confirmed run. Its cancel nonces are made with its card
   * (`takeAnnouncements`) and its notice (`takeNotices`); until then the
   * stored hash is of a nonce nobody holds.
   */
  schedule(params: {
    principal: string;
    routine: RoutineName;
    dueAtUtc: number;
    tz: string;
  }): { run: Run } {
    const runId = randomHex(16);
    const nonce = randomHex(16);
    const now = this.now();
    this.sql.exec(
      `INSERT INTO routine_runs
         (run_id, principal, routine_id, name, app_label, step_hash, due_at_utc, tz, cancel_hash, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`,
      runId,
      params.principal,
      params.routine.routineId,
      params.routine.name,
      params.routine.appLabel,
      params.routine.stepHash,
      params.dueAtUtc,
      params.tz,
      digest(nonce),
      now,
    );
    return {
      run: {
        runId,
        principal: params.principal,
        routineId: params.routine.routineId,
        name: params.routine.name,
        appLabel: params.routine.appLabel,
        stepHash: params.routine.stepHash,
        dueAtUtc: params.dueAtUtc,
        tz: params.tz,
        status: 'scheduled',
        reason: null,
      },
    };
  }

  get(runId: string): Run | null {
    const row = this.sql.exec(`SELECT * FROM routine_runs WHERE run_id = ?`, runId)[0];
    return row ? runOf(row) : null;
  }

  /** Runs not yet claimed, soonest first. */
  open(principal: string): Run[] {
    return this.sql
      .exec(
        `SELECT * FROM routine_runs WHERE principal = ? AND status IN ('scheduled', 'noticed', 'pushed') ORDER BY due_at_utc`,
        principal,
      )
      .map(runOf);
  }

  /**
   * The cancel button. Its nonce is checked against the stored hash; a run the
   * phone already claimed is not stopped, and says so.
   */
  cancel(runId: string, nonce: string, principal: string): CancelResult {
    return this.sql.transaction(() => {
      const row = this.sql.exec(`SELECT * FROM routine_runs WHERE run_id = ? AND principal = ?`, runId, principal)[0];
      if (!row) return 'gone';
      // The card's button or the notice's: both compared, always.
      const given = digest(nonce);
      const byCard = timingSafeEqualHex(String(row['cancel_hash']), given);
      const noticeHash = row['notice_hash'];
      const byNotice = typeof noticeHash === 'string' && timingSafeEqualHex(noticeHash, given);
      if (!byCard && !byNotice) return 'gone';
      const status = String(row['status']) as RunStatus;
      if (status === 'claimed') return 'started';
      return this.move(runId, OPEN, 'cancelled', this.now()) ? 'cancelled' : 'gone';
    });
  }

  /**
   * Runs that need their card now (2026-10-12): scheduled, not announced, and
   * due later than the notice window — a sooner one gets the notice at once,
   * which carries the button. Each is marked once, with a fresh nonce for the
   * card's cancel button (only its hash kept), and its number in the list.
   */
  takeAnnouncements(now: number): { run: Run; nonce: string; number: number | null }[] {
    return this.sql.transaction(() => {
      const rows = this.sql
        .exec(
          `SELECT * FROM routine_runs WHERE status = 'scheduled' AND announced_at IS NULL AND due_at_utc - ? > ?`,
          ROUTINE_NOTICE_MS,
          now,
        )
        .map(runOf);
      const cards: { run: Run; nonce: string; number: number | null }[] = [];
      for (const run of rows) {
        const nonce = randomHex(16);
        const moved = this.sql.exec(
          `UPDATE routine_runs SET announced_at = ?, cancel_hash = ?
           WHERE run_id = ? AND status = 'scheduled' AND announced_at IS NULL RETURNING run_id`,
          now,
          digest(nonce),
          run.runId,
        );
        if (moved.length === 0) continue;
        const number = this.names(run.principal).find((r) => r.routineId === run.routineId)?.number ?? null;
        cards.push({ run, nonce, number });
      }
      return cards;
    });
  }

  /**
   * Runs whose notice is due now: moved to `noticed` and returned once, each
   * with a fresh nonce for its cancel button — only the nonce's hash is kept,
   * beside the card's, so the card's button still works.
   */
  takeNotices(now: number): { run: Run; nonce: string }[] {
    return this.sql.transaction(() => {
      const rows = this.sql
        .exec(
          `SELECT * FROM routine_runs WHERE status = 'scheduled' AND due_at_utc - ? <= ? AND due_at_utc > ?`,
          ROUTINE_NOTICE_MS,
          now,
          now,
        )
        .map(runOf);
      const notices: { run: Run; nonce: string }[] = [];
      for (const run of rows) {
        const nonce = randomHex(16);
        const moved = this.sql.exec(
          `UPDATE routine_runs SET status = 'noticed', notice_hash = ? WHERE run_id = ? AND status = 'scheduled' RETURNING run_id`,
          digest(nonce),
          run.runId,
        );
        if (moved.length > 0) notices.push({ run: { ...run, status: 'noticed' }, nonce });
      }
      return notices;
    });
  }

  /**
   * Runs due now. Each is moved once: to `pushed`, or to `expired` when it is
   * more than ten minutes late (held by Shabbat, or the Worker was down).
   */
  takeDue(now: number): { push: Run[]; expired: Run[] } {
    return this.sql.transaction(() => {
      const rows = this.sql
        .exec(`SELECT * FROM routine_runs WHERE status IN ('scheduled', 'noticed') AND due_at_utc <= ?`, now)
        .map(runOf);
      const push: Run[] = [];
      const expired: Run[] = [];
      for (const run of rows) {
        if (now - run.dueAtUtc > ROUTINE_MAX_LATE_MS) {
          if (this.move(run.runId, ['scheduled', 'noticed'], 'expired', now)) expired.push({ ...run, status: 'expired' });
          continue;
        }
        const moved = this.sql.exec(
          `UPDATE routine_runs SET status = 'pushed', pushed_at = ? WHERE run_id = ? AND status IN ('scheduled', 'noticed') RETURNING run_id`,
          now,
          run.runId,
        );
        if (moved.length > 0) push.push({ ...run, status: 'pushed' });
      }
      return { push, expired };
    });
  }

  /**
   * Pushed runs the phone has not claimed: once a minute they are pushed
   * again, and past the ten minutes they expire.
   */
  takeUnclaimed(now: number): { repush: Run[]; expired: Run[] } {
    return this.sql.transaction(() => {
      const rows = this.sql.exec(`SELECT * FROM routine_runs WHERE status = 'pushed'`).map((row) => ({
        run: runOf(row),
        pushedAt: Number(row['pushed_at'] ?? 0),
      }));
      const repush: Run[] = [];
      const expired: Run[] = [];
      for (const { run, pushedAt } of rows) {
        if (now - run.dueAtUtc > ROUTINE_MAX_LATE_MS) {
          if (this.move(run.runId, ['pushed'], 'expired', now)) expired.push({ ...run, status: 'expired' });
        } else if (now - pushedAt >= ROUTINE_REPUSH_MS) {
          this.sql.exec(`UPDATE routine_runs SET pushed_at = ? WHERE run_id = ? AND status = 'pushed'`, now, run.runId);
          repush.push(run);
        }
      }
      return { repush, expired };
    });
  }

  /**
   * The phone's claim, once (PLAN §6.27): the run is pushed, not late, and its
   * routine is still the one confirmed — same id, same steps, still synced.
   */
  claim(runId: string, principal: string): ClaimResult {
    const now = this.now();
    return this.sql.transaction((): ClaimResult => {
      const row = this.sql.exec(`SELECT * FROM routine_runs WHERE run_id = ? AND principal = ?`, runId, principal)[0];
      if (!row) return { ok: false, reason: 'not_found' };
      const run = runOf(row);
      if (run.status === 'cancelled') return { ok: false, reason: 'cancelled' };
      if (run.status !== 'pushed') return { ok: false, reason: run.status === 'expired' ? 'late' : 'already' };
      if (now - run.dueAtUtc > ROUTINE_MAX_LATE_MS) {
        this.move(runId, ['pushed'], 'expired', now);
        return { ok: false, reason: 'late' };
      }
      const synced = this.sql.exec(
        `SELECT step_hash FROM routine_names WHERE principal = ? AND routine_id = ?`,
        principal,
        run.routineId,
      )[0];
      if (!synced || String(synced['step_hash']) !== run.stepHash) {
        this.move(runId, ['pushed'], 'changed', now);
        return { ok: false, reason: 'changed' };
      }
      const moved = this.sql.exec(
        `UPDATE routine_runs SET status = 'claimed', claimed_at = ? WHERE run_id = ? AND status = 'pushed' RETURNING run_id`,
        now,
        runId,
      );
      return moved.length > 0 ? { ok: true, routineId: run.routineId, stepHash: run.stepHash } : { ok: false, reason: 'already' };
    });
  }

  /**
   * What the phone reports. Settles a claimed run once; a run the sweep called
   * `unknown` takes a late result too, so the user hears what really happened.
   * A refusal before the claim (the phone was locked) settles a pushed run.
   */
  settle(runId: string, principal: string, outcome: RunOutcome, reason: string | null): SettleResult {
    const now = this.now();
    return this.sql.transaction((): SettleResult => {
      const row = this.sql.exec(`SELECT * FROM routine_runs WHERE run_id = ? AND principal = ?`, runId, principal)[0];
      if (!row) return null;
      const run = runOf(row);
      const from: RunStatus[] = outcome === 'blocked' || outcome === 'changed' ? ['pushed', 'claimed'] : ['claimed', 'unknown'];
      if (!from.includes(run.status)) return null;
      const status = statusOf(outcome);
      const moved = this.sql.exec(
        `UPDATE routine_runs SET status = ?, reason = ?, settled_at = ? WHERE run_id = ? AND status = ? RETURNING run_id`,
        status,
        reason,
        now,
        runId,
        run.status,
      );
      if (moved.length === 0) return null;
      return { run: { ...run, status, reason }, status, wasUnknown: run.status === 'unknown' };
    });
  }

  /** Claimed runs that never reported: `unknown`, returned once. */
  takeStaleClaims(now: number): Run[] {
    return this.sql.transaction(() => {
      const rows = this.sql
        .exec(`SELECT * FROM routine_runs WHERE status = 'claimed' AND claimed_at <= ?`, now - ROUTINE_STALE_CLAIM_MS)
        .map(runOf);
      return rows.filter((run) => this.move(run.runId, ['claimed'], 'unknown', now)).map((run) => ({ ...run, status: 'unknown' as const }));
    });
  }

  /** The next time the alarm must look at the runs, or null. */
  nextWakeAt(): number | null {
    const at = (query: string, ...bindings: unknown[]): number | null => {
      const value = this.sql.exec(query, ...bindings)[0]?.['at'];
      return typeof value === 'number' ? value : null;
    };
    const now = this.now();
    const candidates = [
      // A card still owed: now.
      at(
        `SELECT MIN(?) AS at FROM routine_runs WHERE status = 'scheduled' AND announced_at IS NULL AND due_at_utc - ? > ?`,
        now,
        ROUTINE_NOTICE_MS,
        now,
      ),
      at(`SELECT MIN(due_at_utc - ?) AS at FROM routine_runs WHERE status = 'scheduled'`, ROUTINE_NOTICE_MS),
      at(`SELECT MIN(due_at_utc) AS at FROM routine_runs WHERE status IN ('scheduled', 'noticed')`),
      at(`SELECT MIN(pushed_at + ?) AS at FROM routine_runs WHERE status = 'pushed'`, ROUTINE_REPUSH_MS),
      at(`SELECT MIN(claimed_at + ?) AS at FROM routine_runs WHERE status = 'claimed'`, ROUTINE_STALE_CLAIM_MS),
    ].filter((value): value is number => value !== null);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  /** Settled runs are kept a week, for the audit's sake, then dropped. */
  purgeOld(now: number): void {
    this.sql.exec(
      `DELETE FROM routine_runs WHERE status NOT IN ('scheduled', 'noticed', 'pushed', 'claimed') AND created_at < ?`,
      now - 7 * 24 * 60 * 60_000,
    );
  }

  private move(runId: string, from: readonly RunStatus[], to: RunStatus, now: number): boolean {
    const placeholders = from.map(() => '?').join(', ');
    return (
      this.sql.exec(
        `UPDATE routine_runs SET status = ?, settled_at = ? WHERE run_id = ? AND status IN (${placeholders}) RETURNING run_id`,
        to,
        now,
        runId,
        ...from,
      ).length > 0
    );
  }
}

function statusOf(outcome: RunOutcome): RunStatus {
  switch (outcome) {
    case 'verified':
      return 'done';
    case 'tapped_unverified':
      return 'unverified';
    case 'failed_after_tap':
      return 'unknown';
    case 'changed':
      return 'changed';
    case 'failed_before_tap':
    case 'blocked':
      return 'failed';
  }
}

function runOf(row: Record<string, unknown>): Run {
  return {
    runId: String(row['run_id']),
    principal: String(row['principal']),
    routineId: String(row['routine_id']),
    name: String(row['name']),
    appLabel: String(row['app_label']),
    stepHash: String(row['step_hash']),
    dueAtUtc: Number(row['due_at_utc']),
    tz: String(row['tz']),
    status: String(row['status']) as RunStatus,
    reason: typeof row['reason'] === 'string' ? row['reason'] : null,
  };
}

function digest(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

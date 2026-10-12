/**
 * The screen agent on the server (PLAN §6.28): the apps the user turned on for
 * it, and the tasks it runs.
 *
 * A task is one confirmed request ("search FID for סטימצקי"). The phone is the
 * eyes and hands; this store is the one place that says what step a task is
 * on and what was decided for it:
 *
 *   confirmed -> pushed -> running <-> awaiting_approval -> released -> running
 *             -> stopped | preempted | deadline | done | failed | unknown
 *
 * Every move is one conditional UPDATE inside a synchronous transaction, so a
 * stop and an approval that cross, a retried step or a second claim each find
 * the row already moved on. The store keeps no screen text: an action is codes
 * and the phone's binding, the past steps are codes, and the screen hashes are
 * the phone's SHA-256. The task's words and the approved inputs are sealed
 * (AES-GCM) and dropped when the task ends.
 *
 * Synchronous over `SqlDriver` except sealing; no platform imports (invariant 11).
 */
import type { SqlDriver, SqlRow } from '../core/sql.js';
import { decryptToken, encryptToken } from '../security/crypto.js';
import type { Keyring } from '../security/crypto.js';
import { timingSafeEqualHex } from '../security/hmac.js';
import { localPartsOf, ZONE } from '../time/tz.js';
import { classAtMost, higherClass } from '../agent/screen-policy.js';
import type { RiskClass, RiskWhy } from '../agent/screen-policy.js';

export const MAX_SCREEN_APPS = 20;
export const MAX_SCREEN_LABEL = 60;
export const MAX_SCREEN_TASK = 200;
export const MAX_SCREEN_INPUTS = 3;
export const MAX_SCREEN_INPUT = 60;
export const SCREEN_MAX_STEPS = 12;
export const SCREEN_TASKS_PER_DAY = 3;
/** From the claim to the last action. */
export const SCREEN_TASK_DEADLINE_MS = 4 * 60_000;
/** A card not answered in this long stops the task (never past the deadline). */
export const SCREEN_APPROVAL_TTL_MS = 2 * 60_000;
/** A confirmed task the phone did not claim in this long never runs. */
export const SCREEN_CLAIM_TTL_MS = 2 * 60_000;
/** After the deadline, how long the sweep waits for the phone's own report. */
export const SCREEN_DEADLINE_GRACE_MS = 30_000;
/** One step's model call may hold the task this long; a retry meanwhile waits. */
export const SCREEN_INFLIGHT_MS = 30_000;
/** No task starts when a routine run is due sooner than this (routines first). */
export const SCREEN_ROUTINE_GUARD_MS = 7 * 60_000;
/** Steps the phone could not do in a row before the task gives up. */
export const SCREEN_MAX_MISSES = 3;

export type ScreenStatus =
  | 'confirmed'
  | 'pushed'
  | 'running'
  | 'awaiting_approval'
  | 'released'
  | 'stopped'
  | 'preempted'
  | 'deadline'
  | 'done'
  | 'failed'
  | 'unknown';

export const OPEN_SCREEN_STATUSES: readonly ScreenStatus[] = ['confirmed', 'pushed', 'running', 'awaiting_approval', 'released'];

/** What the user is told the task came to. Only these reach logs. */
export type ScreenOutcome =
  | 'completed_unverified'
  | 'inconclusive'
  | 'asked'
  | 'failed_before_action'
  | 'failed_after_action'
  | 'unknown'
  | 'stopped';

/** The decided action, as the phone gets it: codes and its own binding, never screen text. */
export type ScreenAction =
  | { kind: 'tap'; b: string }
  | { kind: 'submit'; b: string }
  | { kind: 'type'; b: string; input: number }
  | { kind: 'scroll'; b: string; dir: 'fwd' | 'back' }
  | { kind: 'back' }
  | { kind: 'wait'; s: number };

/** What the phone says happened to a decided action. */
export type ReportStatus = 'dispatched' | 'not_accepted' | 'refused' | 'uncertain';
export type StepReport = { actionId: string; status: ReportStatus; reason?: string | undefined };

/** One past step, codes only: the action's kind and what the phone reported. */
export type HistoryEntry = { k: ScreenAction['kind']; r: 'd' | 'n' | 'r' | 'p'; a: string; ns?: true };

export type AllowedApp = { package: string; label: string; askEveryTap: boolean };

export type ScreenTask = {
  taskId: string;
  principal: string;
  package: string;
  appLabel: string;
  inputCount: number;
  status: ScreenStatus;
  step: number;
  actionId: string | null;
  action: (ScreenAction & { ns?: true }) | null;
  cls: RiskClass | null;
  why: RiskWhy | null;
  approvalNonce: string | null;
  approvalExpiresAt: number | null;
  maxClass: RiskClass | null;
  history: HistoryEntry[];
  typedNonSearch: boolean;
  dispatched: number;
  waits: number;
  tokens: number;
  stopNonce: string;
  outcome: ScreenOutcome | null;
  reason: string | null;
  deadlineAt: number | null;
  createdAt: number;
};

/** A task ended by a move in this store, for the one message about it. */
export type Ended = { task: ScreenTask; outcome: ScreenOutcome; reason: string };

export type ClaimResult =
  | { ok: true; task: ScreenTask; deadlineAt: number }
  | { ok: false; reason: 'not_found' | 'already' | 'late' | 'stopped' | 'not_allowed' };

/** What `beginStep` found: answer from the row, end the task, or ask the model. */
export type BeginStep =
  | { kind: 'gone' }
  | { kind: 'final'; task: ScreenTask }
  | { kind: 'stored'; task: ScreenTask }
  | { kind: 'inflight' }
  | { kind: 'ended'; ended: Ended }
  | { kind: 'proceed'; task: ScreenTask };

export type Decision =
  | { kind: 'act'; action: ScreenAction & { ns?: true }; cls: RiskClass; why: RiskWhy | null }
  | { kind: 'approval'; action: ScreenAction & { ns?: true }; cls: RiskClass; why: RiskWhy };

export type ApprovalResult =
  | { kind: 'released'; task: ScreenTask }
  | { kind: 'rejected'; ended: Ended }
  | { kind: 'already' };

const SEALED_PROVIDER = 'screen_task';

export class ScreenStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number = Date.now,
    private readonly keyring?: () => Keyring,
  ) {}

  // -- the allowlist ---------------------------------------------------------

  allowed(principal: string): AllowedApp[] {
    return this.sql
      .exec(
        `SELECT package, label, ask_every_tap FROM screen_allow WHERE principal = ? ORDER BY position LIMIT ?`,
        principal,
        MAX_SCREEN_APPS,
      )
      .map((row) => ({
        package: String(row['package']),
        label: String(row['label']),
        askEveryTap: Number(row['ask_every_tap']) === 1,
      }));
  }

  allowedApp(principal: string, pkg: string): AllowedApp | null {
    return this.allowed(principal).find((app) => app.package === pkg) ?? null;
  }

  /**
   * The phone's whole list replaces the stored one. A task still open in an
   * app no longer on it ends now, and any approval it waited for is void.
   */
  replaceAllow(principal: string, apps: readonly AllowedApp[]): Ended[] {
    const now = this.now();
    return this.sql.transaction(() => {
      this.sql.exec(`DELETE FROM screen_allow WHERE principal = ?`, principal);
      apps.slice(0, MAX_SCREEN_APPS).forEach((app, position) => {
        this.sql.exec(
          `INSERT OR REPLACE INTO screen_allow (principal, package, label, ask_every_tap, position, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          principal,
          app.package,
          app.label,
          app.askEveryTap ? 1 : 0,
          position,
          now,
        );
      });
      const kept = new Set(apps.map((app) => app.package));
      const ended: Ended[] = [];
      for (const task of this.openTasks(principal)) {
        if (kept.has(task.package)) continue;
        const done = this.end(task, 'stopped', 'app_removed', now);
        if (done) ended.push(done);
      }
      return ended;
    });
  }

  // -- creating and claiming -------------------------------------------------

  /** A confirmed task, sealed. Its stop nonce is made now and kept with it. */
  async create(params: {
    principal: string;
    package: string;
    appLabel: string;
    task: string;
    inputs: readonly string[];
  }): Promise<ScreenTask> {
    const taskId = randomHex(16);
    const keyring = this.requireKeyring();
    const sealed = await encryptToken(JSON.stringify({ task: params.task, inputs: params.inputs }), keyring, aad(taskId));
    const now = this.now();
    this.sql.exec(
      `INSERT INTO screen_tasks (task_id, principal, package, app_label, sealed, input_count, status, stop_nonce, local_day, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
      taskId,
      params.principal,
      params.package,
      params.appLabel,
      sealed,
      params.inputs.length,
      randomHex(16),
      localDay(now),
      now,
    );
    return this.get(taskId)!;
  }

  /** The task's words and inputs, or null once the task ended (or the key changed). */
  async unseal(taskId: string): Promise<{ task: string; inputs: string[] } | null> {
    const row = this.sql.exec(`SELECT sealed FROM screen_tasks WHERE task_id = ?`, taskId)[0];
    const sealed = row?.['sealed'];
    if (typeof sealed !== 'string') return null;
    try {
      const plain = JSON.parse(await decryptToken(sealed, this.requireKeyring(), aad(taskId))) as unknown;
      if (typeof plain !== 'object' || plain === null) return null;
      const { task, inputs } = plain as { task?: unknown; inputs?: unknown };
      if (typeof task !== 'string' || !Array.isArray(inputs) || !inputs.every((i) => typeof i === 'string')) return null;
      return { task, inputs: inputs as string[] };
    } catch {
      return null;
    }
  }

  get(taskId: string): ScreenTask | null {
    const row = this.sql.exec(`SELECT * FROM screen_tasks WHERE task_id = ?`, taskId)[0];
    return row ? taskOf(row) : null;
  }

  /** The open task, if there is one (there is at most one at a time). */
  active(principal: string): ScreenTask | null {
    return this.openTasks(principal)[0] ?? null;
  }

  /** Tasks confirmed on this Asia/Jerusalem day, whatever became of them. */
  countToday(principal: string): number {
    const row = this.sql.exec(
      `SELECT COUNT(*) AS n FROM screen_tasks WHERE principal = ? AND local_day = ?`,
      principal,
      localDay(this.now()),
    )[0];
    return Number(row?.['n'] ?? 0);
  }

  /** Confirmed tasks to push now, each moved once to `pushed`. */
  takePushes(): ScreenTask[] {
    const now = this.now();
    return this.sql.transaction(() => {
      const rows = this.sql.exec(`SELECT * FROM screen_tasks WHERE status = 'confirmed'`).map(taskOf);
      return rows.filter(
        (task) =>
          this.sql.exec(
            `UPDATE screen_tasks SET status = 'pushed', pushed_at = ? WHERE task_id = ? AND status = 'confirmed' RETURNING task_id`,
            now,
            task.taskId,
          ).length > 0,
      );
    });
  }

  /**
   * The phone's one claim: the task is pushed, not late, and its app is still
   * on the list. The deadline starts now.
   */
  claim(taskId: string, principal: string): ClaimResult {
    const now = this.now();
    return this.sql.transaction((): ClaimResult => {
      const task = this.row(taskId, principal);
      if (!task) return { ok: false, reason: 'not_found' };
      if (task.status !== 'pushed') {
        return { ok: false, reason: OPEN_SCREEN_STATUSES.includes(task.status) ? 'already' : 'stopped' };
      }
      const pushedAt = Number(this.sql.exec(`SELECT pushed_at FROM screen_tasks WHERE task_id = ?`, taskId)[0]?.['pushed_at'] ?? 0);
      if (now - pushedAt > SCREEN_CLAIM_TTL_MS) {
        this.end(task, 'failed', 'not_claimed', now);
        return { ok: false, reason: 'late' };
      }
      if (!this.allowedApp(principal, task.package)) {
        this.end(task, 'stopped', 'not_allowed', now);
        return { ok: false, reason: 'not_allowed' };
      }
      const deadlineAt = now + SCREEN_TASK_DEADLINE_MS;
      const moved = this.sql.exec(
        `UPDATE screen_tasks SET status = 'running', claimed_at = ?, deadline_at = ? WHERE task_id = ? AND status = 'pushed' RETURNING task_id`,
        now,
        deadlineAt,
        taskId,
      );
      if (moved.length === 0) return { ok: false, reason: 'already' };
      return { ok: true, task: this.get(taskId)!, deadlineAt };
    });
  }

  // -- steps -----------------------------------------------------------------

  /**
   * A new screen for step `step`, with the phone's report on step `step - 1`.
   * Answers a retry from the row, applies a report once, checks the deadline,
   * the step limit and the heuristics, and marks the step in flight before the
   * model is asked. One transaction: no await can split it.
   */
  beginStep(taskId: string, principal: string, step: number, hash: string, report: StepReport | undefined): BeginStep {
    const now = this.now();
    return this.sql.transaction((): BeginStep => {
      const task = this.row(taskId, principal);
      if (!task) return { kind: 'gone' };
      if (!OPEN_SCREEN_STATUSES.includes(task.status)) return { kind: 'final', task };
      if (task.status === 'confirmed' || task.status === 'pushed') return { kind: 'ended', ended: this.endOrThrow(task, 'unknown', 'protocol', now) };

      // A retry of the step already decided: the same answer, the same actionId.
      if (step === task.step && task.actionId !== null) return { kind: 'stored', task };

      // A step comes only after its predecessor was decided, and never while
      // waiting on the user: the phone must not act past a pending card.
      if (step !== task.step + 1 || task.status === 'awaiting_approval') {
        return { kind: 'ended', ended: this.endOrThrow(task, 'unknown', 'protocol', now) };
      }
      if (task.inflight !== null && task.inflight > now) return { kind: 'inflight' };

      let history = task.history;
      let dispatched = task.dispatched;
      let typedNonSearch = task.typedNonSearch;
      if (task.step > 0) {
        if (!report || report.actionId !== task.actionId) {
          return { kind: 'ended', ended: this.endOrThrow(task, 'unknown', 'protocol', now) };
        }
        if (report.status === 'uncertain') return { kind: 'ended', ended: this.endOrThrow(task, 'unknown', 'uncertain', now) };
        // Applied once: a step retried after a failed model call reports the same action.
        const last = history[history.length - 1];
        if (last && last.a === report.actionId && last.r === 'p') {
          const r = report.status === 'dispatched' ? 'd' : report.status === 'not_accepted' ? 'n' : 'r';
          history = [...history.slice(0, -1), { ...last, r }];
          if (r === 'd') {
            dispatched += 1;
            if (last.ns) typedNonSearch = true;
          }
        }
      }

      if (task.deadlineAt !== null && now > task.deadlineAt) {
        this.saveProgress(task.taskId, history, dispatched, typedNonSearch);
        return { kind: 'ended', ended: this.endOrThrow(this.get(taskId)!, 'deadline', 'deadline', now) };
      }
      if (step > SCREEN_MAX_STEPS) {
        this.saveProgress(task.taskId, history, dispatched, typedNonSearch);
        return { kind: 'ended', ended: this.endOrThrow(this.get(taskId)!, 'failed', 'step_limit', now) };
      }

      const hashes = [...task.hashes.filter((h) => h.s !== step), { s: step, h: hash }].slice(-3);
      this.sql.exec(
        `UPDATE screen_tasks SET history = ?, dispatched = ?, typed_non_search = ?, hashes = ?, inflight_until = ? WHERE task_id = ?`,
        JSON.stringify(history),
        dispatched,
        typedNonSearch ? 1 : 0,
        JSON.stringify(hashes),
        now + SCREEN_INFLIGHT_MS,
        taskId,
      );
      const fresh = this.get(taskId)!;

      // Heuristics, worded as such (PLAN §6.28): three screens alike in a row,
      // or three actions in a row the phone could not do.
      if (hashes.length === 3 && hashes.every((h) => h.h === hashes[0]!.h)) {
        return { kind: 'ended', ended: this.endOrThrow(fresh, 'unknown', 'no_effect', now) };
      }
      const tail = history.slice(-SCREEN_MAX_MISSES);
      if (tail.length === SCREEN_MAX_MISSES && tail.every((h) => h.r === 'n' || h.r === 'r')) {
        return { kind: 'ended', ended: this.endOrThrow(fresh, 'failed', 'no_progress', now) };
      }
      return { kind: 'proceed', task: fresh };
    });
  }

  /** The model call for this step could not be made now: the step is free again. */
  releaseInflight(taskId: string): void {
    this.sql.exec(`UPDATE screen_tasks SET inflight_until = NULL WHERE task_id = ?`, taskId);
  }

  /** One more wait on the lock or the bucket; returns how many so far. */
  bumpWait(taskId: string): number {
    const row = this.sql.exec(
      `UPDATE screen_tasks SET waits = waits + 1, inflight_until = NULL WHERE task_id = ? RETURNING waits`,
      taskId,
    )[0];
    return Number(row?.['waits'] ?? 0);
  }

  addTokens(taskId: string, tokens: number): void {
    if (tokens > 0) this.sql.exec(`UPDATE screen_tasks SET tokens = tokens + ? WHERE task_id = ?`, Math.ceil(tokens), taskId);
  }

  /**
   * Store step `step`'s decision, once, and only while the task is still
   * running: a stop that came in during the model call wins. An approval gets
   * its nonce and expiry here.
   */
  decide(taskId: string, step: number, decision: Decision): ScreenTask | null {
    const now = this.now();
    return this.sql.transaction(() => {
      const task = this.get(taskId);
      if (!task || (task.status !== 'running' && task.status !== 'released') || task.step !== step - 1) return null;
      const actionId = randomHex(16);
      const history = [...task.history, historyEntry(decision.action, actionId)];
      const approval = decision.kind === 'approval';
      const nonce = approval ? randomHex(16) : null;
      const expires = approval ? Math.min(now + SCREEN_APPROVAL_TTL_MS, task.deadlineAt ?? now + SCREEN_APPROVAL_TTL_MS) : null;
      const moved = this.sql.exec(
        `UPDATE screen_tasks SET status = ?, step = ?, action_id = ?, action = ?, cls = ?, why = ?,
           approval_nonce = ?, approval_expires_at = ?, max_class = ?, history = ?, inflight_until = NULL
         WHERE task_id = ? AND status IN ('running', 'released') AND step = ? RETURNING task_id`,
        approval ? 'awaiting_approval' : 'running',
        step,
        actionId,
        JSON.stringify(decision.action),
        decision.cls,
        decision.why,
        nonce,
        expires,
        approval ? decision.cls : null,
        JSON.stringify(history),
        taskId,
        step - 1,
      );
      return moved.length > 0 ? this.get(taskId) : null;
    });
  }

  /**
   * The phone classed step `step`'s stored action higher than the server did:
   * the same action now waits for the user, under the higher class. A retry
   * finds the card already open and gets it again.
   */
  hold(taskId: string, principal: string, step: number, actionId: string, cls: RiskClass, why: RiskWhy): ScreenTask | null {
    const now = this.now();
    return this.sql.transaction(() => {
      const task = this.row(taskId, principal);
      if (!task || task.step !== step || task.actionId !== actionId) return null;
      if (task.status === 'awaiting_approval') return task;
      if (task.status !== 'running') return null;
      const maxClass = higherClass(cls, task.cls ?? 'safe');
      const expires = Math.min(now + SCREEN_APPROVAL_TTL_MS, task.deadlineAt ?? now + SCREEN_APPROVAL_TTL_MS);
      const moved = this.sql.exec(
        `UPDATE screen_tasks SET status = 'awaiting_approval', cls = ?, why = ?, max_class = ?, approval_nonce = ?, approval_expires_at = ?
         WHERE task_id = ? AND status = 'running' AND action_id = ? RETURNING task_id`,
        maxClass,
        why,
        maxClass,
        randomHex(16),
        expires,
        taskId,
        actionId,
      );
      return moved.length > 0 ? this.get(taskId) : null;
    });
  }

  /**
   * The user's answer to a card, from the chat or the phone's notification —
   * the same row, the same nonce, the first one wins. `awaiting_approval ->
   * released` for that one stored action, never a new one; a rejection ends the
   * task. Expired, already decided, or another action: nothing.
   */
  decideApproval(taskId: string, principal: string, nonce: string, approve: boolean, actionId?: string): ApprovalResult {
    const now = this.now();
    return this.sql.transaction((): ApprovalResult => {
      const task = this.row(taskId, principal);
      if (!task || task.status !== 'awaiting_approval' || task.approvalNonce === null) return { kind: 'already' };
      if (!timingSafeEqualHex(task.approvalNonce, nonce)) return { kind: 'already' };
      if (actionId !== undefined && actionId !== task.actionId) return { kind: 'already' };
      if ((task.approvalExpiresAt ?? 0) <= now) return { kind: 'already' };
      if (!approve) {
        const ended = this.end(task, 'stopped', 'rejected', now);
        return ended ? { kind: 'rejected', ended } : { kind: 'already' };
      }
      const moved = this.sql.exec(
        `UPDATE screen_tasks SET status = 'released', approval_nonce = NULL
         WHERE task_id = ? AND status = 'awaiting_approval' AND action_id = ? AND approval_expires_at > ? RETURNING task_id`,
        taskId,
        task.actionId,
        now,
      );
      return moved.length > 0 ? { kind: 'released', task: this.get(taskId)! } : { kind: 'already' };
    });
  }

  // -- ending ----------------------------------------------------------------

  /** The chat's stop button. A wrong nonce or a task already over: nothing. */
  stop(taskId: string, principal: string, nonce: string): Ended | 'gone' {
    const now = this.now();
    return this.sql.transaction(() => {
      const task = this.row(taskId, principal);
      if (!task || !timingSafeEqualHex(task.stopNonce, nonce)) return 'gone';
      return this.end(task, 'stopped', 'stopped_user', now) ?? 'gone';
    });
  }

  /** A task ended by code on the server side: the model's end, a refusal, the budget. */
  finish(taskId: string, status: ScreenStatus, reason: string, outcome?: ScreenOutcome): Ended | null {
    const now = this.now();
    return this.sql.transaction(() => {
      const task = this.get(taskId);
      return task ? this.end(task, status, reason, now, outcome) : null;
    });
  }

  /**
   * The phone ended the task itself (`/app/screen/result`). An `uncertain`
   * report, or the end code `uncertain`, is `unknown`: the last action may
   * have run.
   */
  endByPhone(taskId: string, principal: string, reason: string, report: StepReport | undefined): Ended | null {
    const now = this.now();
    return this.sql.transaction(() => {
      const task = this.row(taskId, principal);
      if (!task || !OPEN_SCREEN_STATUSES.includes(task.status)) return null;
      let current: ScreenTask = task;
      if (report && report.actionId === task.actionId) {
        const last = task.history[task.history.length - 1];
        if (last && last.a === report.actionId && last.r === 'p' && report.status !== 'uncertain') {
          const r = report.status === 'dispatched' ? 'd' : report.status === 'not_accepted' ? 'n' : 'r';
          const history = [...task.history.slice(0, -1), { ...last, r } as HistoryEntry];
          this.saveProgress(task.taskId, history, task.dispatched + (r === 'd' ? 1 : 0), task.typedNonSearch);
          current = this.get(taskId)!;
        }
        if (report.status === 'uncertain') return this.end(current, 'unknown', 'uncertain', now);
      }
      if (reason === 'uncertain') return this.end(current, 'unknown', 'uncertain', now);
      const stopped = reason === 'stopped_user' || reason === 'stopped_restart';
      return this.end(current, stopped ? 'stopped' : 'failed', reason, now);
    });
  }

  /** A routine is about to run (routines first): every open task gives way. */
  preemptAll(principal: string): Ended[] {
    const now = this.now();
    return this.sql.transaction(() =>
      this.openTasks(principal)
        .map((task) => this.end(task, 'preempted', 'preempted', now))
        .filter((ended): ended is Ended => ended !== null),
    );
  }

  /**
   * What time alone ends: a push never claimed, a card never answered, a task
   * past its deadline that never reported. Each moved once.
   */
  sweep(): Ended[] {
    const now = this.now();
    return this.sql.transaction(() => {
      const ended: Ended[] = [];
      for (const row of this.sql.exec(`SELECT * FROM screen_tasks WHERE status IN ('pushed', 'running', 'awaiting_approval', 'released')`)) {
        const task = taskOf(row);
        const pushedAt = Number(row['pushed_at'] ?? 0);
        let done: Ended | null = null;
        if (task.status === 'pushed' && now - pushedAt > SCREEN_CLAIM_TTL_MS) done = this.end(task, 'failed', 'not_claimed', now);
        else if (task.deadlineAt !== null && now > task.deadlineAt + SCREEN_DEADLINE_GRACE_MS) done = this.end(task, 'deadline', 'deadline', now);
        else if (task.status === 'awaiting_approval' && (task.approvalExpiresAt ?? 0) <= now) {
          done = this.end(task, 'stopped', 'approval_timeout', now);
        }
        if (done) ended.push(done);
      }
      return ended;
    });
  }

  nextWakeAt(): number | null {
    const at = (query: string, ...bindings: unknown[]): number | null => {
      const value = this.sql.exec(query, ...bindings)[0]?.['at'];
      return typeof value === 'number' ? value : null;
    };
    const candidates = [
      at(`SELECT MIN(created_at) AS at FROM screen_tasks WHERE status = 'confirmed'`),
      at(`SELECT MIN(pushed_at + ?) AS at FROM screen_tasks WHERE status = 'pushed'`, SCREEN_CLAIM_TTL_MS + 1),
      at(`SELECT MIN(approval_expires_at) AS at FROM screen_tasks WHERE status = 'awaiting_approval'`),
      at(
        `SELECT MIN(deadline_at + ?) AS at FROM screen_tasks WHERE status IN ('running', 'awaiting_approval', 'released')`,
        SCREEN_DEADLINE_GRACE_MS + 1,
      ),
    ].filter((value): value is number => value !== null);
    return candidates.length === 0 ? null : Math.min(...candidates);
  }

  /** Ended tasks are kept a week, codes only, for the audit's sake. */
  purgeOld(now: number): void {
    this.sql.exec(
      `DELETE FROM screen_tasks WHERE status NOT IN ('confirmed', 'pushed', 'running', 'awaiting_approval', 'released') AND created_at < ?`,
      now - 7 * 24 * 60 * 60_000,
    );
  }

  // -- internals -------------------------------------------------------------

  private openTasks(principal: string): ScreenTask[] {
    return this.sql
      .exec(
        `SELECT * FROM screen_tasks WHERE principal = ? AND status IN ('confirmed', 'pushed', 'running', 'awaiting_approval', 'released')
         ORDER BY created_at`,
        principal,
      )
      .map(taskOf);
  }

  private row(taskId: string, principal: string): (ScreenTask & { inflight: number | null; hashes: { s: number; h: string }[] }) | null {
    const row = this.sql.exec(`SELECT * FROM screen_tasks WHERE task_id = ? AND principal = ?`, taskId, principal)[0];
    if (!row) return null;
    return {
      ...taskOf(row),
      inflight: typeof row['inflight_until'] === 'number' ? row['inflight_until'] : null,
      hashes: parseJson<{ s: number; h: string }[]>(row['hashes'], []),
    };
  }

  private saveProgress(taskId: string, history: HistoryEntry[], dispatched: number, typedNonSearch: boolean): void {
    this.sql.exec(
      `UPDATE screen_tasks SET history = ?, dispatched = ?, typed_non_search = ? WHERE task_id = ?`,
      JSON.stringify(history),
      dispatched,
      typedNonSearch ? 1 : 0,
      taskId,
    );
  }

  /**
   * Any open status to a final one, once. The sealed words and inputs go, and
   * so does any pending approval, so a late tap on a card finds nothing.
   */
  private end(task: ScreenTask, status: ScreenStatus, reason: string, now: number, outcome?: ScreenOutcome): Ended | null {
    const result = outcome ?? outcomeOf(status, reason, task);
    const moved = this.sql.exec(
      `UPDATE screen_tasks SET status = ?, reason = ?, outcome = ?, settled_at = ?, sealed = NULL, approval_nonce = NULL,
         inflight_until = NULL, hashes = '[]'
       WHERE task_id = ? AND status IN ('confirmed', 'pushed', 'running', 'awaiting_approval', 'released') RETURNING task_id`,
      status,
      reason,
      result,
      now,
      task.taskId,
    );
    if (moved.length === 0) return null;
    return { task: this.get(task.taskId)!, outcome: result, reason };
  }

  private endOrThrow(task: ScreenTask, status: ScreenStatus, reason: string, now: number): Ended {
    const ended = this.end(task, status, reason, now);
    if (!ended) throw new Error('E_SCREEN_MOVE');
    return ended;
  }

  private requireKeyring(): Keyring {
    if (!this.keyring) throw new Error('E_SCREEN_NO_KEYRING');
    return this.keyring();
  }
}

/**
 * What a final status means for the user (PLAN §6.28, §9.8). The model's own
 * words never choose it.
 */
export function outcomeOf(
  status: ScreenStatus,
  _reason: string,
  task: Pick<ScreenTask, 'dispatched' | 'history' | 'status'>,
): ScreenOutcome {
  if (status === 'unknown') return 'unknown';
  // An action handed to the phone and not reported may have run. One still
  // waiting for the user's approval was never handed out.
  const pending = task.status !== 'awaiting_approval' && task.history.some((h) => h.r === 'p' && h.k !== 'wait');
  if (status === 'stopped' || status === 'preempted') {
    return pending ? 'unknown' : 'stopped';
  }
  if (pending) return 'unknown';
  return task.dispatched > 0 ? 'failed_after_action' : 'failed_before_action';
}

/** The class an approval may run under: the phone's must not be higher (§9.1). */
export function withinGrant(phoneClass: RiskClass, maxClass: RiskClass): boolean {
  return classAtMost(phoneClass, maxClass);
}

function historyEntry(action: ScreenAction & { ns?: true }, actionId: string): HistoryEntry {
  return { k: action.kind, r: 'p', a: actionId, ...(action.ns ? { ns: true as const } : {}) };
}

function taskOf(row: SqlRow): ScreenTask {
  const action = parseJson<(ScreenAction & { ns?: true }) | null>(row['action'], null);
  return {
    taskId: String(row['task_id']),
    principal: String(row['principal']),
    package: String(row['package']),
    appLabel: String(row['app_label']),
    inputCount: Number(row['input_count']),
    status: String(row['status']) as ScreenStatus,
    step: Number(row['step']),
    actionId: typeof row['action_id'] === 'string' ? row['action_id'] : null,
    action,
    cls: typeof row['cls'] === 'string' ? (row['cls'] as RiskClass) : null,
    why: typeof row['why'] === 'string' ? (row['why'] as RiskWhy) : null,
    approvalNonce: typeof row['approval_nonce'] === 'string' ? row['approval_nonce'] : null,
    approvalExpiresAt: typeof row['approval_expires_at'] === 'number' ? row['approval_expires_at'] : null,
    maxClass: typeof row['max_class'] === 'string' ? (row['max_class'] as RiskClass) : null,
    history: parseJson<HistoryEntry[]>(row['history'], []),
    typedNonSearch: Number(row['typed_non_search']) === 1,
    dispatched: Number(row['dispatched']),
    waits: Number(row['waits']),
    tokens: Number(row['tokens']),
    stopNonce: String(row['stop_nonce']),
    outcome: typeof row['outcome'] === 'string' ? (row['outcome'] as ScreenOutcome) : null,
    reason: typeof row['reason'] === 'string' ? row['reason'] : null,
    deadlineAt: typeof row['deadline_at'] === 'number' ? row['deadline_at'] : null,
    createdAt: Number(row['created_at']),
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function aad(taskId: string) {
  return { provider: SEALED_PROVIDER, account: taskId };
}

function localDay(utcMs: number): string {
  const local = localPartsOf(utcMs, ZONE);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

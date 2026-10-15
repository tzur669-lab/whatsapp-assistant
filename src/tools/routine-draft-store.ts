/**
 * Routine drafts on the server (docs/plans/routine-builder.md, part 1): one
 * row per confirmed "build a routine" request ("תבנה שגרה: באפליקציית הנוכחות
 * ללחוץ כניסה").
 *
 *   confirmed -> pushed -> claimed -> drafted -> offered | build_failed | slot_busy
 *   claimed -> failed (the model, or the phone before the screen post)
 *   pushed -> expired, claimed | drafted -> unknown (each after 10 minutes)
 *   any open -> preempted (a routine is due)
 *
 * Every move is one conditional UPDATE, so a second claim, a repeat screen
 * post or a late result finds the row already moved on. The request's words
 * are sealed (AES-GCM) and cleared once the model answered or the draft ended
 * earlier. The screen and the drafted steps are never stored: they cross in
 * memory, inside one response. The server never saves a routine.
 *
 * Synchronous over `SqlDriver` except sealing; no platform imports (invariant 11).
 */
import type { SqlDriver, SqlRow } from '../core/sql.js';
import { decryptToken, encryptToken } from '../security/crypto.js';
import type { Keyring } from '../security/crypto.js';

export const MAX_DRAFT_APP = 40;
export const MAX_DRAFT_GOAL = 200;
export const MAX_DRAFT_INPUTS = 3;
export const MAX_DRAFT_INPUT = 60;
export const MAX_DRAFT_WORDS = 5;
export const MAX_DRAFT_WORD = 60;
/** A push not claimed, a claim with no screen answer, a draft never offered: each ends after this. */
export const DRAFT_TTL_MS = 10 * 60_000;
/** No draft starts when a routine run is due sooner than this: the push plus its 10-minute claim window. */
export const DRAFT_ROUTINE_GUARD_MS = 15 * 60_000;

export type DraftStatus =
  | 'confirmed'
  | 'pushed'
  | 'claimed'
  | 'drafted'
  | 'offered'
  | 'build_failed'
  | 'slot_busy'
  | 'failed'
  | 'expired'
  | 'unknown'
  | 'preempted';

export const OPEN_DRAFT_STATUSES: readonly DraftStatus[] = ['confirmed', 'pushed', 'claimed', 'drafted'];

/** The conversation it was confirmed in: which models' family drafts it. */
export type DraftMode = 'local' | 'smart';

/** What the phone may say about a draft (`/app/routine/draft/result`). */
export const DRAFT_RESULT_CODES = ['locked', 'app_not_front', 'launch_confirm', 'offered', 'build_failed', 'slot_busy'] as const;
export type DraftResultCode = (typeof DRAFT_RESULT_CODES)[number];
/** Before the screen post: the phone could not read the first screen. */
const PRE_SCREEN: ReadonlySet<DraftResultCode> = new Set(['locked', 'app_not_front', 'launch_confirm']);

export type Draft = {
  draftId: string;
  principal: string;
  package: string;
  appLabel: string;
  mode: DraftMode;
  status: DraftStatus;
  reason: string | null;
  /** The app message that confirmed it: its lines answer that one. Null: the reminders conversation. */
  inReplyTo: string | null;
  createdAt: number;
};

export type DraftRequest = { goal: string; inputs: string[]; words: string[] };

/** A draft that reached a final status in a move of this store, for the one line about it. */
export type DraftEnded = { draft: Draft; reason: string };

export type DraftClaim = { ok: true; draft: Draft } | { ok: false; reason: 'not_found' | 'already' | 'late' | 'ended' };

export type DraftResult = { kind: 'moved'; ended: DraftEnded } | { kind: 'refused' };

const SEALED_PROVIDER = 'routine_draft';
const OPEN_SQL = `('confirmed', 'pushed', 'claimed', 'drafted')`;

export class DraftStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number = Date.now,
    private readonly keyring?: () => Keyring,
  ) {}

  /** A confirmed request, sealed. */
  async create(params: {
    principal: string;
    package: string;
    appLabel: string;
    goal: string;
    inputs: readonly string[];
    words: readonly string[];
    mode: DraftMode;
  }): Promise<Draft> {
    const draftId = randomHex(16);
    const sealed = await encryptToken(
      JSON.stringify({ goal: params.goal, inputs: params.inputs, words: params.words }),
      this.requireKeyring(),
      aad(draftId),
    );
    this.sql.exec(
      `INSERT INTO routine_drafts (draft_id, principal, package, app_label, mode, sealed, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)`,
      draftId,
      params.principal,
      params.package,
      params.appLabel,
      params.mode,
      sealed,
      this.now(),
    );
    return this.get(draftId)!;
  }

  /** After the turn that confirmed it, the draft answers that message. Set once. */
  linkLatest(principal: string, inReplyTo: string, sinceMs: number): void {
    this.sql.exec(
      `UPDATE routine_drafts SET in_reply_to = ?
       WHERE draft_id = (SELECT draft_id FROM routine_drafts
                          WHERE principal = ? AND in_reply_to IS NULL AND created_at >= ?
                          ORDER BY created_at DESC LIMIT 1)`,
      inReplyTo,
      principal,
      sinceMs,
    );
  }

  /** The request's words, or null once the model answered or the draft ended. */
  async unseal(draftId: string): Promise<DraftRequest | null> {
    const sealed = this.sql.exec(`SELECT sealed FROM routine_drafts WHERE draft_id = ?`, draftId)[0]?.['sealed'];
    if (typeof sealed !== 'string') return null;
    try {
      const plain = JSON.parse(await decryptToken(sealed, this.requireKeyring(), aad(draftId))) as unknown;
      if (typeof plain !== 'object' || plain === null) return null;
      const { goal, inputs, words } = plain as { goal?: unknown; inputs?: unknown; words?: unknown };
      if (typeof goal !== 'string' || !isStrings(inputs) || !isStrings(words)) return null;
      return { goal, inputs, words };
    } catch {
      return null;
    }
  }

  get(draftId: string): Draft | null {
    const row = this.sql.exec(`SELECT * FROM routine_drafts WHERE draft_id = ?`, draftId)[0];
    return row ? draftOf(row) : null;
  }

  /** The open draft, if any (at most one at a time). */
  active(principal: string): Draft | null {
    const row = this.sql.exec(
      `SELECT * FROM routine_drafts WHERE principal = ? AND status IN ${OPEN_SQL} ORDER BY created_at LIMIT 1`,
      principal,
    )[0];
    return row ? draftOf(row) : null;
  }

  /** Confirmed drafts to push now, each moved once to `pushed`. */
  takePushes(): Draft[] {
    const now = this.now();
    return this.sql.transaction(() =>
      this.sql
        .exec(`UPDATE routine_drafts SET status = 'pushed', pushed_at = ? WHERE status = 'confirmed' RETURNING *`, now)
        .map(draftOf),
    );
  }

  /** The phone's one claim: `pushed -> claimed`, within the push's ten minutes. */
  claim(draftId: string, principal: string): DraftClaim {
    const now = this.now();
    return this.sql.transaction((): DraftClaim => {
      const row = this.row(draftId, principal);
      if (!row) return { ok: false, reason: 'not_found' };
      const draft = draftOf(row);
      if (draft.status !== 'pushed') return { ok: false, reason: OPEN_DRAFT_STATUSES.includes(draft.status) ? 'already' : 'ended' };
      if (now - Number(row['pushed_at'] ?? 0) > DRAFT_TTL_MS) {
        this.end(draftId, ['pushed'], 'expired', 'not_claimed', now);
        return { ok: false, reason: 'late' };
      }
      const moved = this.sql.exec(
        `UPDATE routine_drafts SET status = 'claimed', claimed_at = ? WHERE draft_id = ? AND status = 'pushed' RETURNING *`,
        now,
        draftId,
      );
      return moved[0] ? { ok: true, draft: draftOf(moved[0]) } : { ok: false, reason: 'already' };
    });
  }

  /** The one screen post: a claimed draft not posted yet is marked, and returned; anything else is null. */
  beginScreen(draftId: string, principal: string): Draft | null {
    const moved = this.sql.exec(
      `UPDATE routine_drafts SET screen_at = ? WHERE draft_id = ? AND principal = ? AND status = 'claimed' AND screen_at IS NULL RETURNING *`,
      this.now(),
      draftId,
      principal,
    );
    return moved[0] ? draftOf(moved[0]) : null;
  }

  /** The model's draft passed code's checks: `claimed -> drafted`. The sealed words go. */
  drafted(draftId: string): Draft | null {
    const moved = this.sql.exec(
      `UPDATE routine_drafts SET status = 'drafted', drafted_at = ?, sealed = NULL WHERE draft_id = ? AND status = 'claimed' RETURNING *`,
      this.now(),
      draftId,
    );
    return moved[0] ? draftOf(moved[0]) : null;
  }

  /** The model, a check or the phone failed it before a draft: `claimed -> failed`, once. */
  fail(draftId: string, reason: string): DraftEnded | null {
    return this.end(draftId, ['claimed'], 'failed', reason, this.now());
  }

  addTokens(draftId: string, tokens: number): void {
    if (tokens > 0) this.sql.exec(`UPDATE routine_drafts SET tokens = tokens + ? WHERE draft_id = ?`, Math.ceil(tokens), draftId);
  }

  /**
   * The phone's closed result codes, each only from its own status: before the
   * screen post (`claimed`, nothing in flight) the three "could not read"
   * codes; after the draft (`drafted`) what became of it.
   */
  result(draftId: string, principal: string, code: DraftResultCode): DraftResult {
    const now = this.now();
    return this.sql.transaction((): DraftResult => {
      const row = this.row(draftId, principal);
      if (!row) return { kind: 'refused' };
      const ended = PRE_SCREEN.has(code)
        ? row['screen_at'] === null || row['screen_at'] === undefined
          ? this.end(draftId, ['claimed'], 'failed', code, now)
          : null
        : this.end(draftId, ['drafted'], code as DraftStatus, code, now);
      return ended ? { kind: 'moved', ended } : { kind: 'refused' };
    });
  }

  /** What time alone ends: a push never claimed, a claim never answered, a draft never offered. Each once. */
  sweep(): DraftEnded[] {
    const now = this.now();
    const before = now - DRAFT_TTL_MS;
    return this.sql.transaction(() => {
      const ended: DraftEnded[] = [];
      const due = this.sql.exec(
        `SELECT draft_id, status FROM routine_drafts
         WHERE (status = 'pushed' AND pushed_at < ?) OR (status = 'claimed' AND claimed_at < ?) OR (status = 'drafted' AND drafted_at < ?)
         ORDER BY created_at`,
        before,
        before,
        before,
      );
      for (const row of due) {
        const status = String(row['status']) as DraftStatus;
        const done =
          status === 'pushed'
            ? this.end(String(row['draft_id']), ['pushed'], 'expired', 'not_claimed', now)
            : this.end(String(row['draft_id']), [status], 'unknown', status === 'claimed' ? 'no_screen' : 'not_offered', now);
        if (done) ended.push(done);
      }
      return ended;
    });
  }

  /** A routine is about to run (routines first): every open draft gives way. */
  preempt(principal: string): DraftEnded[] {
    const now = this.now();
    return this.sql.transaction(() =>
      this.sql
        .exec(`SELECT draft_id FROM routine_drafts WHERE principal = ? AND status IN ${OPEN_SQL} ORDER BY created_at`, principal)
        .map((row) => this.end(String(row['draft_id']), OPEN_DRAFT_STATUSES, 'preempted', 'preempted', now))
        .filter((ended): ended is DraftEnded => ended !== null),
    );
  }

  nextWakeAt(): number | null {
    const row = this.sql.exec(
      `SELECT MIN(at) AS at FROM (
         SELECT created_at AS at FROM routine_drafts WHERE status = 'confirmed'
         UNION ALL SELECT pushed_at + ? FROM routine_drafts WHERE status = 'pushed'
         UNION ALL SELECT claimed_at + ? FROM routine_drafts WHERE status = 'claimed'
         UNION ALL SELECT drafted_at + ? FROM routine_drafts WHERE status = 'drafted')`,
      DRAFT_TTL_MS + 1,
      DRAFT_TTL_MS + 1,
      DRAFT_TTL_MS + 1,
    )[0];
    return typeof row?.['at'] === 'number' ? row['at'] : null;
  }

  /** Ended drafts are kept a week, codes only, for the audit's sake. */
  purgeOld(now: number): void {
    this.sql.exec(`DELETE FROM routine_drafts WHERE status NOT IN ${OPEN_SQL} AND created_at < ?`, now - 7 * 24 * 60 * 60_000);
  }

  // -- internals -------------------------------------------------------------

  private row(draftId: string, principal: string): SqlRow | null {
    return this.sql.exec(`SELECT * FROM routine_drafts WHERE draft_id = ? AND principal = ?`, draftId, principal)[0] ?? null;
  }

  /** One of `from` to a final status, once. The sealed words always go. */
  private end(draftId: string, from: readonly DraftStatus[], status: DraftStatus, reason: string, now: number): DraftEnded | null {
    const placeholders = from.map(() => '?').join(', ');
    const moved = this.sql.exec(
      `UPDATE routine_drafts SET status = ?, reason = ?, settled_at = ?, sealed = NULL
       WHERE draft_id = ? AND status IN (${placeholders}) RETURNING *`,
      status,
      reason,
      now,
      draftId,
      ...from,
    );
    return moved[0] ? { draft: draftOf(moved[0]), reason } : null;
  }

  private requireKeyring(): Keyring {
    if (!this.keyring) throw new Error('E_DRAFT_NO_KEYRING');
    return this.keyring();
  }
}

function draftOf(row: SqlRow): Draft {
  return {
    draftId: String(row['draft_id']),
    principal: String(row['principal']),
    package: String(row['package']),
    appLabel: String(row['app_label']),
    mode: row['mode'] === 'smart' ? 'smart' : 'local',
    status: String(row['status']) as DraftStatus,
    reason: typeof row['reason'] === 'string' ? row['reason'] : null,
    inReplyTo: typeof row['in_reply_to'] === 'string' ? row['in_reply_to'] : null,
    createdAt: Number(row['created_at']),
  };
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function aad(draftId: string) {
  return { provider: SEALED_PROVIDER, account: draftId };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Undo offers for Tier 1 actions (PLAN §6.5).
 *
 * Tier 1 is "create, reversible": it executes straight away and the reply
 * carries an Undo button for ten minutes. What that button runs is a
 * *compensating action* written down at execution time — not a fresh
 * interpretation of anything.
 *
 * The gates are the same as a pending action's, and for the same reason: an
 * undo changes state, so a guessed button id must not be able to fire one.
 */
import type { SqlDriver } from '../core/sql.js';
import { sha256Hex } from './pending.js';

/** Tier 1's window: long enough to notice a mistake, short enough to be safe. */
export const UNDO_EXPIRY_MS = 10 * 60 * 1000;

/**
 * A snooze offer rides on the same table. It is the same object — a one-shot,
 * sender-bound, nonce-checked action stored for later — and giving it its own
 * table would duplicate all five gates for no gain. It lives longer because a
 * reminder is often seen well after it arrives.
 */
export const SNOOZE_EXPIRY_MS = 6 * 60 * 60 * 1000;

const ID_BYTES = 12;
const NONCE_BYTES = 16;

export type UndoOffer = {
  id: string;
  tool: string;
  principal: string;
  expiresAt: number;
  /** Returned once, at creation. Only its hash is stored. */
  nonce: string;
};

export type UndoFailure = 'not_found' | 'not_pending' | 'expired' | 'wrong_sender' | 'bad_nonce';

export type UndoResult =
  | { ok: true; tool: string; compensating: unknown }
  | { ok: false; reason: UndoFailure };

export class UndoActions {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  offer(params: {
    tool: string;
    compensating: unknown;
    principal: string;
    /** Defaults to the Tier 1 undo window. */
    expiryMs?: number;
  }): UndoOffer {
    const id = randomHex(ID_BYTES);
    const nonce = randomHex(NONCE_BYTES);
    const createdAt = this.now();
    const expiresAt = createdAt + (params.expiryMs ?? UNDO_EXPIRY_MS);

    this.sql.exec(
      `INSERT INTO undo_actions
         (id, tool, compensating_json, principal, nonce_hash, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      params.tool,
      JSON.stringify(params.compensating),
      params.principal,
      digest(nonce),
      createdAt,
      expiresAt,
    );

    return { id, nonce, tool: params.tool, principal: params.principal, expiresAt };
  }

  /** Validate, consume, and hand back the compensating action to run. */
  use(id: string, nonce: string, principal: string): UndoResult {
    const row = this.sql.exec('SELECT * FROM undo_actions WHERE id = ?', id)[0];
    if (!row) return { ok: false, reason: 'not_found' };

    if (row['status'] !== 'pending') return { ok: false, reason: 'not_pending' };
    if (Number(row['expires_at']) <= this.now()) return { ok: false, reason: 'expired' };
    if (String(row['principal']) !== principal) return { ok: false, reason: 'wrong_sender' };
    if (!timingSafeEqual(digest(nonce), String(row['nonce_hash']))) {
      return { ok: false, reason: 'bad_nonce' };
    }

    this.sql.exec(`UPDATE undo_actions SET status = 'used' WHERE id = ? AND status = 'pending'`, id);

    return {
      ok: true,
      tool: String(row['tool']),
      compensating: JSON.parse(String(row['compensating_json'])),
    };
  }

  /** Mark rows past their expiry. Run from the daily cron (PLAN §6.7). */
  expireStale(): void {
    this.sql.exec(
      `UPDATE undo_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
      this.now(),
    );
  }
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function digest(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

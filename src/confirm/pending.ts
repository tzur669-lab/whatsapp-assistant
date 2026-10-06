/**
 * Pending actions (PLAN §6.5).
 *
 * A Tier 2+ tool does not execute when it is understood. It is written down,
 * previewed to the user, and executed only when a button reply passes every one
 * of these checks, atomically, inside the Durable Object:
 *
 *   exists · still pending · not expired · same sender · nonce matches ·
 *   stored input unchanged
 *
 * No LLM is involved (CLAUDE.md invariant 7). What executes is the row, never a
 * re-parse of the original message — so a second interpretation of the same
 * words cannot change what happens.
 *
 * Synchronous on purpose: the Durable Object serializes calls, so the read and
 * the status update cannot interleave with another tap.
 */
import type { SqlDriver } from '../core/sql.js';

const EXPIRY_MS = 5 * 60 * 1000;
/** The longest any pending row may live: a leave reminder's card (ROADMAP #5). */
export const MAX_EXPIRY_MS = 2 * 60 * 60 * 1000;
/** How long past its expiry a row is kept before it is deleted. */
const PURGE_AFTER_MS = 60 * 60 * 1000;
const ID_BYTES = 12;
const NONCE_BYTES = 16;

export type PendingStatus = 'pending' | 'executed' | 'cancelled' | 'expired';

/**
 * Where a pending action is confirmed (PLAN §6.20). `chat`: a chat button or a
 * plain "כן" / "אישור". `card`: only a signed claim from the paired app.
 * The two never cross — a card cannot be confirmed from the chat, and a chat
 * action cannot be claimed as a card — and a mismatch reads as "not found".
 */
export type PendingChannel = 'chat' | 'card';

export type PendingAction = {
  id: string;
  tool: string;
  input: unknown;
  summary: string;
  tier: number;
  principal: string;
  status: PendingStatus;
  createdAt: number;
  expiresAt: number;
  /** Returned once, at creation. Only its hash is stored. */
  nonce: string;
};

export type ConfirmFailure =
  | 'not_found'
  | 'not_pending'
  | 'expired'
  | 'wrong_sender'
  | 'bad_nonce'
  | 'input_changed';

export type ConfirmResult =
  // The nonce is not handed back: it cannot be recovered from its hash.
  | { ok: true; action: Omit<PendingAction, 'nonce'> }
  | { ok: false; reason: ConfirmFailure };

export type PlainTextResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'nothing_pending' | 'ambiguous' | 'not_an_answer' };

/**
 * The only plain-text replies accepted in place of a button, and only when
 * exactly one action is pending. Deliberately tiny: "כן בבקשה תמחק" is not on
 * it, because agreeing at length is not the same as answering this question.
 */
const AFFIRMATIVES = new Set(['כן', 'אשר', 'אישור', 'yes', 'y', 'ok', 'confirm']);

export class PendingActions {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  create(params: {
    tool: string;
    input: unknown;
    summary: string;
    tier: number;
    principal: string;
    channel?: PendingChannel;
    /**
     * A card on a delivered "time to leave" reminder lives longer than five
     * minutes: the user may look at the notification later (ROADMAP #5).
     * Capped; absent is the five minutes every confirmation gets.
     */
    expiryMs?: number;
  }): PendingAction {
    const id = randomHex(ID_BYTES);
    const nonce = randomHex(NONCE_BYTES);
    const createdAt = this.now();
    const expiresAt = createdAt + Math.min(Math.max(params.expiryMs ?? EXPIRY_MS, 1), MAX_EXPIRY_MS);
    const inputJson = JSON.stringify(params.input);

    this.sql.exec(
      `INSERT INTO pending_actions
         (id, tool, input_json, input_hash, summary, tier, principal, nonce_hash, status, created_at, expires_at, channel)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      params.tool,
      inputJson,
      digest(inputJson),
      params.summary,
      params.tier,
      params.principal,
      digest(nonce),
      createdAt,
      expiresAt,
      params.channel ?? 'chat',
    );

    return {
      id,
      nonce,
      tool: params.tool,
      input: params.input,
      summary: params.summary,
      tier: params.tier,
      principal: params.principal,
      status: 'pending',
      createdAt,
      expiresAt,
    };
  }

  /** Validate and mark executed. Returns the stored input to run. */
  confirm(id: string, nonce: string, principal: string, channel: PendingChannel = 'chat'): ConfirmResult {
    const checked = this.check(id, nonce, principal, channel);
    if (!checked.ok) return checked;

    this.sql.exec(
      `UPDATE pending_actions SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'pending'`,
      this.now(),
      id,
    );
    return checked;
  }

  /**
   * Confirm an action the caller identified itself, with no nonce.
   *
   * Used for a plain "כן", where there is no button id to carry one — and the
   * nonce could not be produced anyway, since only its hash is stored.
   *
   * Skipping that one gate is sound here and nowhere else: the id was not
   * supplied by the sender. It came from `resolvePlainText`, which looked up
   * this principal's own pending actions and returned an id only when exactly
   * one was open. The nonce exists to stop a *guessed* button id from
   * executing something; there is no id to guess on this path. Every other
   * gate — exists, pending, not expired, same sender, input unchanged — still
   * runs.
   */
  confirmResolved(id: string, principal: string): ConfirmResult {
    const checked = this.check(id, null, principal, 'chat');
    if (!checked.ok) return checked;

    this.sql.exec(
      `UPDATE pending_actions SET status = 'executed', executed_at = ? WHERE id = ? AND status = 'pending'`,
      this.now(),
      id,
    );
    return checked;
  }

  /** Validate and mark cancelled. Same checks: a cancel is also an instruction. */
  cancel(
    id: string,
    nonce: string,
    principal: string,
    channel: PendingChannel = 'chat',
  ): { ok: true } | { ok: false; reason: ConfirmFailure } {
    const checked = this.check(id, nonce, principal, channel);
    if (!checked.ok) return checked;

    this.sql.exec(
      `UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
      id,
    );
    return { ok: true };
  }

  /**
   * Resolve a plain "כן" to a pending action.
   *
   * Only when exactly one is pending for this sender. With two open questions a
   * bare yes is genuinely ambiguous, and guessing which one it answers is
   * exactly the kind of mistake confirmations exist to prevent.
   */
  resolvePlainText(text: string, principal: string): PlainTextResult {
    if (!AFFIRMATIVES.has(text.trim().toLowerCase())) {
      // Report the shape of the failure the caller can act on: if nothing is
      // pending at all, that is the more useful thing to say.
      return this.pendingIdsFor(principal).length === 0
        ? { ok: false, reason: 'nothing_pending' }
        : { ok: false, reason: 'not_an_answer' };
    }

    const ids = this.pendingIdsFor(principal);
    if (ids.length === 0) return { ok: false, reason: 'nothing_pending' };
    if (ids.length > 1) return { ok: false, reason: 'ambiguous' };
    return { ok: true, id: ids[0]! };
  }

  /** The tier of a stored action, or 0 when there is no such row. */
  tierOf(id: string): number {
    const row = this.sql.exec('SELECT tier FROM pending_actions WHERE id = ?', id)[0];
    return row ? Number(row['tier']) : 0;
  }

  /** Mark rows past their expiry. Run from the daily cron (PLAN §6.7). */
  expireStale(): void {
    this.sql.exec(
      `UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`,
      this.now(),
    );
  }

  /**
   * Delete rows an hour past their expiry, whatever their status. Their input
   * and summary are message text in plaintext — a reminder body, an event title
   * — and an expired or used row has no further purpose (PLAN §6.19, plan D4).
   */
  purgeOld(): void {
    this.sql.exec('DELETE FROM pending_actions WHERE expires_at <= ?', this.now() - PURGE_AFTER_MS);
  }

  /**
   * This principal's open chat actions, every tier. Tier 3 is answered by "כן"
   * or "אישור" like Tier 2 since 2026-10-01 (the user's decision, PLAN §14).
   */
  private pendingIdsFor(principal: string): string[] {
    const rows = this.sql.exec(
      `SELECT id FROM pending_actions
       WHERE principal = ? AND status = 'pending' AND expires_at > ? AND channel = 'chat'`,
      principal,
      this.now(),
    );
    return rows.map((row) => String(row['id']));
  }

  /**
   * Every gate, in order. Nothing is mutated here.
   *
   * `nonce === null` means the caller found this id itself rather than reading
   * it off a message; see `confirmResolved` for why that is the only case where
   * the nonce gate may be skipped.
   */
  private check(id: string, nonce: string | null, principal: string, channel: PendingChannel): ConfirmResult {
    const row = this.sql.exec('SELECT * FROM pending_actions WHERE id = ?', id)[0];
    if (!row) return { ok: false, reason: 'not_found' };
    // A row from the other path does not exist on this one (§6.20).
    if ((row['channel'] ?? 'chat') !== channel) return { ok: false, reason: 'not_found' };

    if (row['status'] !== 'pending') return { ok: false, reason: 'not_pending' };
    if (Number(row['expires_at']) <= this.now()) return { ok: false, reason: 'expired' };
    if (String(row['principal']) !== principal) return { ok: false, reason: 'wrong_sender' };
    if (nonce !== null && !timingSafeEqual(digest(nonce), String(row['nonce_hash']))) {
      return { ok: false, reason: 'bad_nonce' };
    }

    const inputJson = String(row['input_json']);
    if (!timingSafeEqual(digest(inputJson), String(row['input_hash']))) {
      return { ok: false, reason: 'input_changed' };
    }

    return {
      ok: true,
      action: {
        id,
        tool: String(row['tool']),
        input: JSON.parse(inputJson),
        summary: String(row['summary']),
        tier: Number(row['tier']),
        principal,
        status: 'pending',
        createdAt: Number(row['created_at']),
        expiresAt: Number(row['expires_at']),
      },
    };
  }
}

// -- button ids ---------------------------------------------------------------

export type ButtonKind = 'pa' | 'undo' | 'snooze';
export type ButtonVerb = 'ok' | 'no' | 'done' | 'm10' | 'h1';

const BUTTON_KINDS = new Set<string>(['pa', 'undo', 'snooze']);
const BUTTON_VERBS = new Set<string>(['ok', 'no', 'done', 'm10', 'h1']);

/** `pa:<id>:<nonce>:ok` — the format WhatsApp echoes back verbatim. */
export function buttonId(kind: ButtonKind, id: string, nonce: string, verb: ButtonVerb): string {
  return `${kind}:${id}:${nonce}:${verb}`;
}

export function parseButtonId(
  raw: string,
): { kind: ButtonKind; id: string; nonce: string; verb: ButtonVerb } | null {
  const parts = raw.split(':');
  if (parts.length !== 4) return null;

  const [kind, id, nonce, verb] = parts as [string, string, string, string];
  if (!BUTTON_KINDS.has(kind) || !BUTTON_VERBS.has(verb)) return null;
  if (!/^[0-9a-f]+$/.test(id) || !/^[0-9a-f]+$/.test(nonce)) return null;

  return { kind: kind as ButtonKind, id, nonce, verb: verb as ButtonVerb };
}

// -- helpers ------------------------------------------------------------------

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A fast non-cryptographic digest is not enough here: the nonce hash is what
 * stops a guessed button id from executing an action. FNV would be trivially
 * invertible for a 16-byte hex nonce, so this uses SHA-256 via a synchronous
 * path — WebCrypto's digest is async, and these checks must stay synchronous to
 * remain atomic inside the Durable Object.
 */
function digest(value: string): string {
  return sha256Hex(new TextEncoder().encode(value));
}

/**
 * Minimal synchronous SHA-256 (FIPS 180-4).
 *
 * WebCrypto's `digest` is async, and these checks must stay synchronous: the
 * read, the comparison and the status update have to be one uninterrupted unit
 * inside the Durable Object, or two taps of the same button could both pass the
 * "still pending" check before either writes.
 *
 * Hand-written crypto is a liability, so `sha256.test.ts` checks this against
 * the published vectors and against WebCrypto over random inputs.
 */
export function sha256Hex(message: Uint8Array): string {
  const K = SHA256_K;
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const length = message.length;
  const paddedLength = (((length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[length] = 0x80;

  const bitLength = length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => n.toString(16).padStart(8, '0')).join('');
}

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

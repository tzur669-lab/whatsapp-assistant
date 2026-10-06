/**
 * Agent turns waiting for the phone (PLAN §6.21).
 *
 * A phone read cannot be answered inside the request that asked for it: the
 * phone has to read and send the result back. So the turn is written down —
 * encrypted, bound to this sender and this query id — and the request answers
 * `device_query`. The phone's signed result picks it up again.
 *
 * One row per suspended turn, keyed by a random query id and found again by the
 * message that started it. Its life:
 *
 *   waiting ──begin──▶ running ──finish──▶ done
 *      │
 *      ├── a newer agent turn starts ──▶ superseded
 *      └── three minutes pass ─────────▶ expired
 *
 * `begin` is synchronous and atomic, so a result sent twice continues the turn
 * once. The ciphertext goes as soon as a row leaves `waiting` or `running`: it
 * holds the user's words. Settled rows stay an hour, without it, so a late
 * result or a retry still gets the right answer, and are then purged.
 *
 * Voice turns never get here (invariant 13): the phone reads are not offered on
 * them, so a transcript is never in a stored turn.
 */
import { z } from 'zod';
import type { SqlDriver } from '../core/sql.js';
import type { Keyring } from '../security/crypto.js';
import { decryptToken, encryptToken } from '../security/crypto.js';
import { TOOL_NAMES } from '../tools/registry.js';
import { phoneReadInputSchema } from '../tools/phone-reads.js';
import type { SuspendedState } from './loop.js';

/** The app waits three minutes for an answer, then stops (Turns.kt). */
export const SUSPEND_TTL_MS = 3 * 60_000;
/** Settled rows answer late results and retries for this long. */
export const SETTLED_KEEP_MS = 60 * 60_000;
const MAX_STORED_MESSAGES = 40;

const AAD_PROVIDER = 'agent-turns';

export type TurnStatus = 'waiting' | 'running' | 'done' | 'superseded' | 'expired';

export type Begin =
  /** This call owns the turn now: decrypt and go on. */
  | { kind: 'run'; wamid: string; ciphertext: string }
  /** Someone else got here first, or the turn is over. */
  | { kind: 'settled'; wamid: string; status: Exclude<TurnStatus, 'waiting'> }
  | { kind: 'not_found' };

export type WaitingTurn = { queryId: string; principal: string; status: TurnStatus; ciphertext: string | null };

const wireToolCall = z
  .object({
    id: z.string().max(200),
    type: z.literal('function'),
    function: z.object({ name: z.string().max(100), arguments: z.string().max(8_000) }).strict(),
  })
  .strict();

const messageSchema = z.union([
  z.object({ role: z.enum(['system', 'user']), content: z.string() }).strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().nullable(),
      tool_calls: z.array(wireToolCall).max(4).optional(),
    })
    .strict(),
  z.object({ role: z.literal('tool'), tool_call_id: z.string().max(200), content: z.string() }).strict(),
]);

/** Our own ciphertext, so this is a second lock, not the first. */
const stateSchema = z
  .object({
    model: z.string().min(1).max(100),
    conversation: z.string().max(36).optional(),
    grants: z.object({ gmail: z.boolean().optional(), tasks: z.boolean().optional(), drive: z.boolean().optional() }).strict().optional(),
    messages: z.array(messageSchema).min(1).max(MAX_STORED_MESSAGES),
    spent: z.number().int().nonnegative(),
    calls: z.number().int().nonnegative(),
    tainted: z.boolean(),
    readText: z.string().optional(),
    text: z.string().max(8_000),
    lang: z.enum(['he', 'en']),
    cards: z.boolean(),
    toolCallId: z.string().min(1).max(200),
    tool: z.enum(TOOL_NAMES),
    query: phoneReadInputSchema,
    // The narrowed tool set (2026-10-06); absent in states stored before it.
    offered: z.array(z.enum(TOOL_NAMES)).max(TOOL_NAMES.length).optional(),
  })
  .strict();

export class SuspendedTurns {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly keyring: () => Keyring,
  ) {}

  /** Write the turn down. Returns the query id the phone answers to. */
  async suspend(principal: string, wamid: string, state: SuspendedState): Promise<string> {
    const queryId = randomHex(16);
    const ciphertext = await encryptToken(JSON.stringify(state), this.keyring(), aad(principal, queryId));
    const now = this.now();
    this.sql.exec(
      `INSERT INTO agent_turns (query_id, principal, wamid, ciphertext, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'waiting', ?, ?)`,
      queryId,
      principal,
      wamid,
      ciphertext,
      now,
      now + SUSPEND_TTL_MS,
    );
    return queryId;
  }

  /** Is a turn of this sender waiting for the phone? Read only (2026-10-05). */
  hasWaiting(principal: string): boolean {
    const row = this.sql.exec(
      `SELECT 1 AS found FROM agent_turns WHERE principal = ? AND status = 'waiting' AND expires_at > ? LIMIT 1`,
      principal,
      this.now(),
    )[0];
    return row !== undefined;
  }

  /**
   * A newer agent turn started: whatever was waiting will not be continued.
   * Synchronous, and called right after the newer turn takes the lock.
   */
  supersede(principal: string): void {
    this.sql.exec(
      `UPDATE agent_turns SET status = 'superseded', ciphertext = NULL
       WHERE principal = ? AND status = 'waiting'`,
      principal,
    );
  }

  /** Take the turn, once. A second result for the same query finds it settled. */
  begin(queryId: string, principal: string): Begin {
    const now = this.now();
    return this.sql.transaction((): Begin => {
      const row = this.sql.exec(
        'SELECT principal, wamid, ciphertext, status, expires_at FROM agent_turns WHERE query_id = ?',
        queryId,
      )[0];
      if (!row || row['principal'] !== principal) return { kind: 'not_found' };

      const wamid = String(row['wamid']);
      const status = String(row['status']) as TurnStatus;
      if (status !== 'waiting') return { kind: 'settled', wamid, status };

      if (Number(row['expires_at']) <= now || typeof row['ciphertext'] !== 'string') {
        this.sql.exec(
          `UPDATE agent_turns SET status = 'expired', ciphertext = NULL WHERE query_id = ?`,
          queryId,
        );
        return { kind: 'settled', wamid, status: 'expired' };
      }

      this.sql.exec(`UPDATE agent_turns SET status = 'running' WHERE query_id = ?`, queryId);
      return { kind: 'run', wamid, ciphertext: row['ciphertext'] };
    });
  }

  /** The stored turn, or null for anything that does not decrypt or does not fit. */
  async open(queryId: string, principal: string, ciphertext: string): Promise<SuspendedState | null> {
    try {
      const plain = await decryptToken(ciphertext, this.keyring(), aad(principal, queryId));
      const parsed = stateSchema.safeParse(JSON.parse(plain));
      return parsed.success ? (parsed.data as unknown as SuspendedState) : null;
    } catch {
      return null;
    }
  }

  /** The turn is over, whatever its answer was. Its words go now. */
  finish(queryId: string, status: 'done' | 'superseded' = 'done'): void {
    this.sql.exec(`UPDATE agent_turns SET status = ?, ciphertext = NULL WHERE query_id = ?`, status, queryId);
  }

  /** The newest suspended turn a message started — for a retry of that message. */
  byWamid(wamid: string): WaitingTurn | null {
    const row = this.sql.exec(
      `SELECT query_id, principal, status, ciphertext FROM agent_turns
       WHERE wamid = ? ORDER BY created_at DESC LIMIT 1`,
      wamid,
    )[0];
    if (!row) return null;
    return {
      queryId: String(row['query_id']),
      principal: String(row['principal']),
      status: String(row['status']) as TurnStatus,
      ciphertext: typeof row['ciphertext'] === 'string' ? row['ciphertext'] : null,
    };
  }

  /** Waiting turns whose time ran out, marked expired. The caller answers each. */
  expireDue(): { wamid: string; principal: string }[] {
    const now = this.now();
    return this.sql.transaction(() => {
      const rows = this.sql.exec(
        `SELECT query_id, wamid, principal FROM agent_turns WHERE status = 'waiting' AND expires_at <= ?`,
        now,
      );
      for (const row of rows) {
        this.sql.exec(
          `UPDATE agent_turns SET status = 'expired', ciphertext = NULL WHERE query_id = ?`,
          row['query_id'],
        );
      }
      return rows.map((row) => ({ wamid: String(row['wamid']), principal: String(row['principal']) }));
    });
  }

  /** When the alarm must wake to expire the next waiting turn. */
  nextExpiryAt(): number | null {
    const row = this.sql.exec(`SELECT MIN(expires_at) AS at FROM agent_turns WHERE status = 'waiting'`)[0];
    const at = row?.['at'];
    return at === null || at === undefined ? null : Number(at);
  }

  /** `/forget`, `/pair off`. */
  wipe(principal: string): void {
    this.sql.exec('DELETE FROM agent_turns WHERE principal = ?', principal);
  }

  /**
   * Settled rows after an hour. A `running` row that old belongs to an object
   * that died mid-turn; it goes too, ciphertext and all.
   */
  purgeOld(): void {
    this.sql.exec('DELETE FROM agent_turns WHERE created_at <= ?', this.now() - SETTLED_KEEP_MS);
  }
}

function aad(principal: string, queryId: string): { provider: string; account: string } {
  return { provider: AAD_PROVIDER, account: `${principal}:${queryId}` };
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

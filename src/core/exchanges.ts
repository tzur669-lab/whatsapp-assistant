/**
 * "לא הבנת" capture (PLAN §6.23, ROADMAP block H part 16, 2026-10-07).
 *
 * `last_exchange` keeps the one latest exchange per conversation that reached a
 * model — the agent, the parser or the read-only try. Commands, confirmations,
 * buttons and answers to a question never write it, so "לא הבנת" after a "כן"
 * still finds the request the "כן" answered. Ordered by the inbound `seq`, never
 * by the clock: a turn that finishes late never overwrites a newer one, and an
 * expired row never blocks a new write.
 *
 * The user's own "לא הבנת" copies it into `misses`, for review with a human.
 * Both are AES-GCM ciphertext, bound to principal and conversation. Nothing
 * here is logged, and nothing here is ever given to a model: the agent's
 * services do not carry this store.
 */
import type { SqlDriver } from './sql.js';
import type { Keyring } from '../security/crypto.js';
import { decryptToken, encryptToken } from '../security/crypto.js';

export const EXCHANGE_TTL_MS = 60 * 60 * 1000;
export const MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_MISSES = 50;
export const MISSES_SHOWN = 10;
/** Each side is cut here: enough to see what went wrong, no more. */
const MAX_SIDE_CHARS = 1_200;

export type Exchange = {
  user: string;
  reply: string;
  /** The inbound record's decision and error code, e.g. `CLARIFY/E_AGENT_RATE`. */
  outcome: string;
  /** The tool or intent the turn settled on, when there was one. */
  intent: string | null;
  /** The tool groups the words matched (`agent/tool-groups.ts`). */
  groups: string[];
  at: number;
};

export type Miss = Exchange & { id: string };

export type CaptureResult = { kind: 'saved'; exchange: Exchange } | { kind: 'none' };

export class ExchangeLog {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly keyring: () => Keyring,
  ) {}

  /**
   * Keep this exchange as the conversation's latest, unless a newer message's
   * already is. Encrypts first, then writes in one synchronous statement.
   */
  async record(principal: string, conversation: string, seq: number, exchange: Exchange): Promise<void> {
    const ciphertext = await encryptToken(JSON.stringify(cut(exchange)), this.keyring(), lastAad(principal, conversation));
    const now = this.now();
    this.sql.exec(
      `INSERT INTO last_exchange (principal, conversation, seq, ciphertext, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(principal, conversation) DO UPDATE SET
         seq = excluded.seq, ciphertext = excluded.ciphertext, expires_at = excluded.expires_at
       WHERE excluded.seq >= last_exchange.seq OR last_exchange.expires_at <= ?`,
      principal,
      conversation,
      seq,
      ciphertext,
      now + EXCHANGE_TTL_MS,
      now,
    );
  }

  /** Copy the conversation's latest exchange into the misses. */
  async capture(principal: string, conversation: string): Promise<CaptureResult> {
    const now = this.now();
    const row = this.sql.exec(
      'SELECT ciphertext FROM last_exchange WHERE principal = ? AND conversation = ? AND expires_at > ?',
      principal,
      conversation,
      now,
    )[0];
    const ciphertext = row?.['ciphertext'];
    if (typeof ciphertext !== 'string') return { kind: 'none' };

    let exchange: Exchange;
    try {
      exchange = parseExchange(await decryptToken(ciphertext, this.keyring(), lastAad(principal, conversation)));
    } catch {
      // A rotated key or a damaged row: it is gone either way.
      this.sql.exec('DELETE FROM last_exchange WHERE principal = ? AND conversation = ?', principal, conversation);
      return { kind: 'none' };
    }

    const id = randomId();
    const sealed = await encryptToken(JSON.stringify(exchange), this.keyring(), missAad(principal, id));
    this.sql.transaction(() => {
      this.sql.exec(
        'INSERT INTO misses (id, principal, ciphertext, created_at) VALUES (?, ?, ?, ?)',
        id,
        principal,
        sealed,
        now,
      );
      // The newest 50 stay; the oldest beyond that go.
      this.sql.exec(
        `DELETE FROM misses WHERE principal = ? AND id NOT IN
           (SELECT id FROM misses WHERE principal = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
        principal,
        principal,
        MAX_MISSES,
      );
    });
    return { kind: 'saved', exchange };
  }

  /** The newest misses, newest first. Unreadable rows are skipped and deleted. */
  async list(principal: string, limit = MISSES_SHOWN): Promise<Miss[]> {
    const rows = this.sql.exec(
      'SELECT id, ciphertext FROM misses WHERE principal = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT ?',
      principal,
      this.now() - MISS_TTL_MS,
      limit,
    );
    const out: Miss[] = [];
    for (const row of rows) {
      const id = String(row['id']);
      try {
        const exchange = parseExchange(
          await decryptToken(String(row['ciphertext']), this.keyring(), missAad(principal, id)),
        );
        out.push({ ...exchange, id });
      } catch {
        this.sql.exec('DELETE FROM misses WHERE id = ?', id);
      }
    }
    return out;
  }

  /** `/forget`, `/pair off`: the latest exchanges go. The misses stay: the user kept them. */
  forget(principal: string): void {
    this.sql.exec('DELETE FROM last_exchange WHERE principal = ?', principal);
  }

  purgeExpired(): void {
    const now = this.now();
    this.sql.exec('DELETE FROM last_exchange WHERE expires_at <= ?', now);
    this.sql.exec('DELETE FROM misses WHERE created_at <= ?', now - MISS_TTL_MS);
  }
}

const lastAad = (principal: string, conversation: string) => ({
  provider: 'last_exchange',
  account: `${principal}:${conversation}`,
});

const missAad = (principal: string, id: string) => ({ provider: 'miss', account: `${principal}:${id}` });

function cut(exchange: Exchange): Exchange {
  return {
    ...exchange,
    user: exchange.user.slice(0, MAX_SIDE_CHARS),
    reply: exchange.reply.slice(0, MAX_SIDE_CHARS),
    groups: exchange.groups.slice(0, 6),
  };
}

function parseExchange(json: string): Exchange {
  const raw = JSON.parse(json) as Record<string, unknown>;
  const groups = Array.isArray(raw['groups']) ? raw['groups'].filter((g): g is string => typeof g === 'string') : [];
  return {
    user: String(raw['user'] ?? ''),
    reply: String(raw['reply'] ?? ''),
    outcome: String(raw['outcome'] ?? ''),
    intent: typeof raw['intent'] === 'string' ? raw['intent'] : null,
    groups,
    at: Number(raw['at'] ?? 0),
  };
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

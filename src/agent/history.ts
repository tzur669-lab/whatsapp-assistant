/**
 * The agent's short memory (PLAN §6.19, plan invariant 7).
 *
 * What it keeps is the minimum that makes "and the day after?" mean something:
 * the user's words and the reply that was sent, per exchange. Never a tool
 * result, never a transcript (a voice note is stored as a placeholder,
 * invariant 13), never anything in a log.
 *
 * Every row is AES-GCM ciphertext bound to this table and this sender. A row that
 * no longer decrypts — the key it was written under has been rotated out — is
 * deleted and read as absent: losing a few hours of chat is the right price, and
 * failing every turn until the row expired is not (plan D3).
 */
import type { SqlDriver } from '../core/sql.js';
import type { Keyring } from '../security/crypto.js';
import { decryptToken, encryptToken } from '../security/crypto.js';

export const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;
/** A turn that read text someone else wrote is remembered for less time. */
export const TAINTED_HISTORY_TTL_MS = 60 * 60 * 1000;
export const MAX_EXCHANGES = 6;
/** Roughly a thousand tokens of Hebrew. Oldest exchanges go first. */
export const MAX_HISTORY_CHARS = 2_400;

const AAD_PROVIDER = 'agent-history';

export type HistoryEntry = { user: string; reply: string; tainted: boolean };

export class ConversationHistory {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly keyring: () => Keyring,
  ) {}

  async append(principal: string, entry: HistoryEntry): Promise<void> {
    const ciphertext = await encryptToken(
      JSON.stringify({ u: entry.user, r: entry.reply }),
      this.keyring(),
      { provider: AAD_PROVIDER, account: principal },
    );
    const now = this.now();
    this.sql.exec(
      `INSERT INTO conversation_turns (principal, ciphertext, tainted, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      principal,
      ciphertext,
      entry.tainted ? 1 : 0,
      now,
      now + (entry.tainted ? TAINTED_HISTORY_TTL_MS : HISTORY_TTL_MS),
    );
    // Only the newest exchanges are ever read, so older rows are not kept.
    this.sql.exec(
      `DELETE FROM conversation_turns WHERE principal = ? AND id NOT IN (
         SELECT id FROM conversation_turns WHERE principal = ? ORDER BY id DESC LIMIT ?
       )`,
      principal,
      principal,
      MAX_EXCHANGES,
    );
  }

  /** The live exchanges, oldest first, cut to the character budget. */
  async recent(principal: string): Promise<HistoryEntry[]> {
    const rows = this.sql.exec(
      `SELECT id, ciphertext, tainted FROM conversation_turns
       WHERE principal = ? AND expires_at > ?
       ORDER BY id DESC LIMIT ?`,
      principal,
      this.now(),
      MAX_EXCHANGES,
    );

    const keyring = this.keyring();
    const newestFirst: HistoryEntry[] = [];
    let chars = 0;

    for (const row of rows) {
      let entry: HistoryEntry;
      try {
        const plain = await decryptToken(String(row['ciphertext']), keyring, {
          provider: AAD_PROVIDER,
          account: principal,
        });
        const parsed = JSON.parse(plain) as { u?: unknown; r?: unknown };
        if (typeof parsed.u !== 'string' || typeof parsed.r !== 'string') throw new Error('shape');
        entry = { user: parsed.u, reply: parsed.r, tainted: Number(row['tainted']) === 1 };
      } catch {
        this.sql.exec('DELETE FROM conversation_turns WHERE id = ?', row['id']);
        continue;
      }

      chars += entry.user.length + entry.reply.length;
      if (chars > MAX_HISTORY_CHARS && newestFirst.length > 0) break;
      newestFirst.push(entry);
    }

    return newestFirst.reverse();
  }

  /** `/forget`, `/pair off`. */
  wipe(principal: string): void {
    this.sql.exec('DELETE FROM conversation_turns WHERE principal = ?', principal);
  }

  purgeExpired(): void {
    this.sql.exec('DELETE FROM conversation_turns WHERE expires_at <= ?', this.now());
  }
}

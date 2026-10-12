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
import type { ConsentSource } from '../tools/registry.js';
import { isConsentSource } from './consents.js';

export const HISTORY_TTL_MS = 12 * 60 * 60 * 1000;
/** A turn that read text someone else wrote is remembered for less time. */
export const TAINTED_HISTORY_TTL_MS = 60 * 60 * 1000;
export const MAX_EXCHANGES = 6;
/** Roughly a thousand tokens of Hebrew. Oldest exchanges go first. */
export const MAX_HISTORY_CHARS = 2_400;

const AAD_PROVIDER = 'agent-history';

/**
 * `src` (2026-10-12, PLAN §6.19): the consent sources whose data the reply may
 * carry — its turn's tools and the history that turn saw in full. Absent on an
 * entry written before it existed, which a smart conversation therefore
 * replays without its reply (`replayByConsent`).
 */
export type HistoryEntry = { user: string; reply: string; tainted: boolean; src?: ConsentSource[] };

/** The sources behind these entries, in first-seen order. An untagged entry adds none. */
export function provenanceOf(entries: readonly HistoryEntry[]): ConsentSource[] {
  return [...new Set(entries.flatMap((entry) => entry.src ?? []))];
}

/**
 * What a smart conversation replays (2026-10-12): an entry whose reply may
 * carry a source the conversation does not allow now, or whose sources are
 * unknown (written before `src`), keeps the user's words and loses its reply
 * to the placeholder. `sources` are those of the entries replayed in full —
 * what the new reply may inherit.
 */
export function replayByConsent(
  entries: readonly HistoryEntry[],
  allowed: readonly ConsentSource[],
  placeholder: string,
): { entries: HistoryEntry[]; sources: ConsentSource[] } {
  const replayed = entries.map((entry) =>
    entry.src !== undefined && entry.src.every((source) => allowed.includes(source))
      ? entry
      : { ...entry, reply: placeholder, src: [] },
  );
  return { entries: replayed, sources: provenanceOf(replayed) };
}

/**
 * A conversation in the app (§6.18): its id, or '' for the one shared thread
 * (WhatsApp, and an app that sends none). Each keeps its own memory, under the
 * same limits. The id is part of the associated data, so a row only decrypts
 * in the conversation it was written in.
 */
function accountOf(principal: string, conversation: string): string {
  return conversation === '' ? principal : `${principal}/${conversation}`;
}

export class ConversationHistory {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly keyring: () => Keyring,
  ) {}

  async append(principal: string, entry: HistoryEntry, conversation = ''): Promise<void> {
    const ciphertext = await encryptToken(
      JSON.stringify({ u: entry.user, r: entry.reply, ...(entry.src ? { s: entry.src } : {}) }),
      this.keyring(),
      { provider: AAD_PROVIDER, account: accountOf(principal, conversation) },
    );
    const now = this.now();
    this.sql.exec(
      `INSERT INTO conversation_turns (principal, conversation, ciphertext, tainted, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      principal,
      conversation,
      ciphertext,
      entry.tainted ? 1 : 0,
      now,
      now + (entry.tainted ? TAINTED_HISTORY_TTL_MS : HISTORY_TTL_MS),
    );
    // Only the newest exchanges of a conversation are ever read, so older rows are not kept.
    this.sql.exec(
      `DELETE FROM conversation_turns WHERE principal = ? AND conversation = ? AND id NOT IN (
         SELECT id FROM conversation_turns WHERE principal = ? AND conversation = ? ORDER BY id DESC LIMIT ?
       )`,
      principal,
      conversation,
      principal,
      conversation,
      MAX_EXCHANGES,
    );
  }

  /** The live exchanges, oldest first, cut to the character budget. */
  async recent(principal: string, conversation = ''): Promise<HistoryEntry[]> {
    const rows = this.sql.exec(
      `SELECT id, ciphertext, tainted FROM conversation_turns
       WHERE principal = ? AND conversation = ? AND expires_at > ?
       ORDER BY id DESC LIMIT ?`,
      principal,
      conversation,
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
          account: accountOf(principal, conversation),
        });
        const parsed = JSON.parse(plain) as { u?: unknown; r?: unknown; s?: unknown };
        if (typeof parsed.u !== 'string' || typeof parsed.r !== 'string') throw new Error('shape');
        entry = { user: parsed.u, reply: parsed.r, tainted: Number(row['tainted']) === 1 };
        // Sources that do not read cleanly are unknown: replayed as a legacy entry.
        if (Array.isArray(parsed.s) && parsed.s.every(isConsentSource)) entry.src = parsed.s;
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

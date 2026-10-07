/**
 * Facts about the user (PLAN §6.26, ROADMAP block H part 18, 2026-10-07):
 * "תזכור עליי שאני גר ברחובות", "תזכור לתמיד שאני צמחוני".
 *
 * Unlike notes, the model sees these — every agent turn carries them as
 * "About the user". The user's decision, and an amendment to invariant 2. So a
 * fact is checked before it is kept (`containsPrivateData`), and the whole set
 * stays small: 25 facts, 800 characters.
 *
 * AES-GCM per row (`security/crypto.ts`). Encryption is awaited first; the cap
 * check and the insert are then one synchronous step.
 */
import type { SqlDriver } from '../core/sql.js';
import type { Keyring } from '../security/crypto.js';
import { decryptToken, encryptToken } from '../security/crypto.js';

export const MAX_FACTS = 25;
export const MAX_FACT_CHARS = 200;
export const MAX_FACTS_TOTAL_CHARS = 800;

export type Fact = { id: string; text: string; createdAt: number };

export type AddFactOutcome = { kind: 'added'; fact: Fact } | { kind: 'full' };

export class FactStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly keyring: () => Keyring,
  ) {}

  async add(principal: string, text: string): Promise<AddFactOutcome> {
    const clean = text.trim().slice(0, MAX_FACT_CHARS);
    const id = randomHex(12);
    const ciphertext = await encryptToken(clean, this.keyring(), aad(principal, id));
    return this.sql.transaction((): AddFactOutcome => {
      const row = this.sql.exec(
        'SELECT COUNT(*) AS n, COALESCE(SUM(chars), 0) AS c FROM facts WHERE principal = ?',
        principal,
      )[0];
      const count = Number(row?.['n'] ?? 0);
      const chars = Number(row?.['c'] ?? 0);
      if (count >= MAX_FACTS || chars + clean.length > MAX_FACTS_TOTAL_CHARS) return { kind: 'full' };
      const createdAt = this.now();
      this.sql.exec(
        'INSERT INTO facts (id, principal, ciphertext, chars, created_at) VALUES (?, ?, ?, ?, ?)',
        id,
        principal,
        ciphertext,
        clean.length,
        createdAt,
      );
      return { kind: 'added', fact: { id, text: clean, createdAt } };
    });
  }

  /** Oldest first: the order they were told. A row that no longer decrypts is dropped. */
  async all(principal: string): Promise<Fact[]> {
    const rows = this.sql.exec(
      'SELECT id, ciphertext, created_at FROM facts WHERE principal = ? ORDER BY created_at, rowid',
      principal,
    );
    const out: Fact[] = [];
    for (const row of rows) {
      const id = String(row['id']);
      try {
        const text = await decryptToken(String(row['ciphertext']), this.keyring(), aad(principal, id));
        out.push({ id, text, createdAt: Number(row['created_at']) });
      } catch {
        this.sql.exec('DELETE FROM facts WHERE id = ?', id);
      }
    }
    return out;
  }

  /** False when it was already gone. */
  remove(id: string, principal: string): boolean {
    return this.sql.exec('DELETE FROM facts WHERE id = ? AND principal = ? RETURNING id', id, principal).length > 0;
  }

  /** `/forget memory`. */
  wipe(principal: string): number {
    return this.sql.exec('DELETE FROM facts WHERE principal = ? RETURNING id', principal).length;
  }
}

const aad = (principal: string, id: string) => ({ provider: 'fact', account: `${principal}:${id}` });

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Notes: "תזכור ש…" (PLAN §6.22, ROADMAP #9, 2026-10-05).
 *
 * The user's own words, kept for them and shown only by code. The tools that
 * read them are private (`ToolSpec.private`): no note reaches the model, in a
 * tool result or in the agent's history.
 *
 * Synchronous over `SqlDriver`, so the cap check and the insert are one step.
 */
import type { SqlDriver } from '../core/sql.js';

export const MAX_NOTES = 200;
export const MAX_NOTE_CHARS = 500;

export type Note = { id: string; text: string; createdAt: number };

export class NoteStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** Null when the list is full: a note is never dropped to make room. */
  add(principal: string, text: string): Note | null {
    return this.sql.transaction(() => {
      const count = Number(this.sql.exec('SELECT COUNT(*) AS n FROM notes WHERE principal = ?', principal)[0]?.['n'] ?? 0);
      if (count >= MAX_NOTES) return null;
      const note = { id: randomHex(12), text: text.slice(0, MAX_NOTE_CHARS), createdAt: this.now() };
      this.sql.exec(
        'INSERT INTO notes (id, principal, text, created_at) VALUES (?, ?, ?, ?)',
        note.id,
        principal,
        note.text,
        note.createdAt,
      );
      return note;
    });
  }

  /** Newest first. */
  all(principal: string): Note[] {
    return this.sql
      .exec('SELECT id, text, created_at FROM notes WHERE principal = ? ORDER BY created_at DESC LIMIT ?', principal, MAX_NOTES)
      .map((row) => ({ id: String(row['id']), text: String(row['text']), createdAt: Number(row['created_at']) }));
  }

  byId(id: string, principal: string): Note | null {
    const row = this.sql.exec('SELECT id, text, created_at FROM notes WHERE id = ? AND principal = ?', id, principal)[0];
    return row ? { id: String(row['id']), text: String(row['text']), createdAt: Number(row['created_at']) } : null;
  }

  /** False when it was already gone — another delete, or an Undo. */
  remove(id: string, principal: string): boolean {
    return this.sql.exec('DELETE FROM notes WHERE id = ? AND principal = ? RETURNING id', id, principal).length > 0;
  }
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

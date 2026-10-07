/**
 * Named lists (PLAN §6.25, ROADMAP block H part 17, 2026-10-07): "תוסיף חלב
 * לרשימת קניות", "תראה לי את רשימת המניות".
 *
 * Private like notes: the tools that read a list never hand it to the model.
 * Synchronous over `SqlDriver`, so every check and its write are one step.
 *
 * A list is found by its key: the name folded (`foldForMatch`), generic words
 * ("רשימה", "רשימת", "list") taken out. Keys are compared with and without one
 * leading ה, so "הקניות" is "קניות". An exact key wins; only without one does a
 * substring match count.
 *
 * Removals are soft and every change bumps `version`. An Undo names the rows
 * and the versions it expects; if any of them changed since, the whole Undo is
 * refused — never a partial one, never an overwrite of a newer edit.
 */
import type { SqlDriver } from '../core/sql.js';
import { foldForMatch } from './match.js';
import { UNDO_EXPIRY_MS } from '../confirm/undo.js';

export const MAX_LISTS = 30;
export const MAX_ITEMS_PER_LIST = 100;
export const MAX_ITEM_CHARS = 200;
export const MAX_LIST_NAME_CHARS = 40;

export type ListSummary = { id: string; name: string; count: number };
export type ListItem = { id: string; text: string };
export type RowVersion = { id: string; version: number };

/** "רשימה", "רשימת", "list" name lists in general, never one list. */
const GENERIC = new Set(['רשימה', 'רשימת', 'הרשימה', 'רשימות', 'הרשימות', 'list', 'lists', 'the', 'my', 'שלי'].map(foldForMatch));

/** A list name's key. Empty when nothing but generic words was said. */
export function listKey(name: string): string {
  return foldForMatch(name)
    .split(' ')
    .filter((word) => word.length > 0 && !GENERIC.has(word))
    .join(' ');
}

/** An item's key: the item folded. */
export function itemKey(text: string): string {
  return foldForMatch(text);
}

/** The key, and the key without one leading ה ("הקניות" = "קניות"). */
function keyForms(key: string): string[] {
  return key.startsWith('ה') && key.length > 2 ? [key, key.slice(1)] : [key];
}

const sameKey = (a: string, b: string): boolean => keyForms(a).some((form) => keyForms(b).includes(form));

export type AddOutcome =
  | {
      kind: 'added';
      listId: string;
      listName: string;
      created: boolean;
      added: Array<ListItem & { version: number }>;
      /** Already on the list: skipped, not a failure. */
      skipped: string[];
    }
  | { kind: 'lists_full' }
  | { kind: 'list_full' }
  /** The list was deleted between the question and the add. */
  | { kind: 'gone' };

export type UndoOutcome = 'done' | 'changed' | 'full' | 'clash';

export class ListStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** Active lists with their item counts, newest first. */
  lists(principal: string): ListSummary[] {
    return this.sql
      .exec(
        `SELECT l.id, l.name, (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.removed_at IS NULL) AS n
         FROM lists l WHERE l.principal = ? AND l.removed_at IS NULL ORDER BY l.created_at DESC, l.name, l.id`,
        principal,
      )
      .map((row) => ({ id: String(row['id']), name: String(row['name']), count: Number(row['n']) }));
  }

  /**
   * The lists the words name: an exact key first, else every list whose key
   * holds the words or is held by them. Empty when nothing matches.
   */
  find(principal: string, variants: readonly string[]): ListSummary[] {
    const keys = variants.map(listKey).filter((key) => key.length > 0);
    if (keys.length === 0) return [];
    const all = this.lists(principal).map((list) => ({ list, key: listKey(list.name) }));
    const exact = all.filter(({ key }) => keys.some((wanted) => sameKey(key, wanted)));
    if (exact.length > 0) return exact.map(({ list }) => list);
    return all
      .filter(({ key }) => keys.some((wanted) => key.includes(wanted) || wanted.includes(key)))
      .map(({ list }) => list);
  }

  items(listId: string): ListItem[] {
    return this.sql
      .exec('SELECT id, text FROM list_items WHERE list_id = ? AND removed_at IS NULL ORDER BY position, id', listId)
      .map((row) => ({ id: String(row['id']), text: String(row['text']) }));
  }

  /**
   * Add items to a list, or to a new one by that name. Items already on the
   * list are skipped. All or nothing against the caps.
   */
  add(principal: string, target: { listId: string } | { newName: string }, texts: readonly string[]): AddOutcome {
    return this.sql.transaction((): AddOutcome => {
      let listId: string;
      let listName: string;
      let created = false;

      if ('listId' in target) {
        const row = this.sql.exec(
          'SELECT id, name FROM lists WHERE id = ? AND principal = ? AND removed_at IS NULL',
          target.listId,
          principal,
        )[0];
        if (!row) return { kind: 'gone' };
        listId = String(row['id']);
        listName = String(row['name']);
      } else {
        const name = target.newName.trim().slice(0, MAX_LIST_NAME_CHARS);
        const key = listKey(name);
        const same = this.lists(principal).find((list) => sameKey(listKey(list.name), key));
        if (same) {
          listId = same.id;
          listName = same.name;
        } else {
          if (this.lists(principal).length >= MAX_LISTS) return { kind: 'lists_full' };
          listId = randomHex(12);
          listName = name;
          created = true;
          this.sql.exec(
            'INSERT INTO lists (id, principal, name, name_key, created_at) VALUES (?, ?, ?, ?, ?)',
            listId,
            principal,
            listName,
            key,
            this.now(),
          );
        }
      }

      const present = new Set(this.items(listId).map((item) => itemKey(item.text)));
      const fresh: string[] = [];
      const skipped: string[] = [];
      for (const raw of texts) {
        const text = raw.trim().slice(0, MAX_ITEM_CHARS);
        const key = itemKey(text);
        if (key.length === 0) continue;
        if (present.has(key)) skipped.push(text);
        else {
          present.add(key);
          fresh.push(text);
        }
      }
      if (this.items(listId).length + fresh.length > MAX_ITEMS_PER_LIST) {
        // Nothing lands, not even a list made for these items.
        if (created) this.sql.exec('DELETE FROM lists WHERE id = ?', listId);
        return { kind: 'list_full' };
      }

      const last = Number(
        this.sql.exec('SELECT COALESCE(MAX(position), 0) AS p FROM list_items WHERE list_id = ?', listId)[0]?.['p'] ?? 0,
      );
      const added = fresh.map((text, index) => {
        const id = randomHex(12);
        this.sql.exec(
          'INSERT INTO list_items (id, list_id, text, item_key, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          id,
          listId,
          text,
          itemKey(text),
          last + index + 1,
          this.now(),
        );
        return { id, text, version: 0 };
      });
      return { kind: 'added', listId, listName, created, added, skipped };
    });
  }

  /** Soft-delete these items. Returns what was removed, with its new versions. */
  removeItems(listId: string, itemIds: readonly string[]): Array<ListItem & { version: number }> {
    return this.sql.transaction(() => {
      const now = this.now();
      const out: Array<ListItem & { version: number }> = [];
      for (const id of itemIds) {
        const row = this.sql.exec(
          `UPDATE list_items SET removed_at = ?, version = version + 1
           WHERE id = ? AND list_id = ? AND removed_at IS NULL RETURNING id, text, version`,
          now,
          id,
          listId,
        )[0];
        if (row) out.push({ id: String(row['id']), text: String(row['text']), version: Number(row['version']) });
      }
      return out;
    });
  }

  /**
   * Soft-delete a list and its active items, with one `removed_at`. Null when
   * already gone. Confirmed first (Tier 2), so nothing undoes it; the rows are
   * purged with the rest once the Undo window has passed.
   */
  deleteList(listId: string, principal: string): { list: RowVersion; items: RowVersion[]; removedAt: number } | null {
    return this.sql.transaction(() => {
      const now = this.now();
      const list = this.sql.exec(
        `UPDATE lists SET removed_at = ?, version = version + 1
         WHERE id = ? AND principal = ? AND removed_at IS NULL RETURNING id, version`,
        now,
        listId,
        principal,
      )[0];
      if (!list) return null;
      const items = this.sql
        .exec(
          `UPDATE list_items SET removed_at = ?, version = version + 1
           WHERE list_id = ? AND removed_at IS NULL RETURNING id, version`,
          now,
          listId,
        )
        .map((row) => ({ id: String(row['id']), version: Number(row['version']) }));
      return { list: { id: String(list['id']), version: Number(list['version']) }, items, removedAt: now };
    });
  }

  /**
   * Undo an add: its own items go; the list goes too only if it was made by
   * this add and holds nothing else. Refused whole if any item changed since.
   */
  undoAdd(principal: string, listId: string, created: boolean, items: readonly RowVersion[]): UndoOutcome {
    return this.sql.transaction((): UndoOutcome => {
      if (!items.every((item) => this.isActiveAt(item))) return 'changed';
      const now = this.now();
      for (const item of items) {
        this.sql.exec('UPDATE list_items SET removed_at = ?, version = version + 1 WHERE id = ?', now, item.id);
      }
      if (created && this.items(listId).length === 0) {
        this.sql.exec(
          'UPDATE lists SET removed_at = ?, version = version + 1 WHERE id = ? AND principal = ? AND removed_at IS NULL',
          now,
          listId,
          principal,
        );
      }
      return 'done';
    });
  }

  /** Undo a removal: put the items back, unless one changed, one is back already, or the list is full. */
  undoRemove(listId: string, items: readonly RowVersion[]): UndoOutcome {
    return this.sql.transaction((): UndoOutcome => {
      if (!items.every((item) => this.isRemovedAt(item))) return 'changed';
      const listAlive = this.sql.exec('SELECT 1 FROM lists WHERE id = ? AND removed_at IS NULL', listId).length > 0;
      if (!listAlive) return 'changed';
      const present = new Set(this.items(listId).map((item) => itemKey(item.text)));
      const back = items.map((item) => String(this.sql.exec('SELECT item_key FROM list_items WHERE id = ?', item.id)[0]?.['item_key']));
      if (back.some((key) => present.has(key))) return 'clash';
      if (present.size + items.length > MAX_ITEMS_PER_LIST) return 'full';
      for (const item of items) {
        this.sql.exec('UPDATE list_items SET removed_at = NULL, version = version + 1 WHERE id = ?', item.id);
      }
      return 'done';
    });
  }

  /** Soft-deleted rows, once no Undo can bring them back. */
  purgeRemoved(): void {
    const cutoff = this.now() - UNDO_EXPIRY_MS;
    this.sql.exec('DELETE FROM list_items WHERE removed_at IS NOT NULL AND removed_at < ?', cutoff);
    this.sql.exec(
      'DELETE FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE removed_at IS NOT NULL AND removed_at < ?)',
      cutoff,
    );
    this.sql.exec('DELETE FROM lists WHERE removed_at IS NOT NULL AND removed_at < ?', cutoff);
  }

  private isActiveAt(row: RowVersion): boolean {
    return (
      this.sql.exec('SELECT 1 FROM list_items WHERE id = ? AND version = ? AND removed_at IS NULL', row.id, row.version)
        .length > 0
    );
  }

  private isRemovedAt(row: RowVersion, table: 'list_items' | 'lists' = 'list_items'): boolean {
    return (
      this.sql.exec(`SELECT 1 FROM ${table} WHERE id = ? AND version = ? AND removed_at IS NOT NULL`, row.id, row.version)
        .length > 0
    );
  }
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

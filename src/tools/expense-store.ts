/**
 * Expenses (PLAN §6.22, ROADMAP #10, 2026-10-05).
 *
 * Kept on the server, summed in SQL, exported as CSV through an app card. An
 * expense is a local day and a whole number of agorot, so a sum is exact and
 * no clock change moves one.
 */
import type { SqlDriver } from '../core/sql.js';

/** Closed: the model picks one, and code names it. */
export const EXPENSE_CATEGORIES = [
  'food',
  'groceries',
  'fuel',
  'transport',
  'shopping',
  'bills',
  'health',
  'fun',
  'home',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const MAX_EXPENSES = 20_000;
export const MAX_DESCRIPTION_CHARS = 60;
/** The CSV carries at most this many rows, and at most this many bytes. */
export const MAX_EXPORT_ROWS = 2_000;
export const MAX_EXPORT_BYTES = 150_000;

export type Expense = {
  id: string;
  amountAgorot: number;
  category: ExpenseCategory;
  description: string | null;
  /** `YYYY-MM-DD`, local. */
  spentOn: string;
};

export type CategoryTotal = { category: ExpenseCategory; agorot: number; count: number };

export class ExpenseStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
  ) {}

  /** Null when the table is full for this principal. */
  add(principal: string, expense: Omit<Expense, 'id'>): Expense | null {
    return this.sql.transaction(() => {
      const count = Number(this.sql.exec('SELECT COUNT(*) AS n FROM expenses WHERE principal = ?', principal)[0]?.['n'] ?? 0);
      if (count >= MAX_EXPENSES) return null;
      const row: Expense = { id: randomHex(12), ...expense };
      this.sql.exec(
        `INSERT INTO expenses (id, principal, amount_agorot, category, description, spent_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        principal,
        row.amountAgorot,
        row.category,
        row.description,
        row.spentOn,
        this.now(),
      );
      return row;
    });
  }

  /** False when it was already gone. */
  remove(id: string, principal: string): boolean {
    return this.sql.exec('DELETE FROM expenses WHERE id = ? AND principal = ? RETURNING id', id, principal).length > 0;
  }

  /** Totals per category between two local days, both included, largest first. */
  totals(principal: string, from: string, to: string, category?: ExpenseCategory): CategoryTotal[] {
    const rows = this.sql.exec(
      `SELECT category, SUM(amount_agorot) AS agorot, COUNT(*) AS n FROM expenses
       WHERE principal = ? AND spent_on >= ? AND spent_on <= ?${category ? ' AND category = ?' : ''}
       GROUP BY category ORDER BY agorot DESC`,
      principal,
      from,
      to,
      ...(category ? [category] : []),
    );
    return rows.flatMap((row) => {
      const name = asCategory(row['category']);
      return name ? [{ category: name, agorot: Number(row['agorot']), count: Number(row['n']) }] : [];
    });
  }

  /** Newest first, for the export. */
  between(principal: string, from: string, to: string, limit: number): Expense[] {
    return this.sql
      .exec(
        `SELECT id, amount_agorot, category, description, spent_on FROM expenses
         WHERE principal = ? AND spent_on >= ? AND spent_on <= ?
         ORDER BY spent_on DESC, created_at DESC LIMIT ?`,
        principal,
        from,
        to,
        limit,
      )
      .map((row) => ({
        id: String(row['id']),
        amountAgorot: Number(row['amount_agorot']),
        category: asCategory(row['category']) ?? 'other',
        description: typeof row['description'] === 'string' ? row['description'] : null,
        spentOn: String(row['spent_on']),
      }));
  }
}

function asCategory(value: unknown): ExpenseCategory | null {
  return typeof value === 'string' && (EXPENSE_CATEGORIES as readonly string[]).includes(value)
    ? (value as ExpenseCategory)
    : null;
}

/** `12.50`: a decimal point, no grouping, so a spreadsheet reads it as a number. */
export function formatAgorot(agorot: number): string {
  return `${Math.floor(agorot / 100)}.${String(agorot % 100).padStart(2, '0')}`;
}

/**
 * The export (RFC 4180, CRLF, a UTF-8 BOM so Excel reads the Hebrew).
 *
 * Rows are taken newest first until either cap, then written oldest first.
 * Every text cell is guarded against formula injection: one that starts with
 * = + - @ or a tab or carriage return gets a leading apostrophe, so a
 * description can never run as a formula when the file is opened.
 */
export function expensesCsv(
  rows: readonly Expense[],
  header: readonly string[],
  categoryName: (category: ExpenseCategory) => string,
): { content: string; rows: number; cut: boolean } {
  const encoder = new TextEncoder();
  const head = `${BOM}${header.map(cell).join(',')}\r\n`;
  let bytes = encoder.encode(head).length;
  const lines: string[] = [];
  let cut = rows.length > MAX_EXPORT_ROWS;

  for (const row of rows.slice(0, MAX_EXPORT_ROWS)) {
    const line = `${[row.spentOn, formatAgorot(row.amountAgorot), cell(categoryName(row.category)), cell(row.description ?? '')].join(',')}\r\n`;
    const size = encoder.encode(line).length;
    if (bytes + size > MAX_EXPORT_BYTES) {
      cut = true;
      break;
    }
    bytes += size;
    lines.push(line);
  }
  return { content: head + lines.reverse().join(''), rows: lines.length, cut };
}

/** Without it Excel reads the file as the local code page, and the Hebrew breaks. */
const BOM = String.fromCharCode(0xfeff);

function cell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Notes and expenses, tool by tool (PLAN §6.22, 2026-10-05).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { NoteStore, MAX_NOTES } from '../../../src/tools/note-store.js';
import { ExpenseStore, expensesCsv, MAX_EXPORT_BYTES, MAX_EXPORT_ROWS } from '../../../src/tools/expense-store.js';
import type { Expense } from '../../../src/tools/expense-store.js';
import { LIST_LIMIT, notesDelete, notesFind, notesSave, searchTerms } from '../../../src/tools/notes.js';
import { expensesAdd, expensesExport, expensesSummary } from '../../../src/tools/expenses.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_personal';

describe('notes and expenses', () => {
  let driver: TestSqlDriver;
  let notes: NoteStore;
  let expenses: ExpenseStore;
  let ctx: ToolContext;

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    notes = new NoteStore(driver, () => NOW);
    expenses = new ExpenseStore(driver, () => NOW);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      notes,
      expenses,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
    };
  });
  afterEach(() => driver.close());

  describe('notes', () => {
    it('asks what to keep when nothing was said', () => {
      expect(notesSave.resolve({}, ctx)).toEqual({ kind: 'clarify', clarify: { code: 'personal', what: 'note_text' } });
    });

    it('never drops an old note to make room', async () => {
      for (let i = 0; i < MAX_NOTES; i++) notes.add(PRINCIPAL, `פתק ${i}`);
      const result = await notesSave.execute({ text: 'עוד אחד' }, ctx);
      expect(result.text).toContain('המקסימום');
      expect(notes.all(PRINCIPAL)).toHaveLength(MAX_NOTES);
    });

    it('keeps each principal\'s notes apart', () => {
      const note = notes.add('p_other', 'לא שלך')!;
      expect(notes.all(PRINCIPAL)).toEqual([]);
      expect(notes.remove(note.id, PRINCIPAL)).toBe(false);
    });

    it('says a note is gone, rather than failing, when it went before the tap', async () => {
      const note = notes.add(PRINCIPAL, 'פתק')!;
      const ready = notesDelete.resolve({ query_variants: ['פתק'] }, ctx);
      if (ready.kind !== 'ready') throw new Error('expected ready');
      notes.remove(note.id, PRINCIPAL);
      expect((await notesDelete.execute(ready.input, ctx)).text).toBe('הפתק הזה כבר לא קיים.');
    });
  });

  describe('notes.find (2026-10-07)', () => {
    const find = async (variants: string[]) =>
      stripIsolates((await notesFind.execute({ variants }, ctx)).text);

    it('drops words that name notes in general', () => {
      expect(searchTerms(['הפתקים שלי', 'my notes', 'כל הפתקים'])).toEqual([]);
      expect(searchTerms(['הפתק על החניה'])).toEqual(['על החניה']);
    });

    it('lists every note for "my notes", which no note contains', async () => {
      notes.add(PRINCIPAL, 'AAPL 10, MSFT 5');
      const text = await find(['הפתקים שלי', 'notes']);
      expect(text).toContain('הפתקים האחרונים:');
      expect(text).toContain('AAPL 10, MSFT 5');
    });

    it('answers a search that matched nothing with the latest notes, never a dead end', async () => {
      notes.add(PRINCIPAL, 'AAPL 10, MSFT 5');
      const text = await find(['רשימת המניות', 'stocks list']);
      expect(text).toContain('לא מצאתי התאמה. הנה הפתקים האחרונים:');
      expect(text).toContain('AAPL 10, MSFT 5');
    });

    it('still finds by a word in the note', async () => {
      notes.add(PRINCIPAL, 'קוד השער 1234');
      notes.add(PRINCIPAL, 'מספר חניה 7');
      const text = await find(['השער']);
      expect(text).toContain('מצאתי:');
      expect(text).toContain('קוד השער');
      expect(text).not.toContain('חניה');
    });

    it('says how many more there are past the limit', async () => {
      for (let i = 0; i < LIST_LIMIT + 3; i++) notes.add(PRINCIPAL, `פתק ${i}`);
      expect(await find([])).toContain('ועוד 3. אפשר לחפש לפי מילה מהפתק.');
    });
  });

  describe('expenses.add', () => {
    const ready = (slots: Record<string, unknown>) => {
      const out = expensesAdd.resolve(slots, ctx);
      if (out.kind !== 'ready') throw new Error(`expected ready, got ${JSON.stringify(out)}`);
      return out.input as { agorot: number; category: string; spentOn: string; description: string | null };
    };

    it('stores whole agorot and defaults the category', () => {
      expect(ready({ amount: 12.5 })).toEqual({ agorot: 1250, category: 'other', description: null, spentOn: '2026-09-24' });
    });

    it('reads yesterday and a past weekday', () => {
      expect(ready({ amount: 10, days_ago: 1 }).spentOn).toBe('2026-09-23');
      expect(ready({ amount: 10, weekday: 0 }).spentOn).toBe('2026-09-20');
      expect(ready({ amount: 10, on_date: { day: 20, month: 12 } }).spentOn).toBe('2025-12-20');
    });

    it('asks how much, and asks about a day still to come', () => {
      expect(expensesAdd.resolve({ category: 'food' }, ctx)).toMatchObject({ clarify: { what: 'expense_amount' } });
      expect(
        expensesAdd.resolve({ amount: 10, on_date: { day: 30, month: 9, year: 2026 } }, ctx),
      ).toMatchObject({ clarify: { what: 'expense_future' } });
    });

    it('Undo removes it, and says so honestly when it is already gone', async () => {
      const result = await expensesAdd.execute(ready({ amount: 20 }), ctx);
      expect((await expensesAdd.undo!(result.compensating, ctx)).text).toBe('ההוצאה נמחקה.');
      expect((await expensesAdd.undo!(result.compensating, ctx)).text).toBe('ההוצאה הזאת כבר לא קיימת.');
    });
  });

  describe('expenses.summary', () => {
    it('sums one category, and says when there is nothing', async () => {
      expenses.add(PRINCIPAL, { amountAgorot: 1050, category: 'food', description: null, spentOn: '2026-09-01' });
      expenses.add(PRINCIPAL, { amountAgorot: 2000, category: 'food', description: null, spentOn: '2026-08-31' });
      const out = expensesSummary.resolve({ period: 'this_month', category: 'food' }, ctx);
      if (out.kind !== 'ready') throw new Error('expected ready');
      expect(stripIsolates((await expensesSummary.execute(out.input, ctx)).text)).toBe('סך ההוצאות החודש: ₪10.50 (הוצאה אחת)');

      const empty = expensesSummary.resolve({ period: 'today' }, ctx);
      if (empty.kind !== 'ready') throw new Error('expected ready');
      expect((await expensesSummary.execute(empty.input, ctx)).text).toBe('אין הוצאות רשומות בתקופה הזאת.');
    });
  });

  describe('the CSV', () => {
    const row = (i: number, description: string | null = null): Expense => ({
      id: String(i),
      amountAgorot: 100 + i,
      category: 'food',
      description,
      spentOn: '2026-09-01',
    });

    it('starts with a BOM, uses CRLF, and writes oldest first', () => {
      const csv = expensesCsv([row(2), row(1)], ['תאריך', 'סכום', 'קטגוריה', 'תיאור'], () => 'אוכל');
      expect(csv.content.charCodeAt(0)).toBe(0xfeff);
      expect(csv.content.slice(1).split('\r\n')).toEqual([
        'תאריך,סכום,קטגוריה,תיאור',
        '2026-09-01,1.01,אוכל,',
        '2026-09-01,1.02,אוכל,',
        '',
      ]);
    });

    it('quotes commas and quotes, and defuses a formula', () => {
      const csv = expensesCsv([row(1, 'a, "b"'), row(2, '+1'), row(3, '@x')], ['h'], () => 'c');
      expect(csv.content).toContain('"a, ""b"""');
      expect(csv.content).toContain(",'+1");
      expect(csv.content).toContain(",'@x");
    });

    it('stops at the row cap and the byte cap, and says it cut', () => {
      const many = Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => row(i));
      const byRows = expensesCsv(many, ['h'], () => 'c');
      expect(byRows).toMatchObject({ rows: MAX_EXPORT_ROWS, cut: true });

      const long = Array.from({ length: 1_500 }, (_, i) => row(i, 'א'.repeat(60)));
      const byBytes = expensesCsv(long, ['h'], () => 'c');
      expect(byBytes.cut).toBe(true);
      expect(new TextEncoder().encode(byBytes.content).length).toBeLessThanOrEqual(MAX_EXPORT_BYTES);
    });
  });

  describe('expenses.export', () => {
    it('has nothing to export: says so, offers no card', () => {
      expect(expensesExport.resolve({}, ctx)).toMatchObject({ clarify: { what: 'no_expenses' } });
    });

    it('is never executed on the server: a card runs on the phone', async () => {
      await expect(expensesExport.execute({}, ctx)).rejects.toThrow();
    });
  });
});

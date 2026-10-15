/**
 * The monthly bookkeeping file (block L, L4): the month's bounds, the CSV and
 * its notes (a partial scan is never presented as complete), the bills query
 * in seconds, and where the tool is offered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ExpenseStore } from '../../../src/tools/expense-store.js';
import { buildMonthlyPack, monthlyCsv, monthSpan, namesMonthlyPack } from '../../../src/tools/monthly-pack.js';
import { buildBillsQueryBetween, MAX_BILLS } from '../../../src/tools/bills.js';
import { GmailClient } from '../../../src/google/gmail.js';
import { agentToolNames, smartOfferedTools } from '../../../src/agent/tools.js';

const ME = 'p_me0000000000';

describe('monthSpan', () => {
  it('last month by default, with local midnight bounds', () => {
    const span = monthSpan(Date.UTC(2026, 9, 1, 7, 0)); // 1 Oct 2026, 10:00 local
    expect(span).toMatchObject({ year: 2026, month: 9, key: '2026-09', from: '2026-09-01', to: '2026-09-30' });
    expect(span.startUtc).toBe(Date.UTC(2026, 7, 31, 21, 0)); // 00:00 IDT
    expect(span.endUtc).toBe(Date.UTC(2026, 8, 30, 21, 0));
  });

  it('January asks for last December; a named month that has not ended this year is last year\'s', () => {
    expect(monthSpan(Date.UTC(2027, 0, 10, 8)).key).toBe('2026-12');
    expect(monthSpan(Date.UTC(2026, 9, 15, 8), 9).key).toBe('2026-09');
    expect(monthSpan(Date.UTC(2026, 9, 15, 8), 10).key).toBe('2025-10');
    expect(monthSpan(Date.UTC(2026, 9, 15, 8), 12).key).toBe('2025-12');
    expect(monthSpan(Date.UTC(2026, 9, 15, 8), 2).to).toBe('2026-02-28');
  });

  it('a month across the fall-back ends at local midnight (UTC+2)', () => {
    const october = monthSpan(Date.UTC(2026, 10, 5, 8));
    expect(october.endUtc).toBe(Date.UTC(2026, 9, 31, 22, 0));
  });
});

describe('buildBillsQueryBetween', () => {
  it('uses whole epoch seconds, never milliseconds', () => {
    const query = buildBillsQueryBetween(1_790_000_000_123, 1_792_000_000_999);
    expect(query.startsWith('after:1790000000 before:1792000000 ')).toBe(true);
  });
});

describe('monthlyCsv', () => {
  const expense = (spentOn: string, agorot: number, category: 'food' | 'fuel' = 'food', description: string | null = null) => ({
    id: spentOn + agorot,
    amountAgorot: agorot,
    category,
    description,
    spentOn,
  });

  it('notes first, then expenses by date, totals by category and in all, then bills; BOM for Excel', () => {
    const csv = monthlyCsv({
      expenses: [expense('2026-09-10', 4000, 'food'), expense('2026-09-02', 25000, 'fuel'), expense('2026-09-05', 1000, 'food')],
      expensesCut: false,
      bills: [{ from: 'חברת החשמל', subject: 'חשבון תקופתי', at: Date.UTC(2026, 8, 3, 7), facts: { amount: 312.4, due: { year: 2026, month: 9, day: 20 } } }],
      coverage: { kind: 'read', count: 1, skipped: 0, capped: false },
      lang: 'he',
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toContain('סוג');
    expect(lines.slice(1).findIndex((l) => l.startsWith('הוצאה'))).toBeGreaterThan(0);
    const expenseLines = lines.filter((l) => l.startsWith('הוצאה'));
    expect(expenseLines.map((l) => l.split(',')[1])).toEqual(['2026-09-02', '2026-09-05', '2026-09-10']);
    expect(lines.find((l) => l.startsWith('סך הכול'))).toContain('300.00');
    expect(lines.find((l) => l.startsWith('חשבון מהמייל'))).toContain('312.40');
    expect(csv).toContain('לתשלום עד 2026-09-20');
    expect(csv).toContain('עלולים להיות חסרים');
  });

  it('never silent about what it does not cover: no Gmail, a capped scan, unreadable mails', () => {
    const none = monthlyCsv({ expenses: [], expensesCut: false, bills: null, coverage: { kind: 'unavailable' }, lang: 'he' });
    expect(none).toContain('לא נכללו');
    const capped = monthlyCsv({ expenses: [], expensesCut: true, bills: [], coverage: { kind: 'read', count: 0, skipped: 2, capped: true }, lang: 'he' });
    expect(capped).toContain('ייתכן שיש עוד חשבונות');
    expect(capped).toContain('2 מיילים לא נקראו');
    expect(capped).toContain('קוצרה');
  });

  it('a formula-looking description is defused', () => {
    const csv = monthlyCsv({ expenses: [expense('2026-09-01', 100, 'food', '=HYPERLINK("x")')], expensesCut: false, bills: [], coverage: { kind: 'read', count: 0, skipped: 0, capped: false }, lang: 'he' });
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('buildMonthlyPack', () => {
  let driver: TestSqlDriver;
  let expenses: ExpenseStore;
  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    expenses = new ExpenseStore(driver, () => Date.UTC(2026, 9, 1, 7));
  });
  afterEach(() => driver.close());

  const span = monthSpan(Date.UTC(2026, 9, 1, 7));

  it('only the month asked for; without Gmail the file still goes, saying why', async () => {
    expenses.add(ME, { amountAgorot: 1000, category: 'food', description: null, spentOn: '2026-09-30' });
    expenses.add(ME, { amountAgorot: 2000, category: 'food', description: null, spentOn: '2026-10-01' });
    const built = await buildMonthlyPack({ principal: ME, expenses, gmail: null, span, lang: 'he' });
    expect(built.expenses).toBe(1);
    expect(built.coverage).toEqual({ kind: 'unavailable' });
    expect(built.input.name).toBe('monthly-2026-09.csv');
    expect(built.input.content).toContain('לא נכללו');
  });

  it('a bills scan that hit the cap or skipped mails says so', async () => {
    const calls: string[] = [];
    const gmail = new GmailClient({
      async call(url: string) {
        calls.push(url);
        if (url.includes('/messages?')) {
          return { ok: true, value: { messages: Array.from({ length: MAX_BILLS }, (_, i) => ({ id: `m${i}` })), nextPageToken: 'more' } };
        }
        if (url.includes('format=metadata')) {
          if (url.includes('/m0?')) return { ok: false, error: { code: 'provider_error', status: 500 } };
          const id = /messages\/(m\d+)/.exec(url)![1]!;
          return { ok: true, value: { id, threadId: `t${id}`, internalDate: String(Date.UTC(2026, 8, 3)), payload: { headers: [{ name: 'From', value: 'Bills <b@example.com>' }, { name: 'Subject', value: 'חשבונית' }] } } };
        }
        return { ok: true, value: { payload: {} } };
      },
    });
    const built = await buildMonthlyPack({ principal: ME, expenses, gmail, span, lang: 'he' });
    expect(built.coverage).toMatchObject({ kind: 'read', skipped: 1, capped: true });
    expect(built.input.content).toContain('ייתכן שיש עוד חשבונות');
    expect(calls[0]).toMatch(/after%3A\d{10}%20before%3A\d{10}/);
  });
});

describe('expenses.monthly_pack in the catalog', () => {
  const base = { cards: true, fileCards: true } as const;

  it('offered only when the words ask for it, with file cards; never in a smart conversation', () => {
    expect(agentToolNames(base)).not.toContain('expenses.monthly_pack');
    expect(agentToolNames({ ...base, monthly: true })).toContain('expenses.monthly_pack');
    expect(agentToolNames({ cards: true, monthly: true })).not.toContain('expenses.monthly_pack');
    expect(smartOfferedTools(agentToolNames({ ...base, monthly: true }), { granted: ['mail', 'expenses'], ask: true })).not.toContain('expenses.monthly_pack');
  });

  it('namesMonthlyPack', () => {
    for (const text of ['תכין לי את הקובץ החודשי לרואה החשבון', 'דוח חודשי להנהלת חשבונות', 'monthly report for my accountant']) {
      expect(namesMonthlyPack(text), text).toBe(true);
    }
    for (const text of ['כמה הוצאתי החודש?', 'תייצא לי את ההוצאות לאקסל']) expect(namesMonthlyPack(text), text).toBe(false);
  });
});

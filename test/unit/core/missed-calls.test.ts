/**
 * Missed calls for the digest (ROADMAP #20, 2026-10-06): the store's one-digest
 * life, and the digest's line. No network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { ASK_WINDOW_MS, MissedCallStore } from '../../../src/core/missed-calls.js';
import { buildDigest } from '../../../src/core/digest.js';
import { BirthdayStore } from '../../../src/core/birthdays.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import type { ContactsClient } from '../../../src/google/contacts.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({ id: i + 1, sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8') }));

/** Tuesday 2026-10-06, 07:00 local. */
const NOW = Date.parse('2026-10-06T04:00:00Z');
const PRINCIPAL = 'p_calls';
const HOUR = 3_600_000;

describe('MissedCallStore', () => {
  let driver: TestSqlDriver;
  let now: number;
  let store: MissedCallStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = NOW;
    store = new MissedCallStore(driver, () => now);
  });
  afterEach(() => driver.close());

  it('refuses a report nobody asked for', () => {
    expect(store.accept(PRINCIPAL, [{ name: 'דנה', at: NOW - HOUR }])).toBe(false);
    expect(driver.exec('SELECT COUNT(*) AS n FROM missed_calls')[0]).toEqual({ n: 0 });
  });

  it('keeps an answer to the ask, the day before it only, and marks it answered even when empty', () => {
    const askedAt = store.ask();
    expect(store.answered(askedAt)).toBe(false);
    now += 2_000;
    expect(
      store.accept(PRINCIPAL, [
        { name: 'דנה', at: NOW - HOUR },
        { name: null, at: NOW - 2 * HOUR },
        { name: 'ישן', at: NOW - 30 * HOUR },
        { name: 'עתידי', at: NOW + HOUR },
      ]),
    ).toBe(true);
    expect(store.answered(askedAt)).toBe(true);
    expect(store.since(PRINCIPAL, askedAt)).toEqual([
      { name: null, at: NOW - 2 * HOUR },
      { name: 'דנה', at: NOW - HOUR },
    ]);
  });

  it('refuses a late report, and one after the clear', () => {
    store.ask();
    now += ASK_WINDOW_MS + 1;
    expect(store.accept(PRINCIPAL, [])).toBe(false);
    now = NOW;
    store.ask();
    store.clear();
    expect(store.accept(PRINCIPAL, [{ name: 'דנה', at: NOW - HOUR }])).toBe(false);
  });

  it('a second report replaces the first', () => {
    const askedAt = store.ask();
    store.accept(PRINCIPAL, [{ name: 'א', at: NOW - HOUR }]);
    store.accept(PRINCIPAL, [{ name: 'ב', at: NOW - HOUR }]);
    expect(store.since(PRINCIPAL, askedAt).map((call) => call.name)).toEqual(['ב']);
  });

  it('clears the names after the digest, and maintenance drops leftovers', () => {
    const askedAt = store.ask();
    store.accept(PRINCIPAL, [{ name: 'דנה', at: NOW - HOUR }]);
    store.clear();
    expect(store.since(PRINCIPAL, askedAt)).toEqual([]);
    expect(store.answered(askedAt)).toBe(false);

    store.ask();
    store.accept(PRINCIPAL, [{ name: 'דנה', at: NOW - HOUR }]);
    now += 37 * HOUR;
    store.purge();
    expect(driver.exec('SELECT COUNT(*) AS n FROM missed_calls')[0]).toEqual({ n: 0 });
  });
});

describe('the digest with block E', () => {
  let driver: TestSqlDriver;
  let reminders: ReminderStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
  });
  afterEach(() => driver.close());

  const base = () => ({ nowMs: NOW, principal: PRINCIPAL, lang: 'he' as const, reminders, log: createFakeLogger() });

  it('missed calls alone are worth a digest: one line per caller, unknown numbers together', async () => {
    const text = await buildDigest({
      ...base(),
      missedCalls: [
        { name: 'דנה', at: NOW - 3 * HOUR },
        { name: null, at: NOW - 2 * HOUR },
        { name: 'דנה', at: NOW - HOUR },
        { name: null, at: NOW - 5 * HOUR },
      ],
    });
    expect(stripIsolates(text!)).toContain(
      'שיחות שלא נענו:\n\n• דנה (פעמיים) · יום ג׳ 6.10 · 06:00\n• מספר לא מזוהה (פעמיים) · יום ג׳ 6.10 · 05:00',
    );
  });

  it("puts a Google Contacts birthday on today's digest beside the local list", async () => {
    const birthdays = new BirthdayStore(driver, () => NOW);
    birthdays.add({ principal: PRINCIPAL, name: 'אמא', day: 6, month: 10 });
    const contacts = { birthdays: async () => ({ ok: true, value: [{ name: 'דנה', day: 6, month: 10, year: null }] }) } as unknown as ContactsClient;
    const text = stripIsolates((await buildDigest({ ...base(), birthdays, contacts }))!);
    expect(text).toContain('אמא');
    expect(text).toContain('דנה');
  });

  it('a Google failure leaves the local list, and the digest goes out', async () => {
    const birthdays = new BirthdayStore(driver, () => NOW);
    birthdays.add({ principal: PRINCIPAL, name: 'אמא', day: 6, month: 10 });
    const contacts = { birthdays: async () => ({ ok: false, error: { code: 'network_error' } }) } as unknown as ContactsClient;
    expect(stripIsolates((await buildDigest({ ...base(), birthdays, contacts }))!)).toContain('אמא');
  });
});

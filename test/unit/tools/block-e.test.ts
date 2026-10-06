/**
 * ROADMAP block E (2026-10-06): birthdays with Google Contacts, bills in Gmail.
 * Fakes only; no network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { BirthdayStore, birthdaysOn, mergeBirthdays } from '../../../src/core/birthdays.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { birthdaysUpcoming, nextBirthday } from '../../../src/tools/birthdays.js';
import { buildBillsQuery, mailBills, renderBills } from '../../../src/tools/bills.js';
import { billAmount, billDue } from '../../../src/tools/bill-extract.js';
import { birthdayOf, ContactsClient } from '../../../src/google/contacts.js';
import type { ContactBirthday } from '../../../src/google/contacts.js';
import { GoogleApi } from '../../../src/google/api.js';
import type { GoogleResult } from '../../../src/google/api.js';
import { GoogleStore } from '../../../src/google/store.js';
import { GRANTS, grantByCommand } from '../../../src/google/grants.js';
import type { MailSummary } from '../../../src/google/gmail.js';
import type { GmailClient } from '../../../src/google/gmail.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({ id: i + 1, sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8') }));

// Tuesday 6 October 2026, 09:00 in Jerusalem.
const NOW = Date.parse('2026-10-06T06:00:00Z');
const KEY = Buffer.alloc(32, 7).toString('base64');

function contactsStub(result: GoogleResult<ContactBirthday[]>): ContactsClient {
  return { birthdays: async () => result } as unknown as ContactsClient;
}

describe('the contacts grant', () => {
  it('is its own grant, read only, connected with /connect contacts', () => {
    expect(GRANTS.contacts.scopes).toEqual(['https://www.googleapis.com/auth/contacts.readonly']);
    expect(GRANTS.contacts.account).toBe('contacts');
    expect(grantByCommand('contacts')).toBe('contacts');
  });
});

describe('ContactsClient', () => {
  let driver: TestSqlDriver;
  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
  });
  afterEach(() => driver.close());

  it('asks for names and birthdays only, and follows one more page', async () => {
    const urls: URL[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }));
      urls.push(url);
      if (!url.searchParams.get('pageToken')) {
        return new Response(
          JSON.stringify({
            connections: [
              { names: [{ displayName: 'דנה כהן' }], birthdays: [{ date: { month: 10, day: 8 } }] },
              { names: [{ displayName: 'בלי יום הולדת' }] },
            ],
            nextPageToken: 'p2',
          }),
        );
      }
      return new Response(JSON.stringify({ connections: [{ names: [{ displayName: 'Avi' }], birthdays: [{ date: { year: 1990, month: 2, day: 29 } }] }] }));
    }) as unknown as typeof fetch;
    const store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }), GRANTS.contacts.account);
    await store.connect({ refreshToken: 'rt', scopes: GRANTS.contacts.scopes.slice() });
    const client = new ContactsClient(
      new GoogleApi({ store, clientId: 'id', clientSecret: 's', log: createFakeLogger(), now: () => NOW, fetchImpl, label: 'contacts' }),
    );
    const result = await client.birthdays();
    expect(result).toEqual({
      ok: true,
      value: [
        { name: 'דנה כהן', day: 8, month: 10, year: null },
        { name: 'Avi', day: 29, month: 2, year: 1990 },
      ],
    });
    expect(urls.map((url) => url.searchParams.get('personFields'))).toEqual(['names,birthdays', 'names,birthdays']);
    expect(urls[1]!.searchParams.get('pageToken')).toBe('p2');
  });

  it('skips a text-only birthday, an impossible day, and a person with no name', () => {
    expect(birthdayOf({ names: [{ displayName: 'x' }], birthdays: [{ text: 'early March' }] })).toBeNull();
    expect(birthdayOf({ names: [{ displayName: 'x' }], birthdays: [{ date: { month: 2, day: 30 } }] })).toBeNull();
    expect(birthdayOf({ birthdays: [{ date: { month: 2, day: 3 } }] })).toBeNull();
  });
});

describe('birthday helpers', () => {
  it('merges the two lists, the same person on the same day once', () => {
    const local = [{ name: 'דנה  כהן', day: 8, month: 10 }];
    const google = [
      { name: 'דנה כהן', day: 8, month: 10 },
      { name: 'Avi', day: 9, month: 10 },
    ];
    expect(mergeBirthdays(local, google)).toEqual([local[0], google[1]]);
  });

  it('marks 29 February on the 28th in a year without one', () => {
    const feb28 = Date.parse('2027-02-28T08:00:00Z');
    expect(birthdaysOn([{ name: 'x', day: 29, month: 2 }], feb28)).toHaveLength(1);
  });

  it('finds the next birthday, today included, and how far it is', () => {
    expect(nextBirthday(6, 10, NOW).daysAway).toBe(0);
    expect(nextBirthday(8, 10, NOW).daysAway).toBe(2);
    expect(nextBirthday(5, 10, NOW).local.year).toBe(2027);
  });
});

describe('birthdays.upcoming', () => {
  let driver: TestSqlDriver;
  let ctx: ToolContext;
  let birthdays: BirthdayStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    birthdays = new BirthdayStore(driver, () => NOW);
    birthdays.add({ principal: 'p_test', name: 'אמא', day: 7, month: 10 });
    birthdays.add({ principal: 'p_test', name: 'סבא', day: 1, month: 3 });
    ctx = {
      principal: 'p_test',
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      birthdays,
    };
  });
  afterEach(() => driver.close());

  async function run(slots: unknown, context: ToolContext = ctx) {
    const resolved = birthdaysUpcoming.resolve(slots, context);
    if (resolved.kind !== 'ready') throw new Error('expected ready');
    return birthdaysUpcoming.execute(resolved.input, context);
  }

  it('lists the local list without Google, soonest first, and does not taint', async () => {
    const out = await run({});
    expect(stripIsolates(out.text)).toBe('ימי הולדת:\n• אמא — יום ד׳ 7.10 (מחר)');
    expect(out.tainting).toBeUndefined();
  });

  it('adds Google Contacts, and a Google name taints', async () => {
    const out = await run({ days: 7 }, { ...ctx, contacts: contactsStub({ ok: true, value: [{ name: 'דנה', day: 9, month: 10, year: null }] }) });
    expect(stripIsolates(out.text)).toBe('ימי הולדת:\n• אמא — יום ד׳ 7.10 (מחר)\n• דנה — יום ו׳ 9.10 (בעוד 3 ימים)');
    expect(out.tainting).toBe(true);
  });

  it("finds one person's birthday by name, any time of year", async () => {
    const out = await run({ query_variants: ['סבא'] });
    expect(stripIsolates(out.text)).toBe('ימי הולדת:\n• סבא — יום ב׳ 1.3 (בעוד 146 ימים)');
    expect(stripIsolates((await run({ query_variants: ['יוסי'] })).text)).toBe('לא נמצא יום הולדת בשם הזה.');
  });

  it('says when Google is down, and still answers from the local list', async () => {
    const out = await run({}, { ...ctx, contacts: contactsStub({ ok: false, error: { code: 'network_error' } }) });
    expect(stripIsolates(out.text)).toContain('• אמא');
    expect(out.text).toContain('Google Contacts לא זמין כרגע');
  });

  it('says there are none in the window', async () => {
    birthdays.remove('p_test', 'אמא');
    expect(stripIsolates((await run({ days: 14 })).text)).toBe('אין ימי הולדת ב־14 הימים הקרובים.');
  });
});

describe('bill extraction', () => {
  const mailDay = { year: 2026, month: 10, day: 1 };

  it('takes the amount after a total word, else the first shekel amount', () => {
    expect(billAmount('מע"מ ₪30.00\nסה"כ לתשלום: ₪1,234.50')).toBe(1234.5);
    expect(billAmount('החשבון שלך: 89.90 ש"ח')).toBe(89.9);
    expect(billAmount('Amount due: 250 NIS')).toBe(250);
    expect(billAmount('אין כאן סכום, רק 12345')).toBeNull();
  });

  it('reads the due date after "pay by" words, day first, and fills the year', () => {
    expect(billDue('יש לשלם עד 15/10/2026', mailDay)).toEqual({ year: 2026, month: 10, day: 15 });
    expect(billDue('לתשלום עד 15.10', mailDay)).toEqual({ year: 2026, month: 10, day: 15 });
    expect(billDue('Due date: 3.1', { year: 2026, month: 12, day: 20 })).toEqual({ year: 2027, month: 1, day: 3 });
    expect(billDue('לתשלום עד 31.2', mailDay)).toBeNull();
    expect(billDue('נשלח ב-15.10', mailDay)).toBeNull();
  });
});

describe('mail.bills', () => {
  let driver: TestSqlDriver;
  let ctx: ToolContext;
  let searched: string[];

  const mail = (id: string, threadId: string, fromName: string, subject: string, at: number): MailSummary => ({
    id,
    threadId,
    fromName,
    fromAddress: 'billing@example.com',
    subject,
    messageId: null,
    at,
    snippet: '',
    unread: true,
  });

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    searched = [];
    const bodies: Record<string, string> = {
      m1: 'חשבון החשמל לתקופה. סה"כ לתשלום: ₪312.40. יש לשלם עד 20/10/2026.',
      m2: 'Your invoice is attached.',
      m3: 'תזכורת: אותו חשבון',
    };
    const gmail = {
      search: async (query: string) => {
        searched.push(query);
        return {
          ok: true,
          value: [
            mail('m1', 't1', 'חברת החשמל', 'חשבון חשמל', NOW - 86_400_000),
            mail('m2', 't2', 'Cloud Co', 'Invoice #77', NOW - 2 * 86_400_000),
            mail('m3', 't1', 'חברת החשמל', 'תזכורת', NOW - 3 * 86_400_000),
          ],
        };
      },
      body: async (id: string) => ({ ok: true, value: bodies[id] ?? '' }),
    } as unknown as GmailClient;
    ctx = {
      principal: 'p_test',
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      gmail,
    };
  });
  afterEach(() => driver.close());

  it('builds the query in code; the model gives only how far back', () => {
    const resolved = mailBills.resolve({ days: 500 }, ctx);
    if (resolved.kind !== 'ready') throw new Error('expected ready');
    expect(resolved.input).toEqual({ query: buildBillsQuery(120) });
    expect(buildBillsQuery(45)).toMatch(/^newer_than:45d \{חשבונית /);
    expect(buildBillsQuery(45)).toContain('-category:promotions');
  });

  it('lists each bill once, with the amount and the date it found, and taints', async () => {
    const resolved = mailBills.resolve({}, ctx);
    if (resolved.kind !== 'ready') throw new Error('expected ready');
    const out = await mailBills.execute(resolved.input, ctx);
    expect(out.tainting).toBe(true);
    expect(searched).toEqual([buildBillsQuery(45)]);
    const text = stripIsolates(out.text);
    expect(text).toContain('• חברת החשמל: חשבון חשמל · 312.4 ₪ · לתשלום עד יום ג׳ 20.10');
    expect(text).toContain('• Cloud Co: Invoice #77');
    // The reminder in the same thread is the same bill.
    expect(text).not.toContain('תזכורת');
    expect(text.indexOf('חברת החשמל')).toBeLessThan(text.indexOf('Cloud Co'));
  });

  it('marks a bill past its date', () => {
    const text = stripIsolates(
      renderBills([{ from: 'עירייה', subject: 'ארנונה', at: NOW, facts: { amount: 500, due: { year: 2026, month: 10, day: 1 } } }], NOW, 'he'),
    );
    expect(text).toContain('לתשלום עד יום ה׳ 1.10 (המועד עבר)');
  });

  it('answers "not connected" without Gmail', async () => {
    const { gmail: _gmail, ...without } = ctx;
    const out = await mailBills.execute({ query: buildBillsQuery(45) }, without);
    expect(stripIsolates(out.text)).toContain('/connect gmail');
  });
});

/**
 * The Calendar client and `calendar.list_events` (PLAN §6.4, §6.6).
 *
 * Two things are being pinned. First, the token lifecycle: refresh before
 * expiry, retry once on a 401, and treat `invalid_grant` as terminal instead of
 * retrying against a grant that no longer exists. Second, that nothing coming
 * back from Google is ever handed to a model or logged.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { CalendarClient } from '../../../src/google/calendar.js';
import { GoogleStore } from '../../../src/google/store.js';
import { calendarListEvents } from '../../../src/tools/calendar-read.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { Repository } from '../../../src/core/repo.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { workersFetch } from '../../integration/workers-fetch.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { ToolContext } from '../../../src/tools/types.js';

const MIGRATIONS = ['0001_init.sql', '0002_confirm.sql', '0003_reminders.sql', '0004_google.sql'].map(
  (file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }),
);

const KEY = Buffer.alloc(32, 7).toString('base64');
/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');

const EVENT = {
  id: 'ev1',
  etag: '"abc"',
  summary: 'פגישה עם יוסי',
  start: { dateTime: '2026-09-24T14:00:00+03:00' },
  end: { dateTime: '2026-09-24T15:00:00+03:00' },
};

type Step = { status?: number; body?: unknown };

function fakeGoogle(steps: Step[]) {
  const calls: { url: string; auth: string }[] = [];
  let index = 0;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization ?? '' });

    if (url.includes('oauth2.googleapis.com/token')) {
      const tokenStep = steps.find((s) => s.body && (s.body as { access_token?: string }).access_token);
      return new Response(JSON.stringify(tokenStep?.body ?? { access_token: 'at', expires_in: 3599 }), {
        status: tokenStep?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const step = steps.filter((s) => !(s.body as { access_token?: string } | undefined)?.access_token)[
      Math.min(index++, Math.max(0, steps.length - 1))
    ] ?? { status: 200, body: { items: [] } };

    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

describe('CalendarClient', () => {
  let driver: TestSqlDriver;
  let store: GoogleStore;
  let log: ReturnType<typeof createFakeLogger>;

  const client = (fetchImpl: typeof fetch) =>
    new CalendarClient({
      store,
      clientId: 'id',
      clientSecret: 'secret',
      log,
      now: () => NOW,
      fetchImpl,
    });

  beforeEach(async () => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    log = createFakeLogger();
    store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    await store.connect({ refreshToken: 'rt', scopes: [] });
  });
  afterEach(() => driver.close());

  it('calls fetch the way the Workers runtime allows (no `this`)', async () => {
    const { fetchImpl } = fakeGoogle([{ body: { items: [EVENT] } }]);
    const result = await client(workersFetch(fetchImpl)).listEvents({ startUtc: NOW, endUtc: NOW + 86_400_000 });

    expect(result).toMatchObject({ ok: true });
  });

  it('never sends an attendee without an email, which Google rejects with 400', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), { status: 200 });
      }
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...EVENT, summary: sent['summary'] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).createEvent({
      title: 'פגישה',
      startUtc: NOW,
      endUtc: NOW + 3_600_000,
      attendees: ['יוסי', 'דנה'],
    });

    expect(result.ok).toBe(true);
    expect(sent).not.toHaveProperty('attendees');
    expect(sent['description']).toContain('יוסי');
    expect(sent['description']).toContain('דנה');
  });

  it('lists events in the window', async () => {
    const { fetchImpl, calls } = fakeGoogle([{ body: { items: [EVENT] } }]);
    const result = await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 86_400_000 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]).toMatchObject({ id: 'ev1', title: 'פגישה עם יוסי', allDay: false });

    const listCall = calls.find((c) => c.url.includes('/events'))!;
    expect(listCall.url).toContain('singleEvents=true');
    expect(listCall.url).toContain('orderBy=startTime');
    expect(listCall.auth).toBe('Bearer at');
  });

  it('reads an all-day event without inventing a time for it', async () => {
    const { fetchImpl } = fakeGoogle([
      { body: { items: [{ id: 'e2', summary: 'חופש', start: { date: '2026-09-25' }, end: { date: '2026-09-26' } }] } },
    ]);
    const result = await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 86_400_000 });
    expect(result.ok && result.value[0]).toMatchObject({ allDay: true, title: 'חופש' });
  });

  it('drops a cancelled instance of a recurring event', async () => {
    const { fetchImpl } = fakeGoogle([
      { body: { items: [{ ...EVENT, status: 'cancelled' }, { ...EVENT, id: 'ev2' }] } },
    ]);
    const result = await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 86_400_000 });
    expect(result.ok && result.value.map((e) => e.id)).toEqual(['ev2']);
  });

  it('marks the events this assistant created', async () => {
    const { fetchImpl } = fakeGoogle([
      { body: { items: [{ ...EVENT, extendedProperties: { private: { assistant: '1' } } }] } },
    ]);
    const result = await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 86_400_000 });
    expect(result.ok && result.value[0]?.createdByAssistant).toBe(true);
  });

  it('gives an untitled event a placeholder rather than an empty line', async () => {
    const { fetchImpl } = fakeGoogle([{ body: { items: [{ ...EVENT, summary: undefined }] } }]);
    const result = await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 86_400_000 });
    expect(result.ok && result.value[0]?.title).toBe('—');
  });

  describe('tokens', () => {
    it('refreshes once and reuses the access token', async () => {
      const { fetchImpl, calls } = fakeGoogle([{ body: { items: [] } }]);
      const c = client(fetchImpl);
      await c.listEvents({ startUtc: NOW, endUtc: NOW + 1 });
      await c.listEvents({ startUtc: NOW, endUtc: NOW + 1 });

      expect(calls.filter((call) => call.url.includes('/token'))).toHaveLength(1);
    });

    it('retries once on a 401, because a token can be revoked mid-flight', async () => {
      let served = 0;
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/token')) {
          return new Response(JSON.stringify({ access_token: `at${served}`, expires_in: 3599 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        served++;
        return served === 1
          ? new Response('{}', { status: 401 })
          : new Response(JSON.stringify({ items: [EVENT] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
      }) as unknown as typeof fetch;

      const result = await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 1 });
      expect(result.ok && result.value).toHaveLength(1);
    });

    it('marks the integration disconnected when the grant is gone', async () => {
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/token')) {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch;

      const result = await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 1 });
      expect(result).toEqual({ ok: false, error: { code: 'disconnected' } });
      // Nothing to retry: the user has to reconnect.
      expect(store.isConnected()).toBe(false);
    });

    it('says not connected when there is no grant at all', async () => {
      store.disconnect('E_TEST');
      const { fetchImpl } = fakeGoogle([{ body: { items: [] } }]);
      expect(await client(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 1 })).toEqual({
        ok: false,
        error: { code: 'not_connected' },
      });
    });
  });

  describe('the reminders calendar', () => {
    it('creates it once and remembers the id', async () => {
      const { fetchImpl, calls } = fakeGoogle([{ body: { id: 'cal-1' } }]);
      const c = client(fetchImpl);

      expect(await c.remindersCalendarId()).toEqual({ ok: true, value: 'cal-1' });
      expect(await c.remindersCalendarId()).toEqual({ ok: true, value: 'cal-1' });

      // Creating it twice would split reminders across two identical calendars.
      expect(calls.filter((call) => call.url.endsWith('/calendars'))).toHaveLength(1);
    });
  });

  it('never logs an event title or a token', async () => {
    const { fetchImpl } = fakeGoogle([{ body: { items: [EVENT] } }, { status: 500 }]);
    const c = client(fetchImpl);
    await c.listEvents({ startUtc: NOW, endUtc: NOW + 1 });
    await c.listEvents({ startUtc: NOW, endUtc: NOW + 1 });

    const dump = JSON.stringify(log.captured);
    expect(dump).not.toContain('יוסי');
    expect(dump).not.toContain('Bearer');
    expect(dump).not.toContain('rt');
  });
});

describe('calendar.list_events', () => {
  let driver: TestSqlDriver;
  let ctx: ToolContext;

  const plain = (text: string) => stripIsolates(text);

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    ctx = {
      principal: 'p_test',
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
    };
  });
  afterEach(() => driver.close());

  it('reads today when no day was named', () => {
    // A read changes nothing, so "which day?" would be pedantry, not safety.
    const outcome = calendarListEvents.resolve({}, ctx);
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;

    const { startUtc, endUtc } = outcome.input as { startUtc: number; endUtc: number };
    expect(new Date(startUtc).toISOString()).toBe('2026-09-23T21:00:00.000Z'); // local midnight
    expect(endUtc - startUtc).toBe(24 * 60 * 60 * 1000);
  });

  it('lists the whole of this week, from Sunday, not only what is still ahead', () => {
    const outcome = calendarListEvents.resolve({ range: 'this_week' }, ctx);
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    const { startUtc, endUtc } = outcome.input as { startUtc: number; endUtc: number };
    expect(new Date(startUtc).toISOString()).toBe('2026-09-19T21:00:00.000Z'); // Sunday 20.9, 00:00
    expect(new Date(endUtc).toISOString()).toBe('2026-09-26T21:00:00.000Z'); // Sunday 27.9, 00:00
  });

  it('resolves a named day through the time rules', () => {
    const outcome = calendarListEvents.resolve({ date: { kind: 'relative_days', offset: 1 } }, ctx);
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    const { startUtc } = outcome.input as { startUtc: number };
    expect(new Date(startUtc).toISOString()).toBe('2026-09-24T21:00:00.000Z');
  });

  it('resolves a range', () => {
    const outcome = calendarListEvents.resolve({ range: 'weekend' }, ctx);
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    const { startUtc, endUtc } = outcome.input as { startUtc: number; endUtc: number };
    expect(endUtc).toBeGreaterThan(startUtc);
  });

  it('says the calendar is not connected instead of failing', async () => {
    const result = await calendarListEvents.execute({ startUtc: NOW, endUtc: NOW + 1 }, ctx);
    expect(plain(result.text)).toContain('/connect google');
  });

  it('renders the events, with times, by code', async () => {
    const { fetchImpl } = fakeGoogle([{ body: { items: [EVENT] } }]);
    const store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    await store.connect({ refreshToken: 'rt', scopes: [] });

    const result = await calendarListEvents.execute(
      { startUtc: NOW, endUtc: NOW + 86_400_000 },
      {
        ...ctx,
        calendar: new CalendarClient({
          store,
          clientId: 'id',
          clientSecret: 'secret',
          log: ctx.log,
          now: () => NOW,
          fetchImpl,
        }),
      },
    );

    expect(plain(result.text)).toContain('פגישה עם יוסי');
    expect(plain(result.text)).toContain('14:00-15:00');
  });

  it('says so plainly when the day is empty', async () => {
    const { fetchImpl } = fakeGoogle([{ body: { items: [] } }]);
    const store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    await store.connect({ refreshToken: 'rt', scopes: [] });

    const result = await calendarListEvents.execute(
      { startUtc: NOW, endUtc: NOW + 86_400_000 },
      {
        ...ctx,
        calendar: new CalendarClient({
          store,
          clientId: 'id',
          clientSecret: 'secret',
          log: ctx.log,
          now: () => NOW,
          fetchImpl,
        }),
      },
    );
    expect(result.text).toBe('אין אירועים ביומן בטווח הזה.');
  });
});

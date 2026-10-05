/**
 * The calendar fallback for reminders (PLAN §6.7).
 *
 * A reminder due outside the 24-hour window is not a send that fails — it is
 * one that must never be attempted, because nothing but a paid template gets
 * through. A Google Calendar popup takes its place, and the decision is made
 * when the reminder is created rather than discovered when it comes due.
 *
 * The stand-in is temporary by design: if the reminder does end up arriving on
 * WhatsApp, or is cancelled, the event has to go — otherwise the user is
 * reminded twice, which is worse than not at all.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { remindersCreate, remindersCancel, dropBackupEvent } from '../../../src/tools/reminders.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { CalendarClient } from '../../../src/google/calendar.js';
import { GoogleStore } from '../../../src/google/store.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { ToolContext } from '../../../src/tools/types.js';

const MIGRATIONS = ['0001_init.sql', '0002_confirm.sql', '0003_reminders.sql', '0004_google.sql', '0017_recurring.sql', '0018_scheduled_reads.sql'].map(
  (file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }),
);

const KEY = Buffer.alloc(32, 7).toString('base64');
/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');

/** Five days out: well past the 24-hour window. */
const FAR_OFF = {
  text: 'תשלום ארנונה',
  date: { kind: 'relative_days', offset: 5 },
  time: { hour: 9, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

const SOON = {
  text: 'להתקשר לאבא',
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 8, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

type Write = { method: string; url: string; body: Record<string, unknown> | null };

function fakeGoogle(options: { calendarFails?: boolean } = {}) {
  const writes: Write[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';

    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method !== 'GET') {
      writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    }

    if (options.calendarFails && url.endsWith('/calendars')) {
      return new Response('{}', { status: 500 });
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/calendars')) {
      return new Response(JSON.stringify({ id: 'cal-reminders' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        id: 'ev-backup',
        etag: '"v1"',
        summary: FAR_OFF.text,
        start: { dateTime: '2026-09-29T09:00:00+03:00' },
        end: { dateTime: '2026-09-29T09:05:00+03:00' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, writes };
}

describe('the calendar fallback', () => {
  let driver: TestSqlDriver;
  let reminders: ReminderStore;
  let base: ToolContext;

  const plain = (text: string) => stripIsolates(text);

  const withGoogle = async (fetchImpl: typeof fetch): Promise<ToolContext> => {
    const store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    await store.connect({ refreshToken: 'rt', scopes: [] });
    return {
      ...base,
      calendar: new CalendarClient({
        store,
        clientId: 'id',
        clientSecret: 'secret',
        log: base.log,
        now: () => NOW,
        fetchImpl,
      }),
    };
  };

  const create = async (slots: unknown, ctx: ToolContext) => {
    const outcome = remindersCreate.resolve(slots, ctx);
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    return remindersCreate.execute(outcome.input, ctx);
  };

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    base = {
      principal: 'p_test',
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
    };
  });
  afterEach(() => driver.close());

  it('writes a calendar popup for a reminder past the window', async () => {
    const { fetchImpl, writes } = fakeGoogle();
    const result = await create(FAR_OFF, await withGoogle(fetchImpl));

    expect(plain(result.text)).toContain('יומן');

    const event = writes.find((w) => w.method === 'POST' && w.url.includes('/events'));
    expect(event?.url).toContain('cal-reminders');
    expect(event?.body?.['reminders']).toEqual({
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 0 }],
    });
  });

  it('records the event on the reminder, so it can be removed later', async () => {
    const { fetchImpl } = fakeGoogle();
    await create(FAR_OFF, await withGoogle(fetchImpl));

    expect(reminders.listUpcoming('p_test')[0]?.backupEventId).toBe('ev-backup');
  });

  it('writes nothing for a reminder that WhatsApp can still reach', async () => {
    const { fetchImpl, writes } = fakeGoogle();
    const result = await create(SOON, await withGoogle(fetchImpl));

    expect(writes).toHaveLength(0);
    expect(plain(result.text)).not.toContain('יומן');
  });

  it('still schedules the reminder when Google is not connected', async () => {
    // A missing fallback is worse than a late reminder, but not worth failing
    // the whole request for: it will arrive once the user writes back.
    const result = await create(FAR_OFF, base);

    expect(reminders.listUpcoming('p_test')).toHaveLength(1);
    expect(reminders.listUpcoming('p_test')[0]?.backupEventId).toBeNull();
    expect(plain(result.text)).toContain('יומן');
  });

  it('still schedules it when the calendar cannot be created', async () => {
    const { fetchImpl } = fakeGoogle({ calendarFails: true });
    await create(FAR_OFF, await withGoogle(fetchImpl));

    expect(reminders.listUpcoming('p_test')).toHaveLength(1);
    expect(reminders.listUpcoming('p_test')[0]?.backupEventId).toBeNull();
  });

  describe('removing the stand-in', () => {
    it('deletes the event when the reminder is cancelled', async () => {
      const { fetchImpl, writes } = fakeGoogle();
      const ctx = await withGoogle(fetchImpl);
      await create(FAR_OFF, ctx);

      const outcome = remindersCancel.resolve({ query_variants: ['ארנונה'] }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');
      await remindersCancel.execute(outcome.input, ctx);

      const deleted = writes.find((w) => w.method === 'DELETE');
      expect(deleted?.url).toContain('ev-backup');
    });

    it('deletes the event when the create is undone', async () => {
      const { fetchImpl, writes } = fakeGoogle();
      const ctx = await withGoogle(fetchImpl);
      const created = await create(FAR_OFF, ctx);

      await remindersCreate.undo?.(created.compensating, ctx);
      expect(writes.some((w) => w.method === 'DELETE')).toBe(true);
    });

    it('forgets the event id once it is gone, so it is not deleted twice', async () => {
      const { fetchImpl, writes } = fakeGoogle();
      const ctx = await withGoogle(fetchImpl);
      await create(FAR_OFF, ctx);
      const id = reminders.listUpcoming('p_test')[0]!.id;

      await dropBackupEvent(id, ctx);
      await dropBackupEvent(id, ctx);

      expect(writes.filter((w) => w.method === 'DELETE')).toHaveLength(1);
    });

    it('does nothing for a reminder that never had one', async () => {
      const { fetchImpl, writes } = fakeGoogle();
      const ctx = await withGoogle(fetchImpl);
      await create(SOON, ctx);

      await dropBackupEvent(reminders.listUpcoming('p_test')[0]!.id, ctx);
      expect(writes).toHaveLength(0);
    });
  });
});

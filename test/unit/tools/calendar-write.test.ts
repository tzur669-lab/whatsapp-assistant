/**
 * The calendar write tools (PLAN §6.4, §6.6, §11.3).
 *
 * Three properties are being pinned. Code finds the target, from
 * `query_variants` and nothing else. Every write carries the etag it was
 * previewed with, so a confirmation tapped late cannot overwrite what happened
 * in between. And nothing is defaulted — an event with no stated length is a
 * question, because a guessed hour writes a wrong end time into a calendar
 * other people read.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  calendarCreateEvent,
  calendarMoveEvent,
  calendarDeleteEvent,
} from '../../../src/tools/calendar-write.js';
import { CalendarClient } from '../../../src/google/calendar.js';
import { GoogleStore } from '../../../src/google/store.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { Repository } from '../../../src/core/repo.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
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

const AT_TWO_TOMORROW = {
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 14, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

const YOSSI = {
  id: 'ev-yossi',
  etag: '"v1"',
  summary: 'פגישה עם יוסי',
  start: { dateTime: '2026-09-25T14:00:00+03:00' },
  end: { dateTime: '2026-09-25T15:00:00+03:00' },
};

const DENTIST = {
  id: 'ev-dentist',
  etag: '"v1"',
  summary: 'רופא שיניים',
  start: { dateTime: '2026-09-26T09:00:00+03:00' },
  end: { dateTime: '2026-09-26T10:00:00+03:00' },
};

type Recorded = { method: string; url: string; body: unknown; ifMatch: string | null };

/** A Google that lists a fixed set of events and records every write. */
function fakeGoogle(options: { events?: unknown[]; writeStatus?: number } = {}) {
  const writes: Recorded[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;

    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (method === 'GET') {
      return new Response(JSON.stringify({ items: options.events ?? [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    writes.push({
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : null,
      ifMatch: headers['if-match'] ?? null,
    });

    if (options.writeStatus && options.writeStatus >= 400) {
      return new Response('{}', { status: options.writeStatus });
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });

    return new Response(
      JSON.stringify({
        id: 'ev-new',
        etag: '"v2"',
        summary: (init?.body ? JSON.parse(String(init.body)) : {}).summary ?? YOSSI.summary,
        start: { dateTime: '2026-09-25T14:00:00+03:00' },
        end: { dateTime: '2026-09-25T15:00:00+03:00' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  return { fetchImpl, writes };
}

describe('calendar write tools', () => {
  let driver: TestSqlDriver;
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

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    base = {
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

  // -- create -----------------------------------------------------------------

  describe('calendar.create_event', () => {
    const slots = { title: 'פגישה עם יוסי', ...AT_TWO_TOMORROW, duration_minutes: 60 };

    it('resolves a title, a time and a length into a span', () => {
      const outcome = calendarCreateEvent.resolve(slots, base);
      expect(outcome.kind).toBe('ready');
      if (outcome.kind !== 'ready') return;

      const input = outcome.input as { startUtc: number; endUtc: number; title: string };
      expect(new Date(input.startUtc).toISOString()).toBe('2026-09-25T11:00:00.000Z');
      expect(input.endUtc - input.startUtc).toBe(60 * 60_000);
    });

    it('asks what the meeting is rather than inventing a title', () => {
      expect(calendarCreateEvent.resolve({ ...AT_TWO_TOMORROW, duration_minutes: 60 }, base)).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'title' },
      });
    });

    it('asks how long, because there is no default duration', () => {
      // A guessed hour writes a wrong end time into a calendar others read.
      expect(calendarCreateEvent.resolve({ title: 'פגישה', ...AT_TWO_TOMORROW }, base)).toEqual({
        kind: 'clarify',
        clarify: { code: 'missing_slot', slot: 'duration' },
      });
    });

    it('asks for a time rather than picking one', () => {
      const outcome = calendarCreateEvent.resolve(
        { title: 'פגישה', date: { kind: 'relative_days', offset: 1 }, duration_minutes: 60 },
        base,
      );
      expect(outcome.kind).toBe('clarify');
      if (outcome.kind !== 'clarify') return;
      expect(outcome.clarify.code).toBe('time');
    });

    it('creates the event, tagged as ours', async () => {
      const { fetchImpl, writes } = fakeGoogle();
      const outcome = calendarCreateEvent.resolve(slots, base);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const result = await calendarCreateEvent.execute(outcome.input, await withGoogle(fetchImpl));
      expect(plain(result.text)).toContain('פגישה עם יוסי');

      const body = writes[0]?.body as { extendedProperties?: { private?: Record<string, string> } };
      expect(body.extendedProperties?.private?.['assistant']).toBe('1');
    });

    it('never notifies attendees from this path', async () => {
      // An invitation leaves the system and cannot be recalled by deleting the
      // event, so it is a separate, explicit act (Tier 3).
      const { fetchImpl, writes } = fakeGoogle();
      const outcome = calendarCreateEvent.resolve({ ...slots, attendees: ['יוסי'] }, base);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      await calendarCreateEvent.execute(outcome.input, await withGoogle(fetchImpl));
      expect(writes[0]?.url).toContain('sendUpdates=none');
    });

    it('names the attendees in the preview, since that is the part that leaves', () => {
      const outcome = calendarCreateEvent.resolve({ ...slots, attendees: ['יוסי'] }, base);
      if (outcome.kind !== 'ready') throw new Error('expected ready');
      expect(plain(calendarCreateEvent.preview(outcome.input, 'he'))).toContain('משתתפים: יוסי');
    });

    it('offers an Undo that deletes what it just created', async () => {
      const { fetchImpl, writes } = fakeGoogle();
      const ctx = await withGoogle(fetchImpl);
      const outcome = calendarCreateEvent.resolve(slots, base);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const created = await calendarCreateEvent.execute(outcome.input, ctx);
      expect(created.compensating).toEqual({ eventId: 'ev-new' });

      await calendarCreateEvent.undo?.(created.compensating, ctx);
      expect(writes.at(-1)).toMatchObject({ method: 'DELETE' });
      expect(writes.at(-1)?.url).toContain('ev-new');
    });

    it('says the calendar is not connected instead of failing', async () => {
      const result = await calendarCreateEvent.execute(
        { title: 'x', startUtc: NOW, endUtc: NOW + 1 },
        base,
      );
      expect(plain(result.text)).toContain('/connect google');
    });
  });

  // -- move -------------------------------------------------------------------

  describe('calendar.move_event', () => {
    it('finds the event from the spellings the model supplied', async () => {
      const { fetchImpl } = fakeGoogle({ events: [YOSSI, DENTIST] });
      const outcome = await calendarMoveEvent.resolveAsync!(
        { query_variants: ['יוסי', 'Yossi'], to_date: { kind: 'relative_days', offset: 1 }, to_time: { hour: 16, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
        await withGoogle(fetchImpl),
      );

      expect(outcome.kind).toBe('ready');
      if (outcome.kind !== 'ready') return;
      expect((outcome.input as { eventId: string }).eventId).toBe('ev-yossi');
    });

    it('keeps the meeting the same length: it was moved, not resized', async () => {
      const { fetchImpl } = fakeGoogle({ events: [YOSSI] });
      const outcome = await calendarMoveEvent.resolveAsync!(
        { query_variants: ['יוסי'], to_date: { kind: 'relative_days', offset: 1 }, to_time: { hour: 16, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
        await withGoogle(fetchImpl),
      );
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const input = outcome.input as { startUtc: number; endUtc: number };
      expect(input.endUtc - input.startUtc).toBe(60 * 60_000);
    });

    it('asks which one when the description matches several', async () => {
      const { fetchImpl } = fakeGoogle({
        events: [YOSSI, { ...YOSSI, id: 'ev-yossi-2', summary: 'פגישה עם יוסי המשך' }],
      });
      const outcome = await calendarMoveEvent.resolveAsync!(
        { query_variants: ['יוסי'], to_date: { kind: 'relative_days', offset: 1 }, to_time: { hour: 16, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
        await withGoogle(fetchImpl),
      );

      expect(outcome.kind).toBe('clarify');
      if (outcome.kind !== 'clarify' || outcome.clarify.code !== 'ambiguous') {
        throw new Error('expected ambiguous');
      }
      expect(outcome.clarify.choices).toHaveLength(2);
    });

    it('says nothing matched rather than moving the nearest thing', async () => {
      const { fetchImpl } = fakeGoogle({ events: [DENTIST] });
      const outcome = await calendarMoveEvent.resolveAsync!(
        { query_variants: ['יוסי'], to_date: { kind: 'relative_days', offset: 1 }, to_time: { hour: 16, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
        await withGoogle(fetchImpl),
      );
      expect(outcome).toEqual({ kind: 'clarify', clarify: { code: 'not_found' } });
    });

    it('asks which event when no description was given at all', async () => {
      const { fetchImpl } = fakeGoogle({ events: [YOSSI] });
      const outcome = await calendarMoveEvent.resolveAsync!({}, await withGoogle(fetchImpl));
      expect(outcome).toEqual({ kind: 'clarify', clarify: { code: 'missing_slot', slot: 'target' } });
    });

    it('sends the etag it was previewed with', async () => {
      const { fetchImpl, writes } = fakeGoogle({ events: [YOSSI] });
      const ctx = await withGoogle(fetchImpl);
      const outcome = await calendarMoveEvent.resolveAsync!(
        { query_variants: ['יוסי'], to_date: { kind: 'relative_days', offset: 1 }, to_time: { hour: 16, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' } },
        ctx,
      );
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      await calendarMoveEvent.execute(outcome.input, ctx);
      expect(writes[0]).toMatchObject({ method: 'PATCH', ifMatch: '"v1"' });
    });

    it('writes nothing when the event changed since it was shown', async () => {
      const { fetchImpl } = fakeGoogle({ events: [YOSSI], writeStatus: 412 });
      const ctx = await withGoogle(fetchImpl);

      const result = await calendarMoveEvent.execute(
        {
          eventId: 'ev-yossi',
          title: 'פגישה עם יוסי',
          fromStartUtc: NOW,
          startUtc: NOW + 3_600_000,
          endUtc: NOW + 7_200_000,
          etag: '"v1"',
        },
        ctx,
      );
      expect(plain(result.text)).toContain('השתנה');
    });

    it('shows both times in the preview, so the move can be checked', () => {
      const text = plain(
        calendarMoveEvent.preview(
          {
            eventId: 'e',
            title: 'פגישה עם יוסי',
            fromStartUtc: Date.parse('2026-09-25T11:00:00Z'),
            startUtc: Date.parse('2026-09-25T13:00:00Z'),
            endUtc: Date.parse('2026-09-25T14:00:00Z'),
            etag: null,
          },
          'he',
        ),
      );
      expect(text).toContain('14:00');
      expect(text).toContain('16:00');
    });
  });

  // -- delete -----------------------------------------------------------------

  describe('calendar.delete_event', () => {
    it('finds the event and previews exactly what will go', async () => {
      const { fetchImpl } = fakeGoogle({ events: [YOSSI, DENTIST] });
      const outcome = await calendarDeleteEvent.resolveAsync!(
        { query_variants: ['שיניים'] },
        await withGoogle(fetchImpl),
      );
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      expect((outcome.input as { eventId: string }).eventId).toBe('ev-dentist');
      expect(plain(calendarDeleteEvent.preview(outcome.input, 'he'))).toContain('רופא שיניים');
    });

    it('deletes with the etag', async () => {
      const { fetchImpl, writes } = fakeGoogle({ events: [DENTIST] });
      const ctx = await withGoogle(fetchImpl);
      const outcome = await calendarDeleteEvent.resolveAsync!({ query_variants: ['שיניים'] }, ctx);
      if (outcome.kind !== 'ready') throw new Error('expected ready');

      const result = await calendarDeleteEvent.execute(outcome.input, ctx);
      expect(result.text).toBe('האירוע נמחק.');
      expect(writes[0]).toMatchObject({ method: 'DELETE', ifMatch: '"v1"' });
    });

    it('treats an already-deleted event as done, not as an error', async () => {
      const { fetchImpl } = fakeGoogle({ events: [DENTIST], writeStatus: 404 });
      const ctx = await withGoogle(fetchImpl);

      const result = await calendarDeleteEvent.execute(
        { eventId: 'ev-dentist', title: 'רופא שיניים', startUtc: NOW, etag: null },
        ctx,
      );
      // The calendar is in the state the user asked for.
      expect(result.text).toBe('האירוע נמחק.');
    });

    it('refuses to delete when the event changed since the preview', async () => {
      const { fetchImpl } = fakeGoogle({ events: [DENTIST], writeStatus: 412 });
      const ctx = await withGoogle(fetchImpl);

      const result = await calendarDeleteEvent.execute(
        { eventId: 'ev-dentist', title: 'רופא שיניים', startUtc: NOW, etag: '"v1"' },
        ctx,
      );
      expect(plain(result.text)).toContain('השתנה');
    });
  });

  it('never logs an event title', async () => {
    const { fetchImpl } = fakeGoogle({ events: [YOSSI], writeStatus: 500 });
    const ctx = await withGoogle(fetchImpl);
    await calendarDeleteEvent.execute(
      { eventId: 'ev-yossi', title: 'פגישה עם יוסי', startUtc: NOW, etag: null },
      ctx,
    );
    expect(JSON.stringify((ctx.log as unknown as { captured: unknown[] }).captured)).not.toContain(
      'יוסי',
    );
  });
});

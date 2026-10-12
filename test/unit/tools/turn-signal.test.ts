/**
 * The turn's abort signal at the network boundary (Improvement plan §3 T3,
 * Batch 07 T3-3). One read can chain about eleven requests, each with its own
 * timeout; only the signal makes the deadline real there.
 *
 * What is pinned: a hung request deep in a calendar read and a hung token
 * refresh both end when the signal fires; the model call takes it; every real
 * client can be bound; `withTurnSignal` binds every network path of the
 * context, and only those.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalendarClient } from '../../../src/google/calendar.js';
import { GoogleApi } from '../../../src/google/api.js';
import { GoogleStore } from '../../../src/google/store.js';
import { TasksClient } from '../../../src/google/tasks.js';
import { GmailClient } from '../../../src/google/gmail.js';
import { DriveClient } from '../../../src/google/drive.js';
import { ContactsClient } from '../../../src/google/contacts.js';
import { createQuoteSources } from '../../../src/lookup/quotes.js';
import { createGroqAgentProvider } from '../../../src/agent/provider.js';
import { signalledFetch, withTurnSignal } from '../../../src/tools/turn-signal.js';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { workersFetch } from '../../integration/workers-fetch.js';

const NOW = Date.parse('2026-09-24T09:00:00Z');
const KEY = Buffer.alloc(32, 9).toString('base64');
const ALL_CALENDARS = 'https://www.googleapis.com/auth/calendar.readonly';

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

/** A request that never answers, and rejects the way `fetch` does when its signal fires. */
function hang(init: RequestInit | undefined, seen: AbortSignal[]): Promise<Response> {
  const signal = init?.signal;
  if (!signal) return new Promise(() => undefined);
  seen.push(signal);
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

describe('the turn signal at the network boundary', () => {
  let driver: TestSqlDriver;
  let store: GoogleStore;

  beforeEach(async () => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    await store.connect({ refreshToken: 'rt', scopes: [ALL_CALENDARS] });
  });
  afterEach(() => driver.close());

  const calendar = (fetchImpl: typeof fetch) =>
    new CalendarClient({ store, clientId: 'id', clientSecret: 'secret', log: createFakeLogger(), now: () => NOW, fetchImpl });

  it("a calendar read's hung 3rd request ends when the signal fires", async () => {
    const seen: AbortSignal[] = [];
    let requests = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3599 });
      requests++;
      if (url.includes('/calendarList')) return json({ items: [{ id: 'other1' }, { id: 'other2' }] });
      if (url.includes('/calendars/other1/')) return hang(init, seen); // the 3rd request
      return json({ items: [] });
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    const pending = calendar(workersFetch(fetchImpl))
      .withSignal(controller.signal)
      .listAllEvents({ startUtc: NOW, endUtc: NOW + 86_400_000, strict: true });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(requests).toBe(3);
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: { code: 'network_error' } });
    expect(seen).toHaveLength(1);
  });

  it('a hung token refresh ends when the signal fires', async () => {
    const seen: AbortSignal[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('oauth2.googleapis.com/token')) return hang(init, seen);
      return json({ items: [] });
    }) as unknown as typeof fetch;
    const controller = new AbortController();

    const pending = calendar(fetchImpl).withSignal(controller.signal).listEvents({ startUtc: NOW, endUtc: NOW + 1 });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();

    await expect(pending).resolves.toEqual({ ok: false, error: { code: 'network_error' } });
    expect(seen).toHaveLength(1);
  });

  it('a client with no signal is as before: its own timeout only', async () => {
    const seen: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.signal);
      if (String(input).includes('oauth2.googleapis.com/token')) return json({ access_token: 'at', expires_in: 3599 });
      return json({ items: [] });
    }) as unknown as typeof fetch;

    await calendar(fetchImpl).listEvents({ startUtc: NOW, endUtc: NOW + 1 });
    expect(seen).toHaveLength(2);
    for (const signal of seen) expect(signal?.aborted).toBe(false);
  });

  it('every real Google client can be bound', () => {
    const api = new GoogleApi({ store, clientId: 'id', clientSecret: 'secret', log: createFakeLogger(), now: () => NOW, label: 't' });
    const signal = new AbortController().signal;
    expect(new TasksClient(api).withSignal(signal)).toBeInstanceOf(TasksClient);
    expect(new GmailClient(api).withSignal(signal)).toBeInstanceOf(GmailClient);
    expect(new DriveClient(api).withSignal(signal)).toBeInstanceOf(DriveClient);
    expect(new ContactsClient(api).withSignal(signal)).toBeInstanceOf(ContactsClient);
    expect(calendar(fetch).withSignal(signal)).toBeInstanceOf(CalendarClient);
  });

  it("a quote's request ends when the signal fires", async () => {
    const seen: AbortSignal[] = [];
    const quotes = createQuoteSources((async (_input: string | URL | Request, init?: RequestInit) => hang(init, seen)) as unknown as typeof fetch, 'k', () => NOW);
    const controller = new AbortController();
    const pending = quotes.quote('AAPL', 'us', controller.signal);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'error' });
  });

  it("the model call ends when the signal fires, and reads as the provider's own failure", async () => {
    const seen: AbortSignal[] = [];
    const provider = createGroqAgentProvider({
      apiKey: 'test-key',
      model: 'test-model',
      fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => hang(init, seen)) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    const pending = provider.complete([{ role: 'user', content: 'hi' }], [], { signal: controller.signal });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    controller.abort();
    // The loop, which knows the deadline fired, calls it `deadline` (T3-4).
    const response = await pending;
    expect(response.ok).toBe(false);
    expect(seen).toHaveLength(1);
  });

  describe('withTurnSignal', () => {
    it('binds the public fetch, combined with the request’s own signal', async () => {
      const seen: (AbortSignal | null | undefined)[] = [];
      const inner = (async (_input: string | URL | Request, init?: RequestInit) => {
        seen.push(init?.signal);
        return json({});
      }) as unknown as typeof fetch;
      const controller = new AbortController();
      const own = new AbortController();

      await signalledFetch(workersFetch(inner), controller.signal)('https://example.com', { signal: own.signal });
      await signalledFetch(inner, controller.signal)('https://example.com');
      expect(seen[0]).not.toBe(controller.signal);
      expect(seen[1]).toBe(controller.signal);
      controller.abort();
      expect(seen[0]?.aborted).toBe(true);
    });

    it('binds every network client of the context, and sets the signal', async () => {
      const signal = new AbortController().signal;
      const quoted: (AbortSignal | undefined)[] = [];
      const fetchImpl = (async () => json({})) as unknown as typeof fetch;
      const ctx = {
        principal: 'p',
        calendar: calendar(fetch),
        quotes: { quote: async (_s: string, _m: 'us' | 'tase', s?: AbortSignal) => (quoted.push(s), { kind: 'error' as const }) },
        fetchImpl,
      } as unknown as ToolContext;

      const bound = withTurnSignal(ctx, signal);
      expect(bound.signal).toBe(signal);
      expect(bound.calendar).not.toBe(ctx.calendar);
      expect(bound.fetchImpl).not.toBe(fetchImpl);
      await bound.quotes!.quote('AAPL', 'us');
      expect(quoted).toEqual([signal]);
      // The original is untouched: a write's execute gets it as it was.
      expect(ctx.signal).toBeUndefined();
    });
  });
});

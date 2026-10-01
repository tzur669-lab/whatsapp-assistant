/**
 * Google Tasks tools (2026-10-01), through the real client and GoogleApi
 * against a fake Tasks API. No network.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { findList, listNameOf, tasksAdd, tasksComplete, tasksList } from '../../../src/tools/tasks.js';
import { TasksClient } from '../../../src/google/tasks.js';
import { GoogleApi } from '../../../src/google/api.js';
import { GoogleStore } from '../../../src/google/store.js';
import { GRANTS } from '../../../src/google/grants.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({ id: i + 1, sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8') }));

const NOW = Date.parse('2026-10-01T09:00:00Z');
const KEY = Buffer.alloc(32, 7).toString('base64');

type FakeTask = { id: string; title: string; status: 'needsAction' | 'completed'; due?: string };

/** A small in-memory Google Tasks. */
function fakeTasksApi() {
  const lists: Array<{ id: string; title: string; tasks: FakeTask[] }> = [
    { id: 'L-default', title: 'המשימות שלי', tasks: [{ id: 'T1', title: 'להחזיר ספר', status: 'needsAction' }] },
    {
      id: 'L-shop',
      title: 'קניות',
      tasks: [
        { id: 'T2', title: 'חלב', status: 'needsAction' },
        { id: 'T3', title: 'חלב סויה', status: 'needsAction' },
        { id: 'T4', title: 'לחם', status: 'completed' },
      ],
    },
  ];
  let next = 10;
  const requests: Array<{ method: string; url: string; body: unknown }> = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.hostname === 'oauth2.googleapis.com') return new Response(JSON.stringify({ access_token: 'at', expires_in: 3599 }));
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    requests.push({ method, url: url.pathname, body });

    const path = url.pathname.replace('/tasks/v1', '');
    if (path === '/users/@me/lists' && method === 'GET') {
      return new Response(JSON.stringify({ items: lists.map(({ id, title }) => ({ id, title })) }));
    }
    if (path === '/users/@me/lists' && method === 'POST') {
      const list = { id: `L${next++}`, title: String(body?.['title']), tasks: [] };
      lists.push(list);
      return new Response(JSON.stringify({ id: list.id, title: list.title }));
    }
    const m = /^\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(path);
    const list = m ? lists.find((l) => l.id === decodeURIComponent(m[1]!)) : undefined;
    if (!m || !list) return new Response('{}', { status: 404 });
    const taskId = m[2] ? decodeURIComponent(m[2]) : undefined;
    if (!taskId && method === 'GET') {
      const open = list.tasks.filter((t) => url.searchParams.get('showCompleted') !== 'false' || t.status !== 'completed');
      return new Response(JSON.stringify({ items: open }));
    }
    if (!taskId && method === 'POST') {
      const task: FakeTask = { id: `T${next++}`, title: String(body?.['title']), status: 'needsAction', ...(body?.['due'] ? { due: String(body['due']) } : {}) };
      list.tasks.push(task);
      return new Response(JSON.stringify(task));
    }
    const task = list.tasks.find((t) => t.id === taskId);
    if (!task) return new Response('{}', { status: 404 });
    if (method === 'PATCH') {
      task.status = body?.['status'] as FakeTask['status'];
      return new Response(JSON.stringify(task));
    }
    if (method === 'DELETE') {
      list.tasks.splice(list.tasks.indexOf(task), 1);
      return new Response(null, { status: 204 });
    }
    return new Response('{}', { status: 400 });
  }) as unknown as typeof fetch;

  return { fetchImpl, lists, requests };
}

describe('Google Tasks tools', () => {
  let driver: TestSqlDriver;
  let ctx: ToolContext;
  let api: ReturnType<typeof fakeTasksApi>;

  beforeEach(async () => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    api = fakeTasksApi();
    const store = new GoogleStore(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }), GRANTS.tasks.account);
    await store.connect({ refreshToken: 'rt', scopes: GRANTS.tasks.scopes.slice() });
    const log = createFakeLogger();
    ctx = {
      principal: 'p_test',
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      log,
      lastInboundAt: NOW,
      monthlySent: 0,
      tasks: new TasksClient(
        new GoogleApi({ store, clientId: 'id', clientSecret: 's', log, now: () => NOW, fetchImpl: api.fetchImpl, label: 'tasks' }),
      ),
    };
  });
  afterEach(() => driver.close());

  const ready = async (tool: typeof tasksAdd, slots: Record<string, unknown>) => {
    const resolved = tool.resolveAsync ? await tool.resolveAsync(slots, ctx) : tool.resolve(slots, ctx);
    if (resolved.kind !== 'ready') throw new Error(JSON.stringify(resolved));
    return resolved.input;
  };

  describe('finding a list by the name said', () => {
    const lists = [
      { id: 'a', title: 'המשימות שלי' },
      { id: 'b', title: 'קניות' },
    ];
    it('reads "רשימת הקניות" as "קניות"', () => {
      expect(listNameOf('רשימת הקניות')).toBe('קניות');
      expect(listNameOf('לרשימת קניות')).toBe('קניות');
      expect(findList(lists, 'רשימת הקניות')?.id).toBe('b');
    });
    it('takes the first list when none is named, and nothing when the name matches none', () => {
      expect(findList(lists, undefined)?.id).toBe('a');
      expect(findList(lists, 'עבודה')).toBeNull();
    });
  });

  it('lists open items only, per list', async () => {
    const out = await tasksList.execute(await ready(tasksList, { list: 'קניות' }), ctx);
    expect(stripIsolates(out.text)).toBe('קניות:\n• חלב\n• חלב סויה');
    const all = stripIsolates((await tasksList.execute(await ready(tasksList, {}), ctx)).text);
    expect(all).toContain('המשימות שלי:\n• להחזיר ספר');
    expect(all).toContain('קניות:');
  });

  it('adds to the named list with a due date, and the Undo removes it', async () => {
    const input = await ready(tasksAdd, { text: 'ביצים', list: 'רשימת קניות', date: { kind: 'relative_days', offset: 1 } });
    const out = await tasksAdd.execute(input, ctx);
    expect(stripIsolates(out.text)).toBe('נוסף לרשימת קניות: ביצים · עד יום ו׳ 2.10');
    const shop = api.lists.find((l) => l.id === 'L-shop')!;
    expect(shop.tasks.at(-1)).toMatchObject({ title: 'ביצים', due: '2026-10-02T00:00:00.000Z' });

    await tasksAdd.undo!(out.compensating, ctx);
    expect(shop.tasks.some((t) => t.title === 'ביצים')).toBe(false);
  });

  it('makes a list that does not exist yet', async () => {
    const out = await tasksAdd.execute(await ready(tasksAdd, { text: 'מברגה', list: 'בית' }), ctx);
    expect(stripIsolates(out.text)).toBe('נוסף לרשימת בית (רשימה חדשה): מברגה');
  });

  it('asks what to add rather than adding nothing', () => {
    expect(tasksAdd.resolve({ list: 'קניות' }, ctx)).toEqual({ kind: 'clarify', clarify: { code: 'missing_slot', slot: 'text' } });
  });

  it('marks an item done when one matches, and the Undo opens it again', async () => {
    const input = await ready(tasksComplete, { query_variants: ['להחזיר ספר'] });
    const out = await tasksComplete.execute(input, ctx);
    expect(stripIsolates(out.text)).toBe('סומן כבוצע: להחזיר ספר (המשימות שלי) ✅');
    expect(api.lists[0]!.tasks[0]!.status).toBe('completed');
    await tasksComplete.undo!(out.compensating, ctx);
    expect(api.lists[0]!.tasks[0]!.status).toBe('needsAction');
  });

  it('asks which one when several match, and never guesses', async () => {
    const resolved = await tasksComplete.resolveAsync!({ query_variants: ['חלב'] }, ctx);
    expect(resolved).toMatchObject({ kind: 'clarify', clarify: { code: 'ambiguous' } });
    if (resolved.kind === 'clarify' && resolved.clarify.code === 'ambiguous') {
      expect(resolved.clarify.choices.map((c) => c.label)).toEqual(['חלב (קניות)', 'חלב סויה (קניות)']);
    }
    expect(api.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('says it found nothing for an item not on any list', async () => {
    expect(await tasksComplete.resolveAsync!({ query_variants: ['פסנתר'] }, ctx)).toEqual({ kind: 'clarify', clarify: { code: 'not_found' } });
  });

  it('says to connect when Tasks is not connected', async () => {
    const without = { ...ctx };
    delete without.tasks;
    expect(stripIsolates((await tasksList.execute({}, without)).text)).toBe('Google Tasks לא מחובר. יש לשלוח /connect tasks.');
    expect(await tasksComplete.resolveAsync!({ query_variants: ['x'] }, without)).toEqual({
      kind: 'clarify',
      clarify: { code: 'grant_missing', grant: 'tasks' },
    });
  });
});

/**
 * Named lists (PLAN §6.25, ROADMAP block H part 17, 2026-10-07): the store,
 * the tools, and a turn through the pipeline.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { ListStore, listKey, MAX_ITEMS_PER_LIST, MAX_LISTS } from '../../../src/tools/list-store.js';
import { listsAdd, listsDelete, listsRemove, listsShow } from '../../../src/tools/lists.js';
import type { ToolContext } from '../../../src/tools/types.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { UNDO_EXPIRY_MS } from '../../../src/confirm/undo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

const NOW = Date.parse('2026-10-07T09:00:00Z');
const PRINCIPAL = 'p_lists';
const plain = (text: string) => stripIsolates(text);

describe('lists', () => {
  let driver: TestSqlDriver;
  let now: number;
  let store: ListStore;
  let ctx: ToolContext;

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    now = NOW;
    store = new ListStore(driver, () => now);
    ctx = {
      principal: PRINCIPAL,
      nowMs: NOW,
      lang: 'he',
      repo,
      reminders: new ReminderStore(driver, () => NOW),
      lists: store,
      log: createFakeLogger(),
      lastInboundAt: NOW,
      monthlySent: 0,
      channel: 'app',
    };
  });
  afterEach(() => driver.close());

  const run = async (slots: Record<string, unknown>) => {
    const out = listsAdd.resolve(slots, ctx);
    if (out.kind !== 'ready') return { clarify: out };
    return { result: await listsAdd.execute(out.input, ctx) };
  };

  describe('keys', () => {
    it('treats "רשימת קניות", "קניות" and "הקניות" as one list', () => {
      expect(listKey('רשימת קניות')).toBe('קניות');
      store.add(PRINCIPAL, { newName: 'רשימת קניות' }, ['חלב']);
      expect(store.find(PRINCIPAL, ['קניות'])).toHaveLength(1);
      expect(store.find(PRINCIPAL, ['הקניות'])).toHaveLength(1);
      const again = store.add(PRINCIPAL, { newName: 'קניות' }, ['ביצים']);
      expect(again).toMatchObject({ kind: 'added', created: false });
      expect(store.lists(PRINCIPAL)).toHaveLength(1);
    });

    it('prefers the exact name over a longer one that contains it', () => {
      store.add(PRINCIPAL, { newName: 'קניות' }, ['חלב']);
      store.add(PRINCIPAL, { newName: 'קניות לבית' }, ['נורות']);
      expect(store.find(PRINCIPAL, ['קניות']).map((l) => l.name)).toEqual(['קניות']);
    });

    it('asks for a name when only generic words were said', async () => {
      expect((await run({ list: ['רשימה'], items: ['חלב'] })).clarify).toMatchObject({ clarify: { what: 'list_name' } });
    });
  });

  describe('lists.add', () => {
    it('starts a list, says so, and skips what is already there', async () => {
      const first = await run({ list: ['קניות'], items: ['חלב', 'ביצים'] });
      expect(plain(first.result!.text)).toContain('יצרתי רשימה חדשה: קניות');
      const second = await run({ list: ['קניות'], items: ['חלב', 'לחם'] });
      expect(plain(second.result!.text)).toContain('הוספתי לרשימת קניות: לחם');
      expect(plain(second.result!.text)).toContain('כבר ברשימה: חלב');
    });

    it('uses the one list there is when none is named, and asks which when there are several', async () => {
      await run({ list: ['קניות'], items: ['חלב'] });
      expect((await run({ items: ['לחם'] })).result).toBeDefined();
      await run({ list: ['מניות'], items: ['AAPL'] });
      expect((await run({ items: ['ביצים'] })).clarify).toMatchObject({
        clarify: { code: 'which_list', names: expect.arrayContaining(['קניות', 'מניות']) },
      });
    });

    it('a new list while others exist names them, in case one was meant', async () => {
      await run({ list: ['קניות'], items: ['חלב'] });
      const out = await run({ list: ['קנייה'], items: ['לחם'] });
      expect(plain(out.result!.text)).toContain('התכוונת לאחת מהרשימות הקיימות? קניות');
    });

    it('is all or nothing against the caps', () => {
      const items = Array.from({ length: MAX_ITEMS_PER_LIST }, (_, i) => `פריט ${i}`);
      for (let i = 0; i < MAX_ITEMS_PER_LIST; i += 20) store.add(PRINCIPAL, { newName: 'גדולה' }, items.slice(i, i + 20));
      expect(store.add(PRINCIPAL, { newName: 'גדולה' }, ['עוד אחד'])).toEqual({ kind: 'list_full' });
      for (let i = store.lists(PRINCIPAL).length; i < MAX_LISTS; i++) store.add(PRINCIPAL, { newName: `רשימה ${i}` }, ['x']);
      expect(store.add(PRINCIPAL, { newName: 'עוד רשימה' }, ['x'])).toEqual({ kind: 'lists_full' });
      expect(store.lists(PRINCIPAL)).toHaveLength(MAX_LISTS);
    });

    it('Undo removes its own items, and the list it made only when nothing else is on it', async () => {
      const made = await run({ list: ['קניות'], items: ['חלב'] });
      await run({ list: ['קניות'], items: ['לחם'] });
      expect(plain((await listsAdd.undo!(made.result!.compensating, ctx)).text)).toBe('בוטל.');
      const [list] = store.lists(PRINCIPAL);
      expect(list?.name).toBe('קניות');
      expect(store.items(list!.id).map((i) => i.text)).toEqual(['לחם']);
    });

    it('a stale Undo is refused whole, never partial', async () => {
      const made = await run({ list: ['קניות'], items: ['חלב', 'לחם'] });
      const [list] = store.lists(PRINCIPAL);
      const milk = store.items(list!.id).find((i) => i.text === 'חלב')!;
      store.removeItems(list!.id, [milk.id]);
      expect(plain((await listsAdd.undo!(made.result!.compensating, ctx)).text)).toBe('הרשימה השתנתה מאז, אז לא ביטלתי.');
      expect(store.items(list!.id).map((i) => i.text)).toEqual(['לחם']);
    });
  });

  describe('lists.show', () => {
    it('shows one list, all lists, or says there are none', async () => {
      const show = async (list?: string[]) => {
        const out = listsShow.resolve(list ? { list } : {}, ctx);
        if (out.kind !== 'ready') throw new Error('expected ready');
        return plain((await listsShow.execute(out.input, ctx)).text);
      };
      expect(await show()).toContain('אין רשימות שמורות');
      await run({ list: ['קניות'], items: ['חלב', 'לחם'] });
      expect(await show()).toBe('רשימת קניות:\n\n1. חלב\n2. לחם');
      await run({ list: ['מניות'], items: ['AAPL'] });
      expect(await show()).toBe('הרשימות שלך:\n\n• מניות — פריט אחד\n• קניות — שני פריטים');
      expect(await show(['רשימת המניות'])).toBe('רשימת מניות:\n\n1. AAPL');
    });
  });

  describe('lists.remove', () => {
    it('removes by the item named, and Undo puts it back', async () => {
      await run({ list: ['קניות'], items: ['חלב', 'חלב סויה', 'לחם'] });
      const out = listsRemove.resolve({ list: ['קניות'], items: ['חלב'] }, ctx);
      if (out.kind !== 'ready') throw new Error('expected ready');
      const result = await listsRemove.execute(out.input, ctx);
      expect(plain(result.text)).toBe('הורדתי מרשימת קניות: חלב');
      expect(plain((await listsRemove.undo!(result.compensating, ctx)).text)).toBe('בוטל.');
      expect(store.items(store.lists(PRINCIPAL)[0]!.id).map((i) => i.text)).toContain('חלב');
    });

    it('refuses the Undo when the same item was added back meanwhile', async () => {
      await run({ list: ['קניות'], items: ['חלב'] });
      const out = listsRemove.resolve({ items: ['חלב'] }, ctx);
      if (out.kind !== 'ready') throw new Error('expected ready');
      const result = await listsRemove.execute(out.input, ctx);
      await run({ list: ['קניות'], items: ['חלב'] });
      expect(plain((await listsRemove.undo!(result.compensating, ctx)).text)).toBe('יש כבר רשימה או פריט באותו שם, אז לא ביטלתי.');
    });

    it('says when nothing matches', () => {
      store.add(PRINCIPAL, { newName: 'קניות' }, ['חלב']);
      expect(listsRemove.resolve({ items: ['שוקולד'] }, ctx)).toMatchObject({ clarify: { code: 'not_found' } });
    });
  });

  describe('lists.delete', () => {
    it('asks which list even when there is one, and counts at execute time', async () => {
      await run({ list: ['קניות'], items: ['חלב'] });
      expect(listsDelete.resolve({}, ctx)).toMatchObject({ clarify: { code: 'which_list' } });
      const out = listsDelete.resolve({ list: ['קניות'] }, ctx);
      if (out.kind !== 'ready') throw new Error('expected ready');
      await run({ list: ['קניות'], items: ['לחם'] });
      expect(plain((await listsDelete.execute(out.input, ctx)).text)).toBe('רשימת קניות נמחקה, עם שני פריטים.');
      expect(store.lists(PRINCIPAL)).toEqual([]);
      expect(listsDelete.undo).toBeUndefined();
    });

    it('a new list by the same name starts empty, and old rows are purged after the Undo window', async () => {
      await run({ list: ['קניות'], items: ['חלב'] });
      const out = listsDelete.resolve({ list: ['קניות'] }, ctx);
      if (out.kind !== 'ready') throw new Error('expected ready');
      await listsDelete.execute(out.input, ctx);
      await run({ list: ['קניות'], items: ['לחם'] });
      expect(store.items(store.lists(PRINCIPAL)[0]!.id).map((i) => i.text)).toEqual(['לחם']);
      now += UNDO_EXPIRY_MS + 1;
      store.purgeRemoved();
      expect(driver.exec('SELECT COUNT(*) AS n FROM list_items')[0]?.['n']).toBe(1);
    });
  });
});

describe('lists through an agent turn', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let store: ListStore;
  let history: ConversationHistory;
  let agents: FakeAgent[];
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));

  const deps = (steps: FakeStep[]): PipelineDeps => {
    const agent = createFakeAgent(steps);
    agents.push(agent);
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      lists: store,
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      agent: { providers: [agent], budget: new TokenBudget(() => NOW), history, lock: new AgentLock(driver, () => NOW) },
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app' };
  };
  let seq = 0;
  const say = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.lists.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    store = new ListStore(driver, () => NOW);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    agents = [];
  });
  afterEach(() => driver.close());

  it('adds privately: the model never sees the list, and history keeps a placeholder', async () => {
    const out = await handleInbound(say('תוסיף אבוקדו לרשימת קניות'), deps([{ tool: 'lists.add', args: { list: ['קניות'], items: ['אבוקדו'] } }]));
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(out.private).toBe(true);
    expect(await history.recent(PRINCIPAL)).toEqual([expect.objectContaining({ user: he.privatePlaceholder, reply: he.privatePlaceholder })]);

    await handleInbound(say('מה יש ברשימה?'), deps([{ tool: 'lists.show', args: {} }, { text: 'never asked' }]));
    expect(agents[1]!.calls).toHaveLength(1);
    expect(seenByModel(agents[1]!)).not.toContain('אבוקדו');
  });

  it('"which list?" is answered by the next message, without the model', async () => {
    store.add(PRINCIPAL, { newName: 'קניות' }, ['חלב']);
    store.add(PRINCIPAL, { newName: 'מניות' }, ['AAPL']);
    const asked = await handleInbound(say('תוסיף ביצים'), deps([{ tool: 'lists.add', args: { items: ['ביצים'] } }]));
    if (asked.action !== 'reply') throw new Error('expected a reply');
    expect(plain(asked.text)).toContain('לאיזו רשימה?');
    const done = await handleInbound(say('קניות'), deps([]));
    if (done.action !== 'reply') throw new Error('expected a reply');
    expect(plain(done.text)).toContain('הוספתי לרשימת קניות: ביצים');
  });
});

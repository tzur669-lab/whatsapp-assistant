/**
 * Notes and expenses through a real agent turn (PLAN §6.22, 2026-10-05).
 *
 * The user's decision for notes: what is kept is never sent to the model. So
 * the cases here look at what the model was shown, and at what the agent's
 * history keeps, after every path that can carry a note: the save, a list, a
 * choice, a confirmation, an Undo.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { NoteStore } from '../../../src/tools/note-store.js';
import { ExpenseStore } from '../../../src/tools/expense-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_private';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const SECRET = 'הקוד של השער הוא 4321';

const plain = (text: string) => stripIsolates(text);

describe('private and terminal tools in an agent turn', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let notes: NoteStore;
  let expenses: ExpenseStore;
  let pending: PendingActions;
  let history: ConversationHistory;
  let agents: FakeAgent[];

  const deps = (steps: FakeStep[], caps: string[] = []): PipelineDeps => {
    const agent = createFakeAgent(steps);
    agents.push(agent);
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      notes,
      expenses,
      pending,
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      agent: {
        providers: [agent],
        budget: new TokenBudget(() => NOW),
        history,
        lock: new AgentLock(driver, () => NOW),
      },
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app', deviceCaps: caps };
  };

  let seq = 0;
  const say = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.private.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;
  const tap = (buttonId: string): InboundEvent =>
    ({ kind: 'button', wamid: `wamid.private.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, buttonId, forwarded: false }) as InboundEvent;

  /** Everything any model call was shown, plus what history would show the next one. */
  const everythingTheModelCouldSee = async () =>
    [
      ...agents.map(seenByModel),
      ...(await history.recent(PRINCIPAL)).flatMap((entry) => [entry.user, entry.reply]),
    ].join('\n');

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    notes = new NoteStore(driver, () => NOW);
    expenses = new ExpenseStore(driver, () => NOW);
    pending = new PendingActions(driver, () => NOW);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    agents = [];
  });
  afterEach(() => driver.close());

  describe('notes', () => {
    it('saves a note; the reply is private and history keeps only a placeholder', async () => {
      const out = await handleInbound(say(`תזכור ש${SECRET}`), deps([{ tool: 'notes.save', args: { text: SECRET } }]));
      if (out.action !== 'reply') throw new Error('expected a reply');
      expect(plain(out.text)).toContain(SECRET);
      expect(out.private).toBe(true);
      expect(out.buttons?.length).toBe(1);
      expect(notes.all(PRINCIPAL).map((note) => note.text)).toEqual([SECRET]);

      expect(await history.recent(PRINCIPAL)).toEqual([
        expect.objectContaining({ user: he.privatePlaceholder, reply: he.privatePlaceholder }),
      ]);
    });

    it('finds a note without the model ever seeing it: the turn ends at the read', async () => {
      notes.add(PRINCIPAL, SECRET);
      const out = await handleInbound(
        say('מה רשמתי על השער?'),
        deps([{ tool: 'notes.find', args: { query_variants: ['שער'] } }, { text: 'never asked' }]),
      );
      if (out.action !== 'reply') throw new Error('expected a reply');
      expect(plain(out.text)).toContain(SECRET);
      expect(out.private).toBe(true);
      expect(agents[0]!.calls).toHaveLength(1);
      expect(await everythingTheModelCouldSee()).not.toContain('4321');
    });

    it('a later turn sees the placeholder, not the note', async () => {
      notes.add(PRINCIPAL, SECRET);
      await handleInbound(say('תראה לי את הפתקים'), deps([{ tool: 'notes.find', args: {} }]));
      await handleInbound(say('תודה'), deps([{ text: 'בכיף' }]));
      const seen = seenByModel(agents[1]!);
      expect(seen).toContain(he.privatePlaceholder);
      expect(seen).not.toContain('4321');
    });

    it('a choice between notes, the confirmation, and the tap are all private', async () => {
      notes.add(PRINCIPAL, 'הקוד של השער 4321');
      notes.add(PRINCIPAL, 'הקוד של השער האחורי 9876');
      const choice = await handleInbound(say('תמחק את הפתק על השער'), deps([{ tool: 'notes.delete', args: { query_variants: ['השער'] } }]));
      expect(choice).toMatchObject({ action: 'reply', private: true });

      const asked = await handleInbound(
        say('תמחק את הפתק על השער האחורי'),
        deps([{ tool: 'notes.delete', args: { query_variants: ['השער האחורי'] } }]),
      );
      if (asked.action !== 'reply') throw new Error('expected a reply');
      expect(asked.private).toBe(true);
      expect(plain(asked.text)).toContain('9876');

      const done = await handleInbound(tap(asked.buttons![0]!.id), deps([]));
      expect(done).toMatchObject({ action: 'reply', private: true });
      expect(notes.all(PRINCIPAL).map((note) => note.text)).toEqual(['הקוד של השער 4321']);
      expect(await everythingTheModelCouldSee()).not.toMatch(/4321|9876/);
    });

    it('Undo of a save is private too, and removes it', async () => {
      const saved = await handleInbound(say(`תזכור ש${SECRET}`), deps([{ tool: 'notes.save', args: { text: SECRET } }]));
      if (saved.action !== 'reply') throw new Error('expected a reply');
      const undone = await handleInbound(tap(saved.buttons![0]!.id), deps([]));
      expect(undone).toMatchObject({ action: 'reply', private: true });
      expect(notes.all(PRINCIPAL)).toEqual([]);
    });
  });

  describe('expenses', () => {
    it('records a spending on today when no day is said', async () => {
      const out = await handleInbound(
        say('הוצאתי 45 על קפה'),
        deps([{ tool: 'expenses.add', args: { amount: 45, category: 'food', description: 'קפה' } }]),
      );
      if (out.action !== 'reply') throw new Error('expected a reply');
      expect(plain(out.text)).toContain('₪45 · אוכל · יום ה׳ 24.9');
      expect(out.private).toBeUndefined();
    });

    it('a sum ends the turn with code\'s text, and stays in history', async () => {
      expenses.add(PRINCIPAL, { amountAgorot: 4500, category: 'food', description: null, spentOn: '2026-09-20' });
      expenses.add(PRINCIPAL, { amountAgorot: 30000, category: 'fuel', description: null, spentOn: '2026-09-21' });
      const out = await handleInbound(
        say('כמה הוצאתי החודש?'),
        deps([{ tool: 'expenses.summary', args: { period: 'this_month' } }, { text: 'never asked' }]),
      );
      if (out.action !== 'reply') throw new Error('expected a reply');
      expect(plain(out.text)).toContain('סך ההוצאות החודש: ₪345 (שתי הוצאות)');
      expect(agents[0]!.calls).toHaveLength(1);
      expect((await history.recent(PRINCIPAL))[0]?.reply).toBe(out.text);
    });

    it('the export is offered only to an app that saves files', async () => {
      await handleInbound(say('תייצא את ההוצאות'), deps([{ text: 'x' }], ['cards']));
      const names = agents[0]!.tools[0]!.map((tool) => tool.function.name);
      expect(names).not.toContain('expenses__export');

      await handleInbound(say('תייצא את ההוצאות'), deps([{ text: 'x' }], ['cards', 'file']));
      expect(agents[1]!.tools[0]!.map((tool) => tool.function.name)).toContain('expenses__export');
    });

    it('exports as a file card the app runs; the content stays in the pending row', async () => {
      expenses.add(PRINCIPAL, { amountAgorot: 4500, category: 'food', description: '=HYPERLINK("x")', spentOn: '2026-09-20' });
      const out = await handleInbound(say('תייצא את ההוצאות'), deps([{ tool: 'expenses.export', args: {} }], ['cards', 'file']));
      if (out.action !== 'reply') throw new Error('expected a reply');
      expect(out.card).toMatchObject({ type: 'file', autoRun: true });
      expect(out.card!.preview).not.toContain('HYPERLINK');

      const row = driver.exec('SELECT input_json FROM pending_actions WHERE id = ?', out.card!.actionId)[0];
      const input = JSON.parse(String(row?.['input_json'])) as { content: string; name: string };
      expect(input.name).toBe('expenses-2026-09-24.csv');
      expect(input.content).toContain(`2026-09-20,45.00,אוכל,"'=HYPERLINK(""x"")"`);
    });
  });
});

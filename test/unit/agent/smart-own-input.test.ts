/**
 * Smart conversations, 2026-10-11: private tools, and writes that never ask.
 *
 * 1. Private tools (notes, lists, the portfolio, facts) are offered in a smart
 *    conversation as in a local one — "add milk to the shopping list" went to
 *    Google Tasks while `lists.add` was not offered. Their replies never return
 *    to a model and the history keeps placeholders, Gemini or qwen.
 * 2. A write whose every reply echoes only its own call (`consent:
 *    'exempt-own-input'` in the registry) runs with no consent card; its reply
 *    stays in the history. Anything that shows something of the source still
 *    asks.
 *
 * Every store holds a SECRET the exempt replies must never carry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, PipelineOutcome, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { ExpenseStore } from '../../../src/tools/expense-store.js';
import { NoteStore } from '../../../src/tools/note-store.js';
import { ListStore } from '../../../src/tools/list-store.js';
import { FactStore } from '../../../src/tools/fact-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { SuspendedTurns } from '../../../src/agent/turns.js';
import { ConversationConsents, parseConsentButton } from '../../../src/agent/consents.js';
import { QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { consentRuleOf, TOOL_NAMES } from '../../../src/tools/registry.js';
import type { ToolName } from '../../../src/tools/registry.js';
import { consentText } from '../../../src/render/consent.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import type { CalendarClient, CalendarEvent } from '../../../src/google/calendar.js';
import type { TasksClient } from '../../../src/google/tasks.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_own_input';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const GEMINI = SMART_MODELS[0]!.id;
const SMART = '66666666-6666-4666-8666-666666666666';
const ALL_CAPS = ['cards', 'file', 'device_query'];
/** In every store: no exempt reply, and nothing a model is sent, may carry it. */
const SECRET = 'פגישה סודית עם רינה';
const TOMORROW_AT_10 = {
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 10, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

const plain = (text: string) => stripIsolates(text);

describe('smart conversations: private tools and own-input writes', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let expenses: ExpenseStore;
  let notes: NoteStore;
  let lists: ListStore;
  let facts: FactStore;
  let pending: PendingActions;
  let history: ConversationHistory;
  let lock: AgentLock;
  let turns: SuspendedTurns;
  let consents: ConversationConsents;
  let budget: TokenBudget;
  let calendarReads: number;
  let created: { title: string; startUtc: number; endUtc: number }[];

  /** A calendar holding the SECRET event tomorrow at 10:00, the slot the tests book. */
  const calendar = (): CalendarClient => {
    const start = Date.parse('2026-09-25T07:00:00Z');
    const secret: CalendarEvent = {
      id: 'evt-secret',
      title: SECRET,
      startUtc: start,
      endUtc: start + 3_600_000,
      allDay: false,
      createdByAssistant: false,
      etag: null,
    };
    return {
      async listEvents() {
        calendarReads++;
        return { ok: true as const, value: [secret] };
      },
      async listAllEvents() {
        calendarReads++;
        return { ok: true as const, value: [secret] };
      },
      async createEvent(draftEvent: { title: string; startUtc: number; endUtc: number }) {
        created.push(draftEvent);
        const event: CalendarEvent = { ...secret, id: `evt-${created.length}`, title: draftEvent.title, startUtc: draftEvent.startUtc, endUtc: draftEvent.endUtc, createdByAssistant: true };
        return { ok: true as const, value: event };
      },
    } as unknown as CalendarClient;
  };

  type Setup = { qwen?: FakeAgent; gemini?: FakeAgent | null };

  const deps = (setup: Setup = {}): PipelineDeps => {
    const services: Services = {
      reminders,
      expenses,
      notes,
      lists,
      facts,
      pending,
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      calendar: calendar(),
      // Never called: a tasks write asks first.
      tasks: {} as TasksClient,
      nlu: [createFakeNlu([draft('unsupported')])],
      tokenBudget: budget,
      agent: {
        providers: setup.qwen ? [setup.qwen] : [],
        ...(setup.gemini === null ? {} : { smartProviders: [setup.gemini ?? gemini([])] }),
        budget,
        history,
        lock,
        turns,
        consents,
      },
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app', deviceCaps: ALL_CAPS };
  };

  let seq = 0;
  const text = (body: string, options: { forwarded?: boolean } = {}): InboundEvent =>
    ({
      kind: 'text',
      wamid: `app:in:own.${++seq}`,
      from: '972500000000',
      sentAtMs: NOW - 1_000,
      text: body,
      forwarded: options.forwarded === true,
      conversationId: SMART,
      mode: 'smart',
    }) as InboundEvent;
  const tap = (buttonId: string): InboundEvent =>
    ({ kind: 'button', wamid: `app:in:own.${++seq}`, from: '972500000000', sentAtMs: NOW - 500, buttonId, forwarded: false, conversationId: SMART }) as InboundEvent;

  const qwen = (steps: FakeStep[]) => createFakeAgent(steps, QWEN, 500, 'primary');
  const gemini = (steps: FakeStep[]) => createFakeAgent(steps, GEMINI, 500, 'smart');
  const offeredNames = (agent: FakeAgent, call = 0) => agent.tools[call]!.map((tool) => tool.function.name);

  type Reply = Extract<PipelineOutcome, { action: 'reply' }>;
  const asReply = (out: PipelineOutcome): Reply => {
    if (out.action !== 'reply') throw new Error(`expected a reply, got ${out.action}`);
    return out;
  };
  const isConsentCard = (out: Reply) => (out.buttons ?? []).some((button) => parseConsentButton(button.id) !== null);
  const lastKept = async () => (await history.recent(PRINCIPAL, SMART)).at(-1);
  /** Fill Gemini's request minute: qwen takes the smart conversation's turn. */
  const exhaustGemini = () => {
    for (let i = 0; i < (SMART_MODELS[0]!.minuteRequests ?? 0); i++) budget.reserve(GEMINI, 1);
  };
  const waiting = () => driver.exec(`SELECT kind FROM agent_turns WHERE status = 'waiting'`);

  beforeEach(async () => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    expenses = new ExpenseStore(driver, () => NOW);
    notes = new NoteStore(driver, () => NOW);
    lists = new ListStore(driver, () => NOW);
    pending = new PendingActions(driver, () => NOW);
    const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
    facts = new FactStore(driver, () => NOW, keyring);
    history = new ConversationHistory(driver, () => NOW, keyring);
    lock = new AgentLock(driver, () => NOW);
    turns = new SuspendedTurns(driver, () => NOW, keyring);
    consents = new ConversationConsents(driver, () => NOW);
    budget = new TokenBudget(() => NOW);
    calendarReads = 0;
    created = [];

    reminders.schedule({ principal: PRINCIPAL, text: SECRET, dueAtUtc: NOW + 86_400_000, localWallTime: '2026-09-25T12:00', tz: 'Asia/Jerusalem' });
    expenses.add(PRINCIPAL, { amountAgorot: 99_900, category: 'other', description: SECRET, spentOn: '2026-09-23' });
    notes.add(PRINCIPAL, SECRET);
    lists.add(PRINCIPAL, { newName: 'קניות' }, [SECRET]);
    await facts.add(PRINCIPAL, SECRET);
    // The conversation's first message records it smart.
    await handleInbound(text('/help'), deps());
  });
  afterEach(() => driver.close());

  describe('private tools', () => {
    it('are offered to Gemini on a typed turn, as in a local one', async () => {
      const g = gemini([{ text: 'שלום' }]);
      await handleInbound(text('שלום'), deps({ gemini: g }));
      for (const name of ['notes__save', 'notes__find', 'lists__add', 'lists__show', 'lists__remove', 'portfolio__show', 'memory__remember']) {
        expect(offeredNames(g), name).toContain(name);
      }
    });

    it('lists.add runs with no consent card; the reply is private and the history keeps placeholders only', async () => {
      const g = gemini([{ tool: 'lists.add', args: { list: ['קניות'], items: ['חלב'] } }, { text: 'never asked' }]);
      const out = asReply(await handleInbound(text('תוסיף חלב לרשימת הקניות'), deps({ gemini: g })));
      expect(isConsentCard(out)).toBe(false);
      // A smart model's write confirms first (its role), privately.
      expect(out.buttons?.map((button) => button.id.split(':')[0])).toEqual(['pa', 'pa']);
      expect(out.private).toBe(true);
      expect(g.calls).toHaveLength(1);
      expect(waiting()).toEqual([]);
      expect(seenByModel(g)).not.toContain(SECRET);
      expect(await lastKept()).toMatchObject({ user: he.privatePlaceholder, reply: he.privatePlaceholder });

      await handleInbound(tap(out.buttons![0]!.id), deps());
      expect(lists.items(lists.find(PRINCIPAL, ['קניות'])[0]!.id).map((item) => item.text)).toContain('חלב');
    });

    it('lists.add on qwen in a smart conversation runs at once, privately', async () => {
      exhaustGemini();
      const q = qwen([{ tool: 'lists.add', args: { list: ['קניות'], items: ['ביצים'] } }, { text: 'never asked' }]);
      const out = asReply(await handleInbound(text('תוסיף ביצים לרשימת הקניות'), deps({ qwen: q })));
      expect(out.private).toBe(true);
      expect(q.calls).toHaveLength(1);
      expect(lists.items(lists.find(PRINCIPAL, ['קניות'])[0]!.id).map((item) => item.text)).toContain('ביצים');
      expect(await lastKept()).toMatchObject({ user: he.privatePlaceholder, reply: he.privatePlaceholder });
    });

    it('a private read never returns to the model: notes.find ends the turn at the read', async () => {
      const g = gemini([{ tool: 'notes.find', args: {} }, { text: 'never asked' }]);
      const out = asReply(await handleInbound(text('מה הפתקים שלי?'), deps({ gemini: g })));
      expect(plain(out.text)).toContain(SECRET);
      expect(out.private).toBe(true);
      expect(g.calls).toHaveLength(1);
      expect(seenByModel(g)).not.toContain(SECRET);
      expect(await lastKept()).toMatchObject({ user: he.privatePlaceholder, reply: he.privatePlaceholder });

      // The next turn sees placeholders, not the note.
      const next = gemini([{ text: 'בסדר' }]);
      await handleInbound(text('תודה'), deps({ gemini: next }));
      expect(seenByModel(next)).toContain(he.privatePlaceholder);
      expect(seenByModel(next)).not.toContain(SECRET);
    });

    it('lists.show and the portfolio stay private on qwen in a smart conversation too', async () => {
      exhaustGemini();
      const q = qwen([{ tool: 'lists.show', args: { list: ['קניות'] } }, { text: 'never asked' }]);
      const out = asReply(await handleInbound(text('מה ברשימת הקניות?'), deps({ qwen: q })));
      expect(plain(out.text)).toContain(SECRET);
      expect(out.private).toBe(true);
      expect(q.calls).toHaveLength(1);
      expect(seenByModel(q)).not.toContain(SECRET);
      expect(await lastKept()).toMatchObject({ user: he.privatePlaceholder, reply: he.privatePlaceholder });
    });

    it('memory.remember: no consent card, it confirms (a smart model), facts are still never sent, and the reply is withheld', async () => {
      const g = gemini([{ tool: 'memory.remember', args: { text: 'אני גר בחיפה' } }]);
      const out = asReply(await handleInbound(text('תזכור עליי שאני גר בחיפה'), deps({ gemini: g })));
      expect(isConsentCard(out)).toBe(false);
      // A smart model's write confirms: a confirmation card, not a consent one.
      expect(out.buttons?.map((button) => button.id.split(':')[0])).toEqual(['pa', 'pa']);
      expect(seenByModel(g)).not.toContain('About the user');
      expect(seenByModel(g)).not.toContain(SECRET);
      // Its words were this turn's; what code answered is not kept.
      expect(await lastKept()).toMatchObject({ user: 'תזכור עליי שאני גר בחיפה', reply: he.withheldPlaceholder });

      await handleInbound(tap(out.buttons![0]!.id), deps());
      expect((await facts.all(PRINCIPAL)).map((fact) => fact.text)).toContain('אני גר בחיפה');
      const next = gemini([{ text: 'בסדר' }]);
      await handleInbound(text('ומה עכשיו?'), deps({ gemini: next }));
      expect(seenByModel(next)).not.toContain('About the user');
      expect(seenByModel(next)).not.toContain(SECRET);
    });

    it('memory.remember on text shared into the conversation: a local model, tainted, so nothing is kept without a tap (§6.26)', async () => {
      const q = qwen([{ tool: 'memory.remember', args: { text: 'אני גר בתל אביב' } }]);
      const g = gemini([]);
      const out = asReply(await handleInbound(text('תזכור עליי: אני גר בתל אביב', { forwarded: true }), deps({ qwen: q, gemini: g })));
      expect(g.calls).toHaveLength(0);
      expect(offeredNames(q)).toContain('memory__remember');
      // A tainted write confirms first, as in a local conversation; no consent card.
      expect(isConsentCard(out)).toBe(false);
      expect(out.buttons?.map((button) => button.id.split(':')[0])).toEqual(['pa', 'pa']);
      expect((await facts.all(PRINCIPAL)).map((fact) => fact.text)).not.toContain('אני גר בתל אביב');
      expect(await lastKept()).toMatchObject({ user: he.sharedPlaceholder, reply: he.sharedPlaceholder, tainted: true });
    });
  });

  describe('writes that only echo their own call', () => {
    const CALLS: ReadonlyArray<{ tool: ToolName; args: Record<string, unknown>; says: string }> = [
      { tool: 'reminders.create', args: { text: 'להתקשר לאמא', ...TOMORROW_AT_10 }, says: 'להתקשר לאמא' },
      { tool: 'reminders.repeat', args: { text: 'לקחת ויטמין', every: 'day', time: TOMORROW_AT_10.time }, says: 'לקחת ויטמין' },
      { tool: 'reminders.at_rest', args: { text: 'להדליק נרות', event: 'shabbat_start', minutes: 20 }, says: 'להדליק נרות' },
      { tool: 'reminders.scheduled_read', args: { topic: 'weather', every: 'day', time: TOMORROW_AT_10.time }, says: 'מזג האוויר' },
      { tool: 'expenses.add', args: { amount: 40, category: 'fuel', description: 'דלק לרכב' }, says: 'דלק לרכב' },
      { tool: 'calendar.create_event', args: { title: 'ספר עם דני', ...TOMORROW_AT_10, duration_minutes: 60 }, says: 'ספר עם דני' },
    ];

    it('cover every exempt tool', () => {
      // `reminders.when` is offered only for "when … arrives" in the app: its
      // smart case is in `test/unit/tools/watch.test.ts` (block J, J4).
      expect(CALLS.map((call) => call.tool).sort()).toEqual(
        TOOL_NAMES.filter((name) => consentRuleOf(name) === 'exempt-own-input' && name !== 'reminders.when').sort(),
      );
    });

    for (const call of CALLS) {
      it(`${call.tool}: Gemini gets no consent card but a confirmation of its own words, kept in the history`, async () => {
        const g = gemini([{ tool: call.tool, args: call.args }]);
        const out = asReply(await handleInbound(text('בבקשה'), deps({ gemini: g })));
        expect(isConsentCard(out), out.text).toBe(false);
        expect(waiting()).toEqual([]);
        expect(out.buttons?.map((button) => button.id.split(':')[0])).toEqual(['pa', 'pa']);
        expect(plain(out.text)).toContain(call.says);
        expect(out.text).not.toContain(SECRET);
        expect(await lastKept()).toMatchObject({ user: 'בבקשה', reply: out.text });
        expect(calendarReads).toBe(0);
      });

      it(`${call.tool}: qwen in a smart conversation runs it at once, and the reply is kept`, async () => {
        exhaustGemini();
        const q = qwen([{ tool: call.tool, args: call.args }]);
        const out = asReply(await handleInbound(text('בבקשה'), deps({ qwen: q })));
        expect(isConsentCard(out)).toBe(false);
        expect(plain(out.text)).toContain(call.says);
        expect(out.text).not.toContain(SECRET);
        expect(await lastKept()).toMatchObject({ reply: out.text });
        expect(seenByModel(q)).not.toContain(SECRET);
        expect(calendarReads).toBe(0);
      });
    }

    it('calendar.create_event over a busy slot: no conflict check reads the calendar, so no title comes back', async () => {
      exhaustGemini();
      const q = qwen([{ tool: 'calendar.create_event', args: { title: 'ספר עם דני', ...TOMORROW_AT_10, duration_minutes: 60 } }]);
      const out = asReply(await handleInbound(text('תקבע לי ספר מחר בעשר לשעה'), deps({ qwen: q })));
      expect(created).toHaveLength(1);
      expect(calendarReads).toBe(0);
      expect(out.text).not.toContain(SECRET);
      const kept = await lastKept();
      expect(kept?.reply).not.toContain(SECRET);
    });

    it('is offered on a voice note in a smart conversation, as in a local one', async () => {
      const g = gemini([{ text: 'בסדר' }]);
      const voice: InboundEvent = {
        kind: 'audio',
        wamid: `app:in:own.voice.${++seq}`,
        from: '972500000000',
        sentAtMs: NOW - 1_000,
        mediaId: '',
        mimeType: 'audio/mp4',
        voiceNote: true,
        forwarded: false,
        conversationId: SMART,
        mode: 'smart',
      };
      const withVoice: PipelineDeps = {
        ...deps({ gemini: g }),
        transcribe: async () => ({ status: 'ok', text: 'תזכיר לי מחר בעשר להתקשר לאמא', confidence: 'high', language: 'he' }),
      };
      await handleInbound(voice, withVoice);
      const offered = offeredNames(g);
      expect(offered).toContain('reminders__create');
      expect(offered).toContain('lists__add');
      expect(offered).not.toContain('reminders__list');
      expect(offered).not.toContain('reminders__cancel');
    });
  });

  describe('everything else still asks', () => {
    it('a write that finds a stored target: reminders.cancel suspends for consent', async () => {
      const g = gemini([{ tool: 'reminders.cancel', args: { query_variants: ['פגישה'] } }]);
      const out = asReply(await handleInbound(text('תבטל את התזכורת על הפגישה'), deps({ gemini: g })));
      expect(isConsentCard(out)).toBe(true);
      expect(plain(out.text)).toBe(plain(consentText.card('reminders', 'he')));
      expect(out.text).not.toContain(SECRET);
      expect(waiting()).toEqual([{ kind: 'consent' }]);
    });

    it('a write that names something of the source: tasks.add suspends for consent', async () => {
      const g = gemini([{ tool: 'tasks.add', args: { text: 'חלב', list: 'קניות' } }]);
      const out = asReply(await handleInbound(text('תוסיף חלב למשימות'), deps({ gemini: g })));
      expect(isConsentCard(out)).toBe(true);
      expect(plain(out.text)).toBe(plain(consentText.card('tasks', 'he')));
    });

    it('a read: reminders.list suspends for consent, and its reply would be withheld without it', async () => {
      const g = gemini([{ tool: 'reminders.list', args: {} }]);
      const out = asReply(await handleInbound(text('מה התזכורות שלי?'), deps({ gemini: g })));
      expect(isConsentCard(out)).toBe(true);
      expect(seenByModel(g)).not.toContain(SECRET);
    });
  });
});

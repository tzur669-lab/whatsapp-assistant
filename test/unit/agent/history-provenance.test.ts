/**
 * The history remembers where a reply's data came from, and replays it only
 * while that source is still allowed (2026-10-12, docs/IMPROVEMENT_PLAN.md T1
 * steps 1–2; the user's decisions D1 and D2).
 *
 * 1. Every new entry carries `src`: the consent sources of this turn's tools
 *    (not public, not own-input writes) and the `src` of every entry the model
 *    saw in full. A tool-less follow-up that repeats a calendar title inherits
 *    `calendar` from the history it saw.
 * 2. In a smart conversation an entry whose `src` holds a source not allowed
 *    now is replayed with `he.withheldPlaceholder`; a legacy entry (no `src`)
 *    keeps the user's words and loses its reply. Local conversations replay
 *    as before.
 *
 * 3. A suspended turn (a consent card, a phone read) resends its messages on
 *    resume: the history it began with and this turn's tool results. If any of
 *    their sources is no longer allowed, the turn ends with no model call
 *    (T1-3, s1-s6 of the plan). A source approved "this time" stays allowed
 *    for the whole turn; a smart state stored before `historySources` ends.
 * 4. "This time" is not retained (D1): the next turn sees the placeholder.
 *
 * The calendar holds a SECRET title: after a revoke, no model may see it again.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound, resumeFromPhone } from '../../../src/core/pipeline.js';
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
import { ConversationHistory, provenanceOf, replayByConsent } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { SuspendedTurns } from '../../../src/agent/turns.js';
import { ConversationConsents, parseConsentButton } from '../../../src/agent/consents.js';
import { QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import type { CalendarClient, CalendarEvent } from '../../../src/google/calendar.js';
import type { PhoneReadResult } from '../../../src/tools/phone-reads.js';
import type { TasksClient } from '../../../src/google/tasks.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_provenance';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const GEMINI = SMART_MODELS[0]!.id;
const SMART = '77777777-7777-4777-8777-777777777777';
const LOCAL = '88888888-8888-4888-8888-888888888888';
const SECRET = 'פגישה סודית עם רינה';
const READ_TOMORROW = { tool: 'calendar.list_events', args: { date: { kind: 'relative_days', offset: 1 } } };
const TOMORROW_AT_10 = {
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 10, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

describe('history provenance', () => {
  describe('the entry and the replay rule (pure)', () => {
    const entry = (reply: string, src?: string[]) => ({ user: 'u', reply, tainted: false, ...(src ? { src: src as never } : {}) });

    it('collects the sources of the entries it is given; a legacy entry adds none', () => {
      expect(provenanceOf([entry('a', ['calendar']), entry('b'), entry('c', ['reminders', 'calendar'])])).toEqual(['calendar', 'reminders']);
    });

    it('withholds a reply whose source is not allowed now, and a legacy reply; the user side stays', () => {
      const replayed = replayByConsent([entry('cal', ['calendar']), entry('old'), entry('ok', ['reminders']), entry('own', [])], ['reminders'], 'X');
      expect(replayed.entries.map((e) => [e.user, e.reply])).toEqual([
        ['u', 'X'],
        ['u', 'X'],
        ['u', 'ok'],
        ['u', 'own'],
      ]);
      // Only what is replayed in full counts towards the next entry's sources.
      expect(replayed.sources).toEqual(['reminders']);
    });
  });

  describe('stored and decoded', () => {
    let driver: TestSqlDriver;
    let history: ConversationHistory;
    beforeEach(() => {
      driver = new TestSqlDriver();
      new Repository(driver).migrate(MIGRATIONS);
      history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    });
    afterEach(() => driver.close());

    it('round-trips `src`, an empty one included', async () => {
      await history.append(PRINCIPAL, { user: 'a', reply: 'b', tainted: false, src: ['calendar'] }, SMART);
      await history.append(PRINCIPAL, { user: 'c', reply: 'd', tainted: false, src: [] }, SMART);
      expect((await history.recent(PRINCIPAL, SMART)).map((e) => e.src)).toEqual([['calendar'], []]);
    });

    it('decodes an entry written before `src` existed, without one', async () => {
      await history.append(PRINCIPAL, { user: 'a', reply: 'b', tainted: false }, SMART);
      const [old] = await history.recent(PRINCIPAL, SMART);
      expect(old).toEqual({ user: 'a', reply: 'b', tainted: false });
    });
  });

  describe('through the pipeline', () => {
    let driver: TestSqlDriver;
    let repo: Repository;
    let history: ConversationHistory;
    let consents: ConversationConsents;
    let budget: TokenBudget;
    let turns: SuspendedTurns;
    let stores: Pick<Services, 'reminders' | 'expenses' | 'notes' | 'lists' | 'facts' | 'pending'>;

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
          return { ok: true as const, value: [secret] };
        },
        async listAllEvents() {
          return { ok: true as const, value: [secret] };
        },
      } as unknown as CalendarClient;
    };

    const deps = (setup: { gemini?: FakeAgent; qwen?: FakeAgent } = {}): PipelineDeps => {
      const services: Services = {
        ...stores,
        questions: new OpenQuestions(driver, () => NOW),
        deferred: new UndoActions(driver, () => NOW),
        calendar: calendar(),
        tasks: {} as TasksClient,
        nlu: [createFakeNlu([draft('unsupported')])],
        tokenBudget: budget,
        agent: {
          providers: setup.qwen ? [setup.qwen] : [],
          smartProviders: [setup.gemini ?? gemini([])],
          budget,
          history,
          lock: new AgentLock(driver, () => NOW),
          turns,
          consents,
        },
      } as Services;
      return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app', deviceCaps: ['cards', 'file', 'device_query'] };
    };

    let seq = 0;
    const say = (body: string, conversation = SMART): InboundEvent =>
      ({
        kind: 'text',
        wamid: `app:in:prov.${++seq}`,
        from: '972500000000',
        sentAtMs: NOW - 1_000,
        text: body,
        forwarded: false,
        conversationId: conversation,
        mode: conversation === SMART ? 'smart' : 'local',
      }) as InboundEvent;

    const gemini = (steps: FakeStep[]) => createFakeAgent(steps, GEMINI, 500, 'smart');
    const qwen = (steps: FakeStep[]) => createFakeAgent(steps, QWEN, 500, 'primary');
    const kept = async (conversation = SMART) => history.recent(PRINCIPAL, conversation);
    const reply = (out: PipelineOutcome) => {
      if (out.action !== 'reply') throw new Error(`expected a reply, got ${out.action}`);
      return out;
    };
    const onceButton = (out: PipelineOutcome) => {
      const found = reply(out).buttons?.find((b) => {
        const parsed = parseConsentButton(b.id);
        return parsed?.kind === 'answer' && parsed.verb === 'once';
      });
      if (!found) throw new Error(`expected a consent card, got ${JSON.stringify(out)}`);
      return found.id;
    };

    beforeEach(async () => {
      driver = new TestSqlDriver();
      repo = new Repository(driver);
      repo.migrate(MIGRATIONS);
      const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
      history = new ConversationHistory(driver, () => NOW, keyring);
      consents = new ConversationConsents(driver, () => NOW);
      budget = new TokenBudget(() => NOW);
      turns = new SuspendedTurns(driver, () => NOW, keyring);
      stores = {
        reminders: new ReminderStore(driver, () => NOW),
        expenses: new ExpenseStore(driver, () => NOW),
        notes: new NoteStore(driver, () => NOW),
        lists: new ListStore(driver, () => NOW),
        facts: new FactStore(driver, () => NOW, keyring),
        pending: new PendingActions(driver, () => NOW),
      };
      // Each conversation's first message records its mode.
      await handleInbound(say('/help'), deps());
      await handleInbound(say('/help', LOCAL), deps());
    });
    afterEach(() => driver.close());

    /** A granted calendar read whose answer names the SECRET. */
    const readCalendar = async () => {
      consents.grant(PRINCIPAL, SMART, 'calendar');
      const g = gemini([READ_TOMORROW, { text: `מחר: ${SECRET}` }]);
      reply(await handleInbound(say('מה יש לי מחר?'), deps({ gemini: g })));
      expect(seenByModel(g)).toContain(SECRET);
    };

    it('a calendar read is stored with `calendar`', async () => {
      await readCalendar();
      expect((await kept()).at(-1)).toMatchObject({ reply: `מחר: ${SECRET}`, src: ['calendar'] });
    });

    it('a tool-less follow-up inherits the sources of the history it saw', async () => {
      await readCalendar();
      const g = gemini([{ text: `כן, ${SECRET}` }]);
      reply(await handleInbound(say('ומה זה היה?'), deps({ gemini: g })));
      expect((await kept()).at(-1)).toMatchObject({ reply: `כן, ${SECRET}`, src: ['calendar'] });
    });

    it('an own-input write adds no source', async () => {
      const g = gemini([{ tool: 'reminders.create', args: { text: 'להתקשר לאמא', ...TOMORROW_AT_10 } }]);
      reply(await handleInbound(say('תזכיר לי מחר ב-10 להתקשר לאמא'), deps({ gemini: g })));
      expect((await kept()).at(-1)?.src).toEqual([]);
    });

    it('after a revoke, the calendar reply reaches no model again', async () => {
      await readCalendar();
      consents.revoke(PRINCIPAL, SMART, 'calendar');
      const next = gemini([{ text: 'בסדר' }]);
      await handleInbound(say('תודה'), deps({ gemini: next }));
      expect(seenByModel(next)).not.toContain(SECRET);
      expect(seenByModel(next)).toContain(he.withheldPlaceholder);
      // The user's own words are still sent (invariant 2).
      expect(seenByModel(next)).toContain('מה יש לי מחר?');
    });

    it('read → a tool-less follow-up repeating the title → revoke: both are placeholders', async () => {
      await readCalendar();
      reply(await handleInbound(say('ומה זה היה?'), deps({ gemini: gemini([{ text: `כן, ${SECRET}` }]) })));
      consents.revoke(PRINCIPAL, SMART, 'calendar');
      const next = gemini([{ text: 'בסדר' }]);
      await handleInbound(say('תודה'), deps({ gemini: next }));
      expect(seenByModel(next)).not.toContain(SECRET);
      // The new entry saw neither in full, so it carries no calendar.
      expect((await kept()).at(-1)?.src).toEqual([]);
    });

    it('an own-input reply is still replayed after a calendar revoke', async () => {
      consents.grant(PRINCIPAL, SMART, 'calendar');
      const out = reply(
        await handleInbound(
          say('תזכיר לי מחר ב-10 להתקשר לאמא'),
          deps({ gemini: gemini([{ tool: 'reminders.create', args: { text: 'להתקשר לאמא', ...TOMORROW_AT_10 } }]) }),
        ),
      );
      consents.revoke(PRINCIPAL, SMART, 'calendar');
      const next = gemini([{ text: 'בסדר' }]);
      await handleInbound(say('תודה'), deps({ gemini: next }));
      expect(seenByModel(next)).toContain(out.text);
    });

    it('a legacy entry: a placeholder reply in a smart conversation, unchanged in a local one', async () => {
      await history.append(PRINCIPAL, { user: 'מה יש מחר?', reply: `ישן: ${SECRET}`, tainted: false }, SMART);
      await history.append(PRINCIPAL, { user: 'מה יש מחר?', reply: `ישן: ${SECRET}`, tainted: false }, LOCAL);

      const g = gemini([{ text: 'בסדר' }]);
      await handleInbound(say('ומה עוד?'), deps({ gemini: g }));
      expect(seenByModel(g)).not.toContain(SECRET);
      expect(seenByModel(g)).toContain('מה יש מחר?');
      expect(seenByModel(g)).toContain(he.withheldPlaceholder);

      const q = qwen([{ text: 'בסדר' }]);
      await handleInbound(say('ומה עוד?', LOCAL), deps({ qwen: q }));
      expect(seenByModel(q)).toContain(`ישן: ${SECRET}`);
    });

    describe('a resumed turn (T1-3)', () => {
      const tap = (buttonId: string): InboundEvent =>
        ({ kind: 'button', wamid: `app:in:prov.${++seq}`, from: '972500000000', sentAtMs: NOW - 500, buttonId, forwarded: false, conversationId: SMART }) as InboundEvent;
      const CALLS: PhoneReadResult = { status: 'ok', items: [{ name: 'יוסי', at: NOW - 60_000 }] };
      const answerPhone = async (out: PipelineOutcome, g: FakeAgent) => {
        if (out.action !== 'device_query') throw new Error(`expected device_query, got ${out.action}`);
        const begun = turns.begin(out.queryId, PRINCIPAL);
        if (begun.kind !== 'run') throw new Error(`expected run, got ${begun.kind}`);
        return resumeFromPhone(
          { queryId: out.queryId, wamid: begun.wamid, ciphertext: begun.ciphertext, result: CALLS, sentAtMs: NOW - 1_000 },
          deps({ gemini: g }),
        );
      };
      const entries = async () => (await kept()).length;

      it('s1: a calendar read, a consent card for reminders, calendar revoked: the tap ends the turn, no model call', async () => {
        consents.grant(PRINCIPAL, SMART, 'calendar');
        const card = await handleInbound(say('מה יש לי מחר ומה התזכורות?'), deps({ gemini: gemini([READ_TOMORROW, { tool: 'reminders.list', args: {} }]) }));
        const before = await entries();
        consents.revoke(PRINCIPAL, SMART, 'calendar');
        const g = gemini([{ text: `שוב ${SECRET}` }]);
        await handleInbound(tap(onceButton(card)), deps({ gemini: g }));
        expect(g.calls).toHaveLength(0);
        expect(seenByModel(g)).not.toContain(SECRET);
        expect(await entries()).toBe(before);
      });

      it('s2: the same with calendar still allowed: the turn goes on and the model sees the read', async () => {
        consents.grant(PRINCIPAL, SMART, 'calendar');
        const card = await handleInbound(say('מה יש לי מחר ומה התזכורות?'), deps({ gemini: gemini([READ_TOMORROW, { tool: 'reminders.list', args: {} }]) }));
        const g = gemini([{ text: 'הנה' }]);
        reply(await handleInbound(tap(onceButton(card)), deps({ gemini: g })));
        expect(g.calls).toHaveLength(1);
        expect(seenByModel(g)).toContain(SECRET);
      });

      it('s3: a source approved "this time" stays allowed for the whole turn, across the phone read it led to', async () => {
        const card = await handleInbound(say('מי התקשר אליי?'), deps({ gemini: gemini([{ tool: 'phone.calls', args: { missed: true } }]) }));
        const asked = await handleInbound(tap(onceButton(card)), deps({ gemini: gemini([]) }));
        const g = gemini([{ text: 'יוסי התקשר' }]);
        expect(await answerPhone(asked, g)).toMatchObject({ action: 'reply', text: 'יוסי התקשר' });
        expect(g.calls).toHaveLength(1);
      });

      it('s4: a phone read with calendar revoked meanwhile: the resume ends, no model call', async () => {
        consents.grant(PRINCIPAL, SMART, 'calendar');
        consents.grant(PRINCIPAL, SMART, 'calls');
        const asked = await handleInbound(
          say('מה יש לי מחר ומי התקשר?'),
          deps({ gemini: gemini([READ_TOMORROW, { tool: 'phone.calls', args: { missed: true } }]) }),
        );
        consents.revoke(PRINCIPAL, SMART, 'calendar');
        const g = gemini([{ text: `שוב ${SECRET}` }]);
        await answerPhone(asked, g);
        expect(g.calls).toHaveLength(0);
      });

      it('s5: a smart state stored before `historySources` ends; a local one resumes as before', async () => {
        consents.grant(PRINCIPAL, SMART, 'calls');
        const asked = await handleInbound(say('מי התקשר?'), deps({ gemini: gemini([{ tool: 'phone.calls', args: { missed: true } }]) }));
        if (asked.action !== 'device_query') throw new Error('expected device_query');
        const begun = turns.begin(asked.queryId, PRINCIPAL);
        if (begun.kind !== 'run') throw new Error('expected run');
        const state = await turns.open(asked.queryId, PRINCIPAL, begun.ciphertext);
        expect(state?.historySources).toEqual([]);
        turns.finish(asked.queryId);
        const { historySources: _gone, ...legacy } = state!;
        const old = await turns.suspend(PRINCIPAL, begun.wamid, legacy);
        const g = gemini([{ text: 'יוסי' }]);
        await answerPhone({ action: 'device_query', queryId: old, query: legacy.query! }, g);
        expect(g.calls).toHaveLength(0);

        const localAsked = await handleInbound(say('מי התקשר?', LOCAL), deps({ qwen: qwen([{ tool: 'phone.calls', args: { missed: true } }]) }));
        if (localAsked.action !== 'device_query') throw new Error('expected device_query');
        const localBegun = turns.begin(localAsked.queryId, PRINCIPAL);
        if (localBegun.kind !== 'run') throw new Error('expected run');
        expect((await turns.open(localAsked.queryId, PRINCIPAL, localBegun.ciphertext))?.historySources).toBeUndefined();
        const q = qwen([{ text: 'יוסי התקשר' }]);
        const done = await resumeFromPhone(
          { queryId: localAsked.queryId, wamid: localBegun.wamid, ciphertext: localBegun.ciphertext, result: CALLS, sentAtMs: NOW - 1_000 },
          deps({ qwen: q }),
        );
        expect(done).toMatchObject({ action: 'reply', text: 'יוסי התקשר' });
        expect(q.calls).toHaveLength(1);
      });

      it('s6: a source only in the replayed history, revoked meanwhile, also ends the resume', async () => {
        await readCalendar();
        consents.grant(PRINCIPAL, SMART, 'calls');
        const asked = await handleInbound(say('ומי התקשר?'), deps({ gemini: gemini([{ tool: 'phone.calls', args: { missed: true } }]) }));
        consents.revoke(PRINCIPAL, SMART, 'calendar');
        const g = gemini([{ text: `שוב ${SECRET}` }]);
        await answerPhone(asked, g);
        expect(g.calls).toHaveLength(0);
      });
    });

    it('"this time" is not kept (D1): the next turn sees the placeholder and inherits no source', async () => {
      const card = await handleInbound(say('מה יש לי מחר?'), deps({ gemini: gemini([READ_TOMORROW]) }));
      const tapEvent = {
        kind: 'button',
        wamid: `app:in:prov.${++seq}`,
        from: '972500000000',
        sentAtMs: NOW - 500,
        buttonId: onceButton(card),
        forwarded: false,
        conversationId: SMART,
      } as InboundEvent;
      reply(await handleInbound(tapEvent, deps({ gemini: gemini([{ text: `מחר: ${SECRET}` }]) })));
      // Shown and kept for its own turn, tagged with its source.
      expect((await kept()).at(-1)).toMatchObject({ reply: `מחר: ${SECRET}`, src: ['calendar'] });

      const next = gemini([{ text: 'בסדר' }]);
      await handleInbound(say('תודה'), deps({ gemini: next }));
      expect(seenByModel(next)).not.toContain(SECRET);
      expect(seenByModel(next)).toContain(he.withheldPlaceholder);
      expect((await kept()).at(-1)?.src).toEqual([]);
    });
  });
});

/**
 * The consent gate (smart conversations, slice 5, 2026-10-08).
 *
 * In a smart conversation a model that calls a tool of a source the user has
 * not allowed does not run it: the turn waits, encrypted, and the user gets a
 * card. A tap is handled in code only — taken once, atomically, with its nonce
 * — and then the stored call runs through the normal path, or the model is
 * told the user declined. The history keeps a reply only when its sources were
 * allowed. Local conversations are untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound, resumeFromPhone } from '../../../src/core/pipeline.js';
import type { PipelineDeps, PipelineOutcome, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { ExpenseStore } from '../../../src/tools/expense-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { SuspendedTurns, SUSPEND_TTL_MS } from '../../../src/agent/turns.js';
import type { SuspendedState } from '../../../src/agent/loop.js';
import { ConversationConsents, consentButtonId, parseConsentButton } from '../../../src/agent/consents.js';
import { GPT_OSS_120B, QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { toWireName } from '../../../src/agent/tools.js';
import { dataSourceOf, TOOL_NAMES } from '../../../src/tools/registry.js';
import { consentText } from '../../../src/render/consent.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import type { GmailClient } from '../../../src/google/gmail.js';
import type { VoiceOutcome } from '../../../src/voice/transcribe.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_consent';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
const GEMINI = SMART_MODELS[0]!.id;
const SMART = '33333333-3333-4333-8333-333333333333';
const SMART_2 = '44444444-4444-4444-8444-444444444444';
const LOCAL = '55555555-5555-4555-8555-555555555555';
const ALL_CAPS = ['cards', 'file', 'device_query'];
/** A reminder whose words must reach a model only after consent. */
const SECRET = 'לקנות חלב לסבתא';

const PUBLIC_WIRE = new Set(TOOL_NAMES.filter((name) => dataSourceOf(name) === 'public').map(toWireName));
const PRIVATE_WIRE = new Set(TOOL_NAMES.filter((name) => dataSourceOf(name) === 'private').map(toWireName));

describe('the consent gate', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let expenses: ExpenseStore;
  let pending: PendingActions;
  let questions: OpenQuestions;
  let deferred: UndoActions;
  let history: ConversationHistory;
  let lock: AgentLock;
  let turns: SuspendedTurns;
  let consents: ConversationConsents;
  let budget: TokenBudget;
  let now: number;

  type Setup = { qwen?: FakeAgent; gemini?: FakeAgent | null; fallback?: FakeAgent; transcribe?: VoiceOutcome; gmail?: boolean };

  const deps = (setup: Setup = {}): PipelineDeps => {
    const services: Services = {
      reminders,
      expenses,
      pending,
      questions,
      deferred,
      nlu: [createFakeNlu([draft('unsupported')])],
      tokenBudget: budget,
      ...(setup.gmail ? { gmail: {} as GmailClient } : {}),
      agent: {
        providers: setup.qwen ? [setup.qwen] : [],
        ...(setup.fallback ? { fallbackProviders: [setup.fallback] } : {}),
        ...(setup.gemini === null ? {} : { smartProviders: [setup.gemini ?? gemini([])] }),
        budget,
        history,
        lock,
        turns,
        consents,
      },
    };
    return {
      repo,
      log: createFakeLogger(),
      now: () => now,
      principal: PRINCIPAL,
      services,
      channel: 'app',
      deviceCaps: ALL_CAPS,
      ...(setup.transcribe ? { transcribe: async () => setup.transcribe! } : {}),
    };
  };

  let seq = 0;
  const text = (body: string, conversation = SMART, options: { mode?: 'smart' | 'local'; forwarded?: boolean } = {}): InboundEvent =>
    ({
      kind: 'text',
      wamid: `app:in:consent.${++seq}`,
      from: '972500000000',
      sentAtMs: now - 1_000,
      text: body,
      forwarded: options.forwarded === true,
      conversationId: conversation,
      mode: options.mode ?? (conversation === LOCAL ? 'local' : 'smart'),
    }) as InboundEvent;
  const tap = (buttonId: string, conversation = SMART): InboundEvent => ({
    kind: 'button',
    wamid: `app:in:tap.${++seq}`,
    from: '972500000000',
    sentAtMs: now - 500,
    buttonId,
    forwarded: false,
    conversationId: conversation,
  });

  const qwen = (steps: FakeStep[]) => createFakeAgent(steps, QWEN, 500, 'primary');
  const gemini = (steps: FakeStep[]) => createFakeAgent(steps, GEMINI, 500, 'smart');
  const oss = (steps: FakeStep[]) => createFakeAgent(steps, GPT_OSS_120B, 500, 'backup');
  const offeredNames = (agent: FakeAgent, call = 0) => agent.tools[call]!.map((tool) => tool.function.name);

  type Card = Extract<PipelineOutcome, { action: 'reply' }> & { buttons: { id: string; title: string }[] };
  const asCard = (out: PipelineOutcome): Card => {
    if (out.action !== 'reply' || !out.buttons) throw new Error(`expected a card, got ${JSON.stringify(out)}`);
    return out as Card;
  };
  const button = (card: Card, verb: 'once' | 'conv' | 'no') => {
    const found = card.buttons.find((b) => {
      const parsed = parseConsentButton(b.id);
      return parsed?.kind === 'answer' && parsed.verb === verb;
    });
    if (!found) throw new Error(`no ${verb} button`);
    return found.id;
  };
  const verbs = (card: Card) =>
    card.buttons.map((b) => {
      const parsed = parseConsentButton(b.id);
      return parsed?.kind === 'answer' ? parsed.verb : null;
    });
  const answerOf = (card: Card) => {
    const parsed = parseConsentButton(card.buttons[0]!.id);
    if (parsed?.kind !== 'answer') throw new Error('not a consent card');
    return parsed;
  };
  const waiting = () => driver.exec(`SELECT kind, status FROM agent_turns WHERE status = 'waiting'`);

  /** A smart turn whose model calls `tool`: the card it gets. */
  const ask = async (tool: string, args: Record<string, unknown> = {}, conversation = SMART, setup: Setup = {}) => {
    const g = gemini([{ tool, args }]);
    const out = await handleInbound(text('מה התזכורות שלי?', conversation), deps({ ...setup, gemini: g }));
    return { card: asCard(out), g };
  };

  beforeEach(async () => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    now = NOW;
    reminders = new ReminderStore(driver, () => now);
    expenses = new ExpenseStore(driver, () => now);
    pending = new PendingActions(driver, () => now);
    questions = new OpenQuestions(driver, () => now);
    deferred = new UndoActions(driver, () => now);
    const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
    history = new ConversationHistory(driver, () => now, keyring);
    lock = new AgentLock(driver, () => now);
    turns = new SuspendedTurns(driver, () => now, keyring);
    consents = new ConversationConsents(driver, () => now);
    budget = new TokenBudget(() => now);
    reminders.schedule({ principal: PRINCIPAL, text: SECRET, dueAtUtc: NOW + 86_400_000, localWallTime: '2026-09-25T12:00', tz: 'Asia/Jerusalem' });
    // Each conversation's first message records its mode.
    for (const [conversation, mode] of [[SMART, 'smart'], [SMART_2, 'smart'], [LOCAL, 'local']] as const) {
      await handleInbound(text('/help', conversation, { mode }), deps());
    }
  });
  afterEach(() => driver.close());

  describe('asking', () => {
    it('suspends instead of running: a card names the source, nothing is read, nothing is kept', async () => {
      const { card, g } = await ask('reminders.list');
      expect(stripIsolates(card.text)).toBe(stripIsolates(consentText.card('reminders', 'he')));
      expect(verbs(card)).toEqual(['once', 'conv', 'no']);
      expect(card.buttons.map((b) => b.title)).toEqual([
        consentText.buttonOnce('he'),
        consentText.buttonConversation('he'),
        consentText.buttonNo('he'),
      ]);
      expect(g.calls).toHaveLength(1);
      expect(seenByModel(g)).not.toContain(SECRET);
      expect(card.text).not.toContain(SECRET);
      expect(waiting()).toEqual([{ kind: 'consent', status: 'waiting' }]);
      expect(await history.recent(PRINCIPAL, SMART)).toEqual([]);
      // The lock is free for the tap.
      expect(lock.isHeld(PRINCIPAL)).toBe(false);
    });

    it("offers a typed smart turn the tools of every consent source, never a private tool", async () => {
      const g = gemini([{ text: 'שלום' }]);
      await handleInbound(text('שלום'), deps({ gemini: g }));
      const offered = offeredNames(g);
      for (const name of ['calendar__list_events', 'reminders__list', 'phone__sms', 'phone__calls', 'expenses__add']) {
        expect(offered, name).toContain(name);
      }
      expect(offered.some((name) => PRIVATE_WIRE.has(name))).toBe(false);
      for (const name of PUBLIC_WIRE) expect(offered).toContain(name);
    });

    it('asks qwen in a smart conversation through the same gate', async () => {
      const q = qwen([{ tool: 'reminders.list', args: {} }]);
      const out = await handleInbound(text('מה התזכורות שלי?'), deps({ qwen: q, gemini: null }));
      const card = asCard(out);
      expect(stripIsolates(card.text)).toContain(stripIsolates(consentText.card('reminders', 'he')));
      expect(seenByModel(q)).not.toContain(SECRET);
    });

    it('offers mail, SMS, contacts and notifications for this time only', async () => {
      for (const [tool, args] of [
        ['phone.sms', {}],
        ['phone.contacts', {}],
        ['phone.notifications', {}],
        ['mail.search', {}],
      ] as const) {
        const { card } = await ask(tool, args, SMART, { gmail: true });
        expect(verbs(card), tool).toEqual(['once', 'no']);
      }
    });

    it('asks once per turn: the model cannot stack a second card', async () => {
      const { card } = await ask('reminders.list');
      // Not the API, but the stored state says the next suspend would be the second.
      const begun = turns.beginConsent(answerOf(card).queryId, PRINCIPAL, answerOf(card).nonce, false);
      if (begun.kind !== 'run') throw new Error('expected run');
      const state = (await turns.open(answerOf(card).queryId, PRINCIPAL, begun.ciphertext))!;
      expect(state).toMatchObject({ kind: 'consent', source: 'reminders', mode: 'smart', conversation: SMART });
      expect(state.suspends ?? 1).toBe(1);
    });
  });

  describe('answering', () => {
    it('"this time": runs the stored call through the normal path, back to the same model, and keeps no consent', async () => {
      const { card } = await ask('reminders.list');
      const g = gemini([{ text: 'יש תזכורת אחת למחר' }]);
      const out = await handleInbound(tap(button(card, 'once')), deps({ gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'יש תזכורת אחת למחר' });
      expect(g.calls).toHaveLength(1);
      expect(g.calls[0]!.at(-1)).toMatchObject({ role: 'tool' });
      expect(String(g.calls[0]!.at(-1)!.content)).toContain(SECRET);
      // The read happened: the audit has it, and the tool ran once.
      expect(driver.exec(`SELECT COUNT(*) AS n FROM audit_log WHERE tool = 'reminders.list'`)[0]?.['n']).toBe(1);
      expect(consents.list(PRINCIPAL, SMART)).toEqual([]);
      // Kept for this turn's entry: it was approved.
      expect((await history.recent(PRINCIPAL, SMART)).at(-1)).toMatchObject({ user: 'מה התזכורות שלי?', reply: 'יש תזכורת אחת למחר' });

      // The next turn asks again.
      const again = await ask('reminders.list');
      expect(verbs(again.card)).toEqual(['once', 'conv', 'no']);
    });

    it('"this conversation": kept for this conversation, and only this one', async () => {
      const { card } = await ask('reminders.list');
      await handleInbound(tap(button(card, 'conv')), deps({ gemini: gemini([{ text: 'יש תזכורת' }]) }));
      expect(consents.list(PRINCIPAL, SMART)).toEqual(['reminders']);

      const g = gemini([{ tool: 'reminders.list', args: {} }, { text: 'עדיין יש תזכורת' }]);
      const out = await handleInbound(text('ומה עכשיו?'), deps({ gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'עדיין יש תזכורת' });
      expect(seenByModel(g)).toContain(SECRET);
      expect(waiting()).toEqual([]);

      const other = await ask('reminders.list', {}, SMART_2);
      expect(verbs(other.card)).toEqual(['once', 'conv', 'no']);
      expect(consents.list(PRINCIPAL, SMART_2)).toEqual([]);
    });

    it('runs an approved card tool the turn was offered: the expenses export, which needs the file capability', async () => {
      expenses.add(PRINCIPAL, { amountAgorot: 1_250, category: 'other', description: null, spentOn: '2026-09-23' });
      const { card } = await ask('expenses.export');
      const out = await handleInbound(tap(button(card, 'once')), deps({ gemini: gemini([]) }));
      expect(out).toMatchObject({ action: 'reply', card: { type: 'file' } });
    });

    it('"no": runs nothing, the model is told and answers in text only', async () => {
      const { card } = await ask('reminders.list');
      const g = gemini([{ text: 'בסדר, בלי התזכורות' }]);
      const out = await handleInbound(tap(button(card, 'no')), deps({ gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'בסדר, בלי התזכורות' });
      expect(g.tools[0]).toEqual([]);
      const told = String(g.calls[0]!.at(-1)!.content);
      expect(told).toContain('user_declined_access');
      expect(told).toContain('reminders');
      expect(seenByModel(g)).not.toContain(SECRET);
      expect(driver.exec(`SELECT COUNT(*) AS n FROM audit_log WHERE tool = 'reminders.list'`)[0]?.['n']).toBe(0);
      expect(consents.list(PRINCIPAL, SMART)).toEqual([]);
    });

    it('"no", and the model fails: code says the access was not allowed', async () => {
      const { card } = await ask('reminders.list');
      const out = await handleInbound(tap(button(card, 'no')), deps({ gemini: gemini([{ error: 'timeout' }]) }));
      expect(out).toMatchObject({ action: 'reply', text: consentText.declined('reminders', 'he') });
    });

    it('refuses a forged "this conversation" for SMS, keeps nothing, and the real buttons still work', async () => {
      const { card } = await ask('phone.sms');
      const { queryId, nonce } = answerOf(card);
      const forged = await handleInbound(tap(consentButtonId(queryId, nonce, 'conv')), deps({ gemini: gemini([]) }));
      expect(forged).toEqual({ action: 'reply', text: consentText.expired('he') });
      expect(consents.list(PRINCIPAL, SMART)).toEqual([]);
      expect(waiting()).toEqual([{ kind: 'consent', status: 'waiting' }]);

      const out = await handleInbound(tap(button(card, 'once')), deps({ gemini: gemini([]) }));
      expect(out).toMatchObject({ action: 'device_query', query: { kind: 'sms', hours: 24 } });
    });

    it('refuses a wrong nonce without saying why', async () => {
      const { card } = await ask('reminders.list');
      const g = gemini([]);
      const out = await handleInbound(tap(consentButtonId(answerOf(card).queryId, 'f'.repeat(32), 'once')), deps({ gemini: g }));
      expect(out).toEqual({ action: 'reply', text: consentText.expired('he') });
      expect(g.calls).toHaveLength(0);
    });
  });

  describe('runs nothing twice, late or overtaken', () => {
    it('a double tap: the second is refused', async () => {
      const { card } = await ask('reminders.list');
      await handleInbound(tap(button(card, 'once')), deps({ gemini: gemini([{ text: 'יש' }]) }));
      const g = gemini([]);
      const second = await handleInbound(tap(button(card, 'once')), deps({ gemini: g }));
      expect(second).toEqual({ action: 'reply', text: consentText.expired('he') });
      expect(g.calls).toHaveLength(0);
      expect(driver.exec(`SELECT COUNT(*) AS n FROM audit_log WHERE tool = 'reminders.list'`)[0]?.['n']).toBe(1);
    });

    it('concurrent taps: one runs, the other is refused and grants nothing', async () => {
      const { card } = await ask('reminders.list');
      const first = gemini([{ text: 'יש' }]);
      const second = gemini([{ text: 'לא אמור לרוץ' }]);
      const [a, b] = await Promise.all([
        handleInbound(tap(button(card, 'once')), deps({ gemini: first })),
        handleInbound(tap(button(card, 'conv')), deps({ gemini: second })),
      ]);
      expect(a).toMatchObject({ action: 'reply', text: 'יש' });
      expect(b).toEqual({ action: 'reply', text: consentText.expired('he') });
      expect(second.calls).toHaveLength(0);
      expect(consents.list(PRINCIPAL, SMART)).toEqual([]);
    });

    it('an expired card runs nothing', async () => {
      const { card } = await ask('reminders.list');
      now = NOW + SUSPEND_TTL_MS + 1_000;
      const g = gemini([]);
      const out = await handleInbound(tap(button(card, 'conv')), deps({ gemini: g }));
      expect(out).toEqual({ action: 'reply', text: consentText.expired('he') });
      expect(g.calls).toHaveLength(0);
      expect(consents.list(PRINCIPAL, SMART)).toEqual([]);
    });

    it('a card a newer message overtook runs nothing', async () => {
      const { card } = await ask('reminders.list');
      await handleInbound(text('עזוב, מה השעה?'), deps({ gemini: gemini([{ text: 'צהריים' }]) }));
      const g = gemini([]);
      const out = await handleInbound(tap(button(card, 'once')), deps({ gemini: g }));
      expect(out).toEqual({ action: 'reply', text: consentText.expired('he') });
      expect(g.calls).toHaveLength(0);
    });

    it('a card whose lock another turn holds is cancelled, never interleaved, and grants nothing', async () => {
      const { card } = await ask('reminders.list');
      expect(lock.acquire(PRINCIPAL, 'app:in:other')).toBe(true);
      const g = gemini([]);
      const out = await handleInbound(tap(button(card, 'conv')), deps({ gemini: g }));
      expect(out).toEqual({ action: 'reply', text: consentText.expired('he') });
      expect(g.calls).toHaveLength(0);
      expect(consents.list(PRINCIPAL, SMART)).toEqual([]);
      expect(driver.exec('SELECT status FROM agent_turns')).toEqual([{ status: 'superseded' }]);
    });
  });

  describe('approve, then the phone', () => {
    it('suspends twice in one turn: the card, then the phone read it allowed', async () => {
      const { card } = await ask('phone.calls', { missed: true });
      expect(verbs(card)).toEqual(['once', 'conv', 'no']);
      const tapEvent = tap(button(card, 'once'));
      const asked = await handleInbound(tapEvent, deps({ gemini: gemini([]) }));
      if (asked.action !== 'device_query') throw new Error(`expected device_query, got ${asked.action}`);
      expect(asked.query).toMatchObject({ kind: 'calls', missed: true });
      // The phone's turn is the tap's: its answer goes under the tap.
      expect(turns.byWamid(tapEvent.wamid)).toMatchObject({ kind: 'phone', status: 'waiting' });

      const begun = turns.begin(asked.queryId, PRINCIPAL);
      if (begun.kind !== 'run') throw new Error('expected run');
      const g = gemini([{ text: 'יוסי התקשר' }]);
      const done = await resumeFromPhone(
        {
          queryId: asked.queryId,
          wamid: begun.wamid,
          ciphertext: begun.ciphertext,
          result: { status: 'ok', items: [{ name: 'יוסי', at: NOW - 60_000 }] },
          sentAtMs: NOW - 1_000,
        },
        deps({ gemini: g }),
      );
      expect(done).toMatchObject({ action: 'reply', text: 'יוסי התקשר' });
      // After the phone, words only.
      expect(g.tools[0]).toEqual([]);
      // Approved for this turn: kept.
      expect((await history.recent(PRINCIPAL, SMART)).at(-1)).toMatchObject({ reply: 'יוסי התקשר' });
    });

    it('refuses a third suspend: after the phone, a second phone read is an error, not a pause', async () => {
      const { card } = await ask('phone.calls', {});
      const asked = await handleInbound(tap(button(card, 'once')), deps({ gemini: gemini([]) }));
      if (asked.action !== 'device_query') throw new Error('expected device_query');
      const begun = turns.begin(asked.queryId, PRINCIPAL);
      if (begun.kind !== 'run') throw new Error('expected run');
      // The source allowed for this turn, read again: offered, and still no second pause.
      const g = gemini([{ tool: 'phone.calls', args: { missed: true } }, { text: 'זהו' }]);
      await resumeFromPhone(
        { queryId: asked.queryId, wamid: begun.wamid, ciphertext: begun.ciphertext, result: { status: 'ok', items: [] }, sentAtMs: NOW - 1_000 },
        deps({ gemini: g }),
      );
      expect(g.calls[1]!.at(-1)).toMatchObject({ role: 'tool', content: '{"error":"one_phone_read_per_turn"}' });
      expect(waiting()).toEqual([]);
    });
  });

  describe('never asks', () => {
    it('on a voice note: only public and granted tools, and an unoffered call is refused', async () => {
      consents.grant(PRINCIPAL, SMART, 'calendar');
      const g = gemini([{ tool: 'reminders.list', args: {} }, { text: 'אין לי גישה' }]);
      const voice: InboundEvent = {
        kind: 'audio',
        wamid: `app:in:voice.${++seq}`,
        from: '972500000000',
        sentAtMs: now - 1_000,
        mediaId: '',
        mimeType: 'audio/mp4',
        voiceNote: true,
        forwarded: false,
        conversationId: SMART,
        mode: 'smart',
      };
      const out = await handleInbound(
        voice,
        deps({ gemini: g, transcribe: { status: 'ok', text: 'מה התזכורות שלי', confidence: 'high', language: 'he' } }),
      );
      expect(out.action).toBe('reply');
      const offered = offeredNames(g);
      expect(offered).toContain('calendar__list_events');
      expect(offered).not.toContain('reminders__list');
      expect(offered.every((name) => PUBLIC_WIRE.has(name) || name.startsWith('calendar__') || name === 'reminders__leave' || name === 'nav__go')).toBe(true);
      expect(g.calls[1]!.at(-1)).toMatchObject({ role: 'tool', content: '{"error":"unknown_tool"}' });
      expect(driver.exec('SELECT COUNT(*) AS n FROM agent_turns')[0]?.['n']).toBe(0);
    });

    it('on shared text: local models, public and granted tools only', async () => {
      consents.grant(PRINCIPAL, SMART, 'reminders');
      const q = qwen([{ tool: 'calendar.list_events', args: {} }, { text: 'לא' }]);
      await handleInbound(text('תבדוק את זה', SMART, { forwarded: true }), deps({ qwen: q }));
      const offered = offeredNames(q);
      expect(offered).not.toContain('calendar__list_events');
      expect(q.calls[1]!.at(-1)).toMatchObject({ role: 'tool', content: '{"error":"unknown_tool"}' });
      expect(driver.exec('SELECT COUNT(*) AS n FROM agent_turns')[0]?.['n']).toBe(0);
    });

    it('on the read-only try: public and granted tools only', async () => {
      consents.grant(PRINCIPAL, SMART, 'reminders');
      const fb = oss([{ text: 'קריאה בלבד' }]);
      const out = await handleInbound(text('ספר לי משהו'), deps({ gemini: gemini([{ error: 'timeout' }]), fallback: fb }));
      expect(out).toMatchObject({ action: 'reply', text: 'קריאה בלבד' });
      const offered = offeredNames(fb);
      expect(offered).toContain('reminders__list');
      expect(offered).not.toContain('calendar__list_events');
      expect(offered.some((name) => name.startsWith('phone__'))).toBe(false);
    });
  });

  describe('the history', () => {
    const smsState = (once: boolean): SuspendedState => ({
      model: GEMINI,
      conversation: SMART,
      mode: 'smart',
      ...(once ? { once: ['sms' as const], suspends: 2 } : {}),
      messages: [
        { role: 'user', content: 'מה כתבו לי ב-SMS?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'phone__sms', arguments: '{}' } }] },
      ],
      spent: 500,
      calls: 1,
      tainted: false,
      text: 'מה כתבו לי ב-SMS?',
      lang: 'he',
      cards: true,
      toolCallId: 'call_1',
      tool: 'phone.sms',
      query: { kind: 'sms', hours: 24 },
    });

    const resume = async (state: SuspendedState, reply: string) => {
      const wamid = `app:in:resume.${++seq}`;
      const queryId = await turns.suspend(PRINCIPAL, wamid, state);
      const begun = turns.begin(queryId, PRINCIPAL);
      if (begun.kind !== 'run') throw new Error('expected run');
      return resumeFromPhone(
        { queryId, wamid, ciphertext: begun.ciphertext, result: { status: 'ok', items: [{ sender: 'בנק', text: 'הודעה', at: NOW }] }, sentAtMs: NOW - 1_000 },
        deps({ gemini: gemini([{ text: reply }]) }),
      );
    };

    it('withholds a reply whose source was not approved, and keeps one approved for that turn', async () => {
      await resume(smsState(false), 'הבנק כתב');
      expect((await history.recent(PRINCIPAL, SMART)).at(-1)).toMatchObject({ reply: he.withheldPlaceholder });
      await resume(smsState(true), 'הבנק כתב שוב');
      expect((await history.recent(PRINCIPAL, SMART)).at(-1)).toMatchObject({ reply: 'הבנק כתב שוב' });
    });

    it('keeps a reply after a source granted for the conversation, and touches the grant', async () => {
      consents.grant(PRINCIPAL, SMART, 'reminders');
      now = NOW + 60_000;
      await handleInbound(text('מה התזכורות?'), deps({ gemini: gemini([{ tool: 'reminders.list', args: {} }, { text: 'יש אחת' }]) }));
      expect((await history.recent(PRINCIPAL, SMART)).at(-1)).toMatchObject({ reply: 'יש אחת' });
      expect(driver.exec('SELECT last_used FROM conversation_consents')[0]?.['last_used']).toBe(NOW + 60_000);
    });

    it('a once-approval kept in one entry does not let the next turn read without asking', async () => {
      const { card } = await ask('reminders.list');
      await handleInbound(tap(button(card, 'once')), deps({ gemini: gemini([{ text: 'יש' }]) }));
      const again = await ask('reminders.list');
      expect(again.card.buttons.length).toBe(3);
    });
  });

  describe('/consents', () => {
    it('lists what this conversation allowed, each with a button that revokes it', async () => {
      consents.grant(PRINCIPAL, SMART, 'reminders');
      consents.grant(PRINCIPAL, SMART, 'calendar');
      consents.grant(PRINCIPAL, SMART_2, 'expenses');
      const g = gemini([]);
      const out = await handleInbound(text('/consents'), deps({ gemini: g }));
      if (out.action !== 'reply' || !out.buttons) throw new Error('expected buttons');
      expect(stripIsolates(out.text)).toBe(stripIsolates(consentText.list(['calendar', 'reminders'], 'he')));
      expect(out.buttons.map((b) => b.title)).toEqual([consentText.revokeButton('calendar', 'he'), consentText.revokeButton('reminders', 'he')]);
      expect(out.buttons.every((b) => parseConsentButton(b.id)?.kind === 'revoke')).toBe(true);
      expect(g.calls).toHaveLength(0);

      const revoked = await handleInbound(tap(out.buttons[1]!.id), deps());
      expect(revoked).toEqual({ action: 'reply', text: consentText.revoked('reminders', 'he') });
      expect(consents.list(PRINCIPAL, SMART)).toEqual(['calendar']);
      expect(consents.list(PRINCIPAL, SMART_2)).toEqual(['expenses']);

      // A revoke button works once.
      expect(await handleInbound(tap(out.buttons[1]!.id), deps())).toEqual({ action: 'reply', text: consentText.revokeExpired('he') });

      // Revoked: the next turn asks again.
      const again = await ask('reminders.list');
      expect(verbs(again.card)).toEqual(['once', 'conv', 'no']);
    });

    it('says when nothing is allowed', async () => {
      expect(await handleInbound(text('/consents'), deps())).toEqual({ action: 'reply', text: consentText.none('he') });
    });

    it('says consents exist only in smart conversations, in a local one and in the shared thread', async () => {
      expect(await handleInbound(text('/consents', LOCAL), deps())).toEqual({ action: 'reply', text: consentText.onlySmart('he') });
      const shared: InboundEvent = { kind: 'text', wamid: `app:in:${++seq}`, from: '972500000000', sentAtMs: now, text: '/consents', forwarded: false };
      expect(await handleInbound(shared, deps())).toEqual({ action: 'reply', text: consentText.onlySmart('he') });
    });

    it('refuses a forged revoke button', async () => {
      consents.grant(PRINCIPAL, SMART, 'reminders');
      const offer = deferred.offer({ tool: 'reminders.create', compensating: { id: 'x' }, principal: PRINCIPAL });
      const out = await handleInbound(tap(`cr:${offer.id}:${'f'.repeat(32)}:ok`), deps());
      expect(out).toEqual({ action: 'reply', text: consentText.revokeExpired('he') });
      expect(consents.list(PRINCIPAL, SMART)).toEqual(['reminders']);
    });
  });

  describe('a local conversation is unchanged', () => {
    it('runs a read straight away, with no card and no consent', async () => {
      const q = qwen([{ tool: 'reminders.list', args: {} }, { text: 'יש תזכורת' }]);
      const out = await handleInbound(text('מה התזכורות שלי?', LOCAL), deps({ qwen: q }));
      expect(out).toMatchObject({ action: 'reply', text: 'יש תזכורת' });
      expect(seenByModel(q)).toContain(SECRET);
      expect(driver.exec('SELECT COUNT(*) AS n FROM agent_turns')[0]?.['n']).toBe(0);
      expect((await history.recent(PRINCIPAL, LOCAL)).at(-1)).toMatchObject({ reply: 'יש תזכורת' });
    });

    it('refuses a consent button in a local conversation like any other stale tap', async () => {
      const out = await handleInbound(tap(consentButtonId('a'.repeat(32), 'b'.repeat(32), 'once'), LOCAL), deps());
      expect(out).toEqual({ action: 'reply', text: consentText.expired('he') });
    });
  });
});

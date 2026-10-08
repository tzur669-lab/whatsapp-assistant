/**
 * Smart conversations, slice 4: which model a turn runs on, and what it may see
 * (PLAN §6.19, 2026-10-08).
 *
 * The models are scripted; everything after them is the real pipeline. Pinned
 * here: a local conversation never reaches Gemini (the shared thread, a
 * conversation the server never recorded, shared text, a voice note, a missing
 * key, the read-only try); a smart one asks Gemini first and qwen when Gemini
 * has no room; without a consent store (these services have none) a smart
 * conversation is offered public tools only, on every model; and its history
 * keeps placeholders for anything that is not public and for someone else's
 * words. The consent gate itself (slice 5) is `consent-gate.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound, resumeFromPhone } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { SuspendedTurns } from '../../../src/agent/turns.js';
import { GPT_OSS_120B, QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { SMART_NOTE, SYSTEM_PROMPT } from '../../../src/agent/prompt.js';
import { agentToolNames, smartOfferedTools, toWireName } from '../../../src/agent/tools.js';
import { runAgentTurn } from '../../../src/agent/loop.js';
import type { SuspendedState } from '../../../src/agent/loop.js';
import { dataSourceOf, TOOL_NAMES } from '../../../src/tools/registry.js';
import type { ToolName } from '../../../src/tools/registry.js';
import { FactStore } from '../../../src/tools/fact-store.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import type { VoiceOutcome } from '../../../src/voice/transcribe.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import type { FakeNlu } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_smart';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const GEMINI = SMART_MODELS[0]!.id;
const SMART = 'conv-smart-0001';
const LOCAL = 'conv-local-0001';
const ALL_CAPS = ['cards', 'file', 'device_query'];

const PUBLIC_TOOLS = TOOL_NAMES.filter((name) => dataSourceOf(name) === 'public');
const PUBLIC_WIRE = new Set(PUBLIC_TOOLS.map(toWireName));

describe('smartOfferedTools', () => {
  it('keeps only the public tools of what was offered, in order', () => {
    const offered = agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } });
    const smart = smartOfferedTools(offered);
    expect(smart.length).toBeGreaterThan(0);
    expect(smart.every((name) => dataSourceOf(name) === 'public')).toBe(true);
    expect(smart).toEqual(offered.filter((name) => dataSourceOf(name) === 'public'));
    for (const name of ['calendar.list_events', 'reminders.create', 'notes.save', 'phone.sms', 'expenses.add'] as ToolName[]) {
      expect(smart).not.toContain(name);
    }
  });

  it('adds the granted sources, and every consent source when the turn may ask; never a private tool (slice 5)', () => {
    const offered = agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } });
    const granted = smartOfferedTools(offered, { granted: ['calendar'], ask: false });
    expect(granted).toContain('calendar.list_events');
    expect(granted).toContain('nav.go');
    expect(granted).not.toContain('reminders.list');
    expect(granted.every((name) => ['public', 'calendar'].includes(dataSourceOf(name)))).toBe(true);

    const asking = smartOfferedTools(offered, { granted: [], ask: true });
    expect(asking).toEqual(offered.filter((name) => dataSourceOf(name) !== 'private'));
    for (const name of ['notes.find', 'lists.show', 'portfolio.show', 'memory.remember'] as ToolName[]) {
      expect(asking).not.toContain(name);
    }
  });

  it('never adds a tool that was not offered', () => {
    const noCards = agentToolNames({ cards: false });
    const smart = smartOfferedTools(noCards);
    expect(smart.every((name) => noCards.includes(name))).toBe(true);
    expect(smart).not.toContain('alarm.set');
    expect(smart).toContain('calc.compute');
  });
});

describe('smart conversations', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let pending: PendingActions;
  let questions: OpenQuestions;
  let deferred: UndoActions;
  let history: ConversationHistory;
  let lock: AgentLock;
  let turns: SuspendedTurns;
  let facts: FactStore;
  let budget: TokenBudget;
  let nlu: FakeNlu;

  type Setup = {
    qwen?: FakeAgent;
    gemini?: FakeAgent | null;
    fallback?: FakeAgent;
    parser?: unknown[];
    transcribe?: VoiceOutcome;
  };

  const deps = (setup: Setup): PipelineDeps => {
    nlu = createFakeNlu(setup.parser ?? [draft('unsupported')]);
    const services: Services = {
      reminders,
      pending,
      questions,
      deferred,
      facts,
      nlu: [nlu],
      tokenBudget: budget,
      agent: {
        providers: setup.qwen ? [setup.qwen] : [],
        ...(setup.fallback ? { fallbackProviders: [setup.fallback] } : {}),
        ...(setup.gemini ? { smartProviders: [setup.gemini] } : {}),
        budget,
        history,
        lock,
        turns,
      },
    };
    return {
      repo,
      log: createFakeLogger(),
      now: () => NOW,
      principal: PRINCIPAL,
      services,
      channel: 'app',
      deviceCaps: ALL_CAPS,
      ...(setup.transcribe ? { transcribe: async () => setup.transcribe! } : {}),
    };
  };

  let seq = 0;
  const text = (
    body: string,
    options: { conversation?: string; mode?: 'smart' | 'local'; forwarded?: boolean } = {},
  ): InboundEvent =>
    ({
      kind: 'text',
      wamid: `app:in:smart.${++seq}`,
      from: '972500000000',
      sentAtMs: NOW - 1_000,
      text: body,
      forwarded: options.forwarded === true,
      ...(options.conversation !== undefined ? { conversationId: options.conversation } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
    }) as InboundEvent;
  const smartText = (body: string, forwarded = false) => text(body, { conversation: SMART, mode: 'smart', forwarded });

  const qwen = (steps: FakeStep[]) => createFakeAgent(steps, QWEN, 500, 'primary');
  const gemini = (steps: FakeStep[]) => createFakeAgent(steps, GEMINI, 500, 'smart');
  const oss = (steps: FakeStep[]) => createFakeAgent(steps, GPT_OSS_120B, 500, 'backup');
  const offeredNames = (agent: FakeAgent, call = 0) => agent.tools[call]!.map((tool) => tool.function.name);
  const systemOf = (agent: FakeAgent, call = 0) => agent.calls[call]![0]!.content ?? '';
  /** Fill Gemini's request minute, so it has no room for a turn. */
  const exhaustGemini = () => {
    for (let i = 0; i < (SMART_MODELS[0]!.minuteRequests ?? 0); i++) budget.reserve(GEMINI, 1);
  };

  beforeEach(async () => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    pending = new PendingActions(driver, () => NOW);
    questions = new OpenQuestions(driver, () => NOW);
    deferred = new UndoActions(driver, () => NOW);
    const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
    history = new ConversationHistory(driver, () => NOW, keyring);
    lock = new AgentLock(driver, () => NOW);
    turns = new SuspendedTurns(driver, () => NOW, keyring);
    facts = new FactStore(driver, () => NOW, keyring);
    budget = new TokenBudget(() => NOW);
    await facts.add(PRINCIPAL, 'אני צמחוני');
    // The local conversation is recorded as local by its first message.
    await handleInbound(text('/help', { conversation: LOCAL, mode: 'local' }), deps({}));
  });
  afterEach(() => driver.close());

  describe('a local turn never reaches Gemini', () => {
    it('in a local conversation', async () => {
      const g = gemini([]);
      const q = qwen([{ text: 'מקומי' }]);
      const out = await handleInbound(text('מה נשמע?', { conversation: LOCAL, mode: 'local' }), deps({ qwen: q, gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'מקומי' });
      expect(g.calls).toHaveLength(0);
      // Today's turn, unchanged: the facts and no smart note.
      expect(systemOf(q)).toBe(SYSTEM_PROMPT);
      expect(seenByModel(q)).toContain('אני צמחוני');
    });

    it('in the shared thread, even when the message declares smart', async () => {
      const g = gemini([]);
      const q = qwen([{ text: 'מקומי' }]);
      await handleInbound(text('מה נשמע?', { mode: 'smart' }), deps({ qwen: q, gemini: g }));
      expect(g.calls).toHaveLength(0);
      expect(q.calls).toHaveLength(1);
    });

    it('in a conversation the server never recorded a mode for', async () => {
      const g = gemini([]);
      const q = qwen([{ text: 'מקומי' }]);
      await handleInbound(text('מה נשמע?', { conversation: 'conv-unknown-01' }), deps({ qwen: q, gemini: g }));
      expect(g.calls).toHaveLength(0);
      expect(q.calls).toHaveLength(1);
    });

    it('for a voice note in a conversation the server never recorded', async () => {
      const g = gemini([]);
      const q = qwen([{ text: 'מקומי' }]);
      const voice: InboundEvent = {
        kind: 'audio',
        wamid: `app:in:voice.${++seq}`,
        from: '972500000000',
        sentAtMs: NOW - 1_000,
        mediaId: 'MEDIA-1',
        mimeType: 'audio/ogg',
        voiceNote: true,
        forwarded: false,
        conversationId: 'conv-unknown-02',
      };
      await handleInbound(voice, deps({ qwen: q, gemini: g, transcribe: { status: 'ok', text: 'מה נשמע', confidence: 'high', language: 'he' } }));
      expect(g.calls).toHaveLength(0);
      expect(q.calls).toHaveLength(1);
    });

    it('for text shared into a smart conversation: local models only, public tools only', async () => {
      // The conversation's first message records it smart.
      await handleInbound(smartText('שלום'), deps({ qwen: qwen([]), gemini: gemini([{ text: 'היי' }]) }));
      const q2 = qwen([{ text: 'סיכום' }]);
      const g2 = gemini([]);
      await handleInbound(smartText('תסכם לי את זה', true), deps({ qwen: q2, gemini: g2 }));
      expect(g2.calls).toHaveLength(0);
      expect(q2.calls).toHaveLength(1);
      expect(offeredNames(q2).every((name) => PUBLIC_WIRE.has(name))).toBe(true);
    });

    it('without a Gemini key: local models, and the reply says smart mode is off', async () => {
      const q = qwen([{ text: 'מקומי' }]);
      const out = await handleInbound(smartText('מה נשמע?'), deps({ qwen: q, gemini: null }));
      expect(out.action).toBe('reply');
      expect(out.action === 'reply' && out.text).toBe(`${he.smartUnavailable('he')}\n\nמקומי`);
      expect(q.calls).toHaveLength(1);
      // Still a smart conversation: public tools, no facts.
      expect(offeredNames(q).every((name) => PUBLIC_WIRE.has(name))).toBe(true);
      expect(seenByModel(q)).not.toContain('אני צמחוני');
    });

    it('on the read-only try, which runs on the fallback models only', async () => {
      const g = gemini([{ error: 'timeout' }]);
      const fb = oss([{ text: 'קריאה בלבד' }]);
      const out = await handleInbound(smartText('ספר לי משהו'), deps({ gemini: g, qwen: qwen([]), fallback: fb }));
      expect(out).toMatchObject({ action: 'reply', text: 'קריאה בלבד' });
      expect(g.calls).toHaveLength(1);
      expect(fb.calls).toHaveLength(1);
      expect(offeredNames(fb).every((name) => PUBLIC_WIRE.has(name))).toBe(true);
      expect(systemOf(fb)).not.toContain(SMART_NOTE);
    });

    it('in the loop itself: a smart model is dropped from a turn that is not smart', async () => {
      const g = gemini([]);
      const q = qwen([{ text: 'מקומי' }]);
      const result = await runAgentTurn(
        { text: 'שלום', lang: 'he', nowMs: NOW, turn: { principal: PRINCIPAL, nowMs: NOW } as never, history: [] },
        { providers: [g, q], budget, log: createFakeLogger() },
      );
      expect(result.kind).toBe('reply');
      expect(g.calls).toHaveLength(0);
      expect(q.calls).toHaveLength(1);
    });
  });

  describe('a smart turn', () => {
    it('asks Gemini first, with the whole public catalog, the smart note, and no facts', async () => {
      const g = gemini([{ text: 'חכם' }]);
      const q = qwen([]);
      const out = await handleInbound(smartText('מה יש לי ביומן מחר?'), deps({ qwen: q, gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'חכם' });
      expect(q.calls).toHaveLength(0);
      // No selection: every public tool the turn may have, nothing else.
      expect(new Set(offeredNames(g))).toEqual(PUBLIC_WIRE);
      expect(systemOf(g)).toBe(`${SYSTEM_PROMPT}\n${SMART_NOTE}`);
      expect(seenByModel(g)).not.toContain('אני צמחוני');
      expect(seenByModel(g)).not.toContain('About the user');
    });

    it("falls to qwen when Gemini has no room: today's path, narrowed to public tools", async () => {
      exhaustGemini();
      const g = gemini([]);
      const q = qwen([{ text: 'מקומי' }]);
      const out = await handleInbound(smartText('כמה זה 15 אחוז מ-80?'), deps({ qwen: q, gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'מקומי' });
      expect(g.calls).toHaveLength(0);
      expect(offeredNames(q).length).toBeGreaterThan(0);
      expect(offeredNames(q).every((name) => PUBLIC_WIRE.has(name))).toBe(true);
      expect(systemOf(q)).toBe(SYSTEM_PROMPT);
      expect(seenByModel(q)).not.toContain('אני צמחוני');
    });

    it('a Gemini 429 mid-turn goes to the parser, as today, and qwen is not asked for the turn', async () => {
      const g = gemini([{ error: 'rate_limited', retryAfterSeconds: 30 }]);
      const q = qwen([]);
      const out = await handleInbound(smartText('ספר לי משהו'), deps({ qwen: q, gemini: g }));
      expect(out.action).toBe('reply');
      expect(g.calls).toHaveLength(1);
      expect(q.calls).toHaveLength(0);
      expect(nlu.inputs).toHaveLength(1);
    });

    it('a Gemini 503 or 500 goes to the parser, and the next message runs on qwen while Gemini rests', async () => {
      for (const status of [503, 500]) {
        budget = new TokenBudget(() => NOW);
        const g = gemini([{ error: 'provider_error', status }]);
        const q = qwen([{ text: 'מקומי' }]);
        const first = await handleInbound(smartText('ספר לי משהו'), deps({ qwen: q, gemini: g }));
        expect(first.action).toBe('reply');
        expect(g.calls).toHaveLength(1);
        expect(q.calls).toHaveLength(0);
        expect(nlu.inputs).toHaveLength(1);
        // Blocked on the 429 ladder's first step (1 minute), not for the day.
        const blockedUntil = budget.snapshot([GEMINI])[0]?.blockedUntil;
        expect(blockedUntil).toBe(NOW + 60_000);

        const second = await handleInbound(smartText('ועוד משהו'), deps({ qwen: q, gemini: g }));
        expect(second).toMatchObject({ action: 'reply', text: 'מקומי' });
        expect(g.calls).toHaveLength(1);
      }
    });

    it('a Gemini 400 is still a plain failure: nothing is blocked', async () => {
      const g = gemini([{ error: 'provider_error', status: 400 }, { text: 'שוב חכם' }]);
      await handleInbound(smartText('ספר לי משהו'), deps({ qwen: qwen([]), gemini: g }));
      expect(budget.snapshot([GEMINI])[0]?.blockedUntil).toBeNull();
      const out = await handleInbound(smartText('ועוד משהו'), deps({ qwen: qwen([]), gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'שוב חכם' });
    });

    it("a Groq 503 blocks nothing, as today", async () => {
      const q = qwen([{ error: 'provider_error', status: 503 }]);
      const out = await handleInbound(text('ספר לי משהו', { conversation: LOCAL, mode: 'local' }), deps({ qwen: q }));
      expect(out.action).toBe('reply');
      expect(q.calls).toHaveLength(1);
      // Charged as an unanswered call, exactly as before: no block, no ladder.
      expect(budget.snapshot([QWEN])[0]?.blockedUntil).toBeNull();
      expect(budget.fits(QWEN, 100)).toBe(true);
    });

    it("sends a call's thought signature back with its result (Gemini 3)", async () => {
      const g = gemini([{ tool: 'calc.compute', args: { expression: '2+2' }, signature: 'c2lnLW9uZQ==' }, { text: 'התשובה 4' }]);
      await handleInbound(smartText('כמה זה 2+2?'), deps({ qwen: qwen([]), gemini: g }));
      expect(g.calls[1]!.at(-2)).toEqual({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'calc__compute', arguments: '{"expression":"2+2"}' },
            extra_content: { google: { thought_signature: 'c2lnLW9uZQ==' } },
          },
        ],
      });
    });

    it('refuses a tool that was not offered, on Gemini too', async () => {
      const g = gemini([{ tool: 'calendar.list_events', args: { date: { kind: 'relative_days', offset: 0 } } }, { text: 'לא יכול' }]);
      const out = await handleInbound(smartText('מה יש לי היום?'), deps({ qwen: qwen([]), gemini: g }));
      expect(out).toMatchObject({ action: 'reply', text: 'לא יכול' });
      expect(g.calls[1]!.at(-1)).toMatchObject({ role: 'tool', content: '{"error":"unknown_tool"}' });
    });

    it('keeps a public read in the history in full', async () => {
      const g = gemini([{ tool: 'calc.compute', args: { expression: '2+2' } }, { text: 'התשובה 4' }]);
      await handleInbound(smartText('כמה זה 2+2?'), deps({ qwen: qwen([]), gemini: g }));
      const kept = await history.recent(PRINCIPAL, SMART);
      expect(kept.at(-1)).toMatchObject({ user: 'כמה זה 2+2?', reply: 'התשובה 4' });
    });

    it("keeps placeholders for both sides of someone else's words", async () => {
      await handleInbound(smartText('שלום'), deps({ qwen: qwen([]), gemini: gemini([{ text: 'היי' }]) }));
      await handleInbound(smartText('הנה הודעה ששותפה: מפגש בשמונה', true), deps({ qwen: qwen([{ text: 'מפגש בשמונה' }]), gemini: gemini([]) }));
      const kept = await history.recent(PRINCIPAL, SMART);
      expect(kept.at(-1)).toMatchObject({ user: he.sharedPlaceholder, reply: he.sharedPlaceholder });
      // The next Gemini turn sees neither the shared words nor what was said about them.
      const g = gemini([{ text: 'בסדר' }]);
      await handleInbound(smartText('ומה עכשיו?'), deps({ qwen: qwen([]), gemini: g }));
      expect(seenByModel(g)).not.toContain('מפגש בשמונה');
    });

    it('a local conversation keeps shared words as today', async () => {
      await handleInbound(
        text('הנה הודעה ששותפה: מפגש בשמונה', { conversation: LOCAL, mode: 'local', forwarded: true }),
        deps({ qwen: qwen([{ text: 'מפגש בשמונה' }]) }),
      );
      const kept = await history.recent(PRINCIPAL, LOCAL);
      expect(kept.at(-1)).toMatchObject({ user: 'הנה הודעה ששותפה: מפגש בשמונה', reply: 'מפגש בשמונה', tainted: true });
    });
  });

  describe('resuming after the phone (mode-aware)', () => {
    const stateFor = (mode: 'smart' | 'local' | undefined, model: string): SuspendedState => ({
      model,
      conversation: SMART,
      ...(mode ? { mode } : {}),
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

    const resume = async (state: SuspendedState, setup: Setup) => {
      const wamid = `app:in:resume.${++seq}`;
      const queryId = await turns.suspend(PRINCIPAL, wamid, state);
      const begun = turns.begin(queryId, PRINCIPAL);
      if (begun.kind !== 'run') throw new Error('expected run');
      return resumeFromPhone(
        {
          queryId,
          wamid,
          ciphertext: begun.ciphertext,
          result: { status: 'ok', items: [{ sender: 'בנק', text: 'קוד 1234', at: NOW - 60_000 }] },
          sentAtMs: NOW - 1_000,
        },
        deps(setup),
      );
    };

    it('finds the Gemini provider and rebuilds the smart prompt', async () => {
      const g = gemini([{ text: 'יש הודעה מהבנק' }]);
      const out = await resume(stateFor('smart', GEMINI), { qwen: qwen([]), gemini: g });
      expect(out).toMatchObject({ action: 'reply', text: 'יש הודעה מהבנק' });
      expect(g.calls).toHaveLength(1);
      expect(systemOf(g)).toBe(`${SYSTEM_PROMPT}\n${SMART_NOTE}`);
      // Not public, so its reply is a placeholder in the smart history.
      const kept = await history.recent(PRINCIPAL, SMART);
      expect(kept.at(-1)).toMatchObject({ user: 'מה כתבו לי ב-SMS?', reply: he.withheldPlaceholder });
    });

    it('resumes qwen in a smart conversation with the plain prompt', async () => {
      const q = qwen([{ text: 'יש הודעה' }]);
      await resume(stateFor('smart', QWEN), { qwen: q, gemini: gemini([]) });
      expect(systemOf(q)).toBe(SYSTEM_PROMPT);
    });

    it('never offers Gemini to a turn stored without a mode (local)', async () => {
      const g = gemini([]);
      const out = await resume(stateFor(undefined, GEMINI), { qwen: qwen([]), gemini: g });
      expect(g.calls).toHaveLength(0);
      expect(out.action).toBe('reply');
    });
  });
});

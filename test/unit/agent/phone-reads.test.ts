/**
 * Phone reads through the pipeline (PLAN §6.21): a turn that suspends for the
 * phone, and the same turn picked up again when the phone answers.
 *
 * The model is scripted; everything else is the real code — the offer rules,
 * policy, the encrypted suspended turn, the lock, the scrubbing of what the
 * phone sent, the taint it carries, and the history.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound, resumeFromPhone } from '../../../src/core/pipeline.js';
import type { PipelineDeps, PipelineOutcome, Services } from '../../../src/core/pipeline.js';
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
import type { PhoneReadResult } from '../../../src/tools/phone-reads.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { he } from '../../../src/render/he.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import type { FakeNlu } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_phone_reads';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));
const ALL_CAPS = ['cards', 'device_query'];

const plain = (text: string) => stripIsolates(text);

const SMS: PhoneReadResult = {
  status: 'ok',
  items: [
    { sender: 'אמא', text: 'תתקשר אליי כשאתה מתפנה, המספר החדש 0501234567', at: NOW - 3_600_000 },
    { sender: 'הבנק', text: 'קוד האימות שלך הוא 482913', at: NOW - 600_000 },
  ],
};

describe('phone reads', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let pending: PendingActions;
  let history: ConversationHistory;
  let lock: AgentLock;
  let turns: SuspendedTurns;
  let budget: TokenBudget;
  let log: ReturnType<typeof createFakeLogger>;
  let nlu: FakeNlu;
  let agent: FakeAgent;
  let services: () => Services;

  const deps = (steps: FakeStep[], overrides: Partial<PipelineDeps> = {}): PipelineDeps => {
    agent = createFakeAgent(steps);
    nlu = createFakeNlu([draft('unsupported')]);
    return {
      repo,
      log,
      now: () => NOW,
      principal: PRINCIPAL,
      services: { ...services(), nlu: [nlu], agent: { providers: [agent], budget, history, lock, turns } },
      channel: 'app',
      deviceCaps: ALL_CAPS,
      ...overrides,
    };
  };

  let seq = 0;
  const text = (body: string): Extract<InboundEvent, { kind: 'text' }> => ({
    kind: 'text',
    wamid: `app:in:${++seq}`,
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    text: body,
    forwarded: false,
  });

  /** What the Durable Object does with the phone's answer: take the turn, then resume it. */
  const answer = async (
    queryId: string,
    result: PhoneReadResult,
    steps: FakeStep[],
  ): Promise<PipelineOutcome> => {
    const begun = turns.begin(queryId, PRINCIPAL);
    if (begun.kind !== 'run') throw new Error(`expected run, got ${begun.kind}`);
    return resumeFromPhone(
      { queryId, wamid: begun.wamid, ciphertext: begun.ciphertext, result, sentAtMs: NOW - 1_000 },
      deps(steps),
    );
  };

  const suspendOn = async (steps: FakeStep[], body = 'מה כתבו לי ב-SMS היום?') => {
    const message = text(body);
    const out = await handleInbound(message, deps(steps));
    if (out.action !== 'device_query') throw new Error(`expected device_query, got ${out.action}`);
    return { out, message };
  };

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const reminders = new ReminderStore(driver, () => NOW);
    pending = new PendingActions(driver, () => NOW);
    const questions = new OpenQuestions(driver, () => NOW);
    const deferred = new UndoActions(driver, () => NOW);
    const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
    history = new ConversationHistory(driver, () => NOW, keyring);
    lock = new AgentLock(driver, () => NOW);
    turns = new SuspendedTurns(driver, () => NOW, keyring);
    budget = new TokenBudget(() => NOW);
    log = createFakeLogger();
    services = () => ({ reminders, pending, questions, deferred, nlu: [] });
  });
  afterEach(() => driver.close());

  describe('suspending', () => {
    it('hands the phone a closed query, records the message as waiting, and frees the lock', async () => {
      const { out, message } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      expect(out).toEqual({ action: 'device_query', queryId: expect.stringMatching(/^[0-9a-f]{32}$/), query: { kind: 'sms', hours: 24 } });
      expect(repo.getInbound(message.wamid)?.['decision']).toBe('DEVICE_QUERY');
      expect(lock.acquire(PRINCIPAL, 'someone-else')).toBe(true);
    });

    it('asks in code for whom to look up, rather than reading every contact', async () => {
      const out = await handleInbound(text('יש לי מישהו באנשי הקשר?'), deps([{ tool: 'phone.contacts', args: {} }]));
      expect(out).toMatchObject({ action: 'reply', text: 'את מי לחפש באנשי הקשר?' });
    });

    it('offers phone reads only to an app that answers them, on typed words', async () => {
      const offered = (names: string[]) => names.filter((name) => name.startsWith('phone__'));

      await handleInbound(text('שלום'), deps([{ text: 'היי' }]));
      expect(offered(agent.tools[0]!.map((tool) => tool.function.name))).toEqual([
        'phone__contacts',
        'phone__notifications',
        'phone__sms',
        'phone__calls',
      ]);

      await handleInbound(text('שלום'), deps([{ text: 'היי' }], { deviceCaps: ['cards'] }));
      expect(offered(agent.tools[0]!.map((tool) => tool.function.name))).toEqual([]);

      await handleInbound(text('שלום'), deps([{ text: 'היי' }], { channel: 'whatsapp' }));
      expect(offered(agent.tools[0]!.map((tool) => tool.function.name))).toEqual([]);
    });

    it('never offers them on a voice note, so a transcript is never stored in a waiting turn', async () => {
      const voice: InboundEvent = {
        kind: 'audio',
        wamid: 'app:in:voice',
        from: '972500000000',
        sentAtMs: NOW - 1_000,
        mediaId: '',
        mimeType: 'audio/mp4',
        voiceNote: true,
        forwarded: false,
      };
      const out = await handleInbound(voice, {
        ...deps([{ tool: 'phone.sms', args: {} }, { text: 'אין לי גישה לזה בהודעה קולית' }]),
        transcribe: async () => ({ status: 'ok', text: 'מה כתבו לי ב-SMS', confidence: 'high', language: 'he' }) as const,
      });
      expect(agent.tools[0]!.some((tool) => tool.function.name.startsWith('phone__'))).toBe(false);
      expect(out.action).toBe('reply');
      expect(driver.exec('SELECT COUNT(*) AS n FROM agent_turns')[0]?.['n']).toBe(0);
    });

    it('stores the waiting turn encrypted: the user\'s words are not in the row', async () => {
      await suspendOn([{ tool: 'phone.sms', args: {} }], 'מה כתבה לי אמא');
      const row = driver.exec('SELECT ciphertext FROM agent_turns')[0];
      expect(String(row?.['ciphertext'])).not.toContain('אמא');
    });
  });

  describe('resuming', () => {
    it('gives the model a scrubbed copy, answers in its words, and marks the answer private', async () => {
      const { out, message } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      const done = await answer(out.queryId, SMS, [{ text: 'אמא ביקשה שתתקשר אליה.' }]);

      expect(done).toEqual({ action: 'reply', text: 'אמא ביקשה שתתקשר אליה.', private: true });
      const seen = seenByModel(agent);
      expect(seen).toContain('אמא');
      expect(seen).not.toContain('0501234567');
      expect(seen).not.toContain('482913');
      expect(repo.getInbound(message.wamid)?.['decision']).toBe('ALLOW');
    });

    it('continues the conversation the model was having, on the same model, with the calls already spent', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      await answer(out.queryId, SMS, [{ text: 'בסדר' }]);
      const messages = agent.calls[0]!;
      expect(messages[0]?.role).toBe('system');
      expect(messages.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ function: { name: 'phone__sms' } }] });
      expect(messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    });

    it('remembers the exchange as tainted, so the next turn is tainted too', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      await answer(out.queryId, SMS, [{ text: 'אמא ביקשה שתתקשר.' }]);
      const remembered = await history.recent(PRINCIPAL);
      expect(remembered).toEqual([{ user: 'מה כתבו לי ב-SMS היום?', reply: 'אמא ביקשה שתתקשר.', tainted: true }]);
    });

    it('puts a write the SMS led to behind a confirmation, and runs nothing', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }], 'תזכיר לי מה שאמא ביקשה ב-SMS');
      const done = await answer(out.queryId, SMS, [
        {
          tool: 'reminders.create',
          args: {
            text: 'להתקשר לאמא',
            date: { kind: 'relative_days', offset: 1 },
            time: { hour: 9, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
          },
        },
      ]);
      if (done.action !== 'reply') throw new Error('expected reply');
      expect(done.buttons?.length).toBeGreaterThan(0);
      expect(driver.exec('SELECT COUNT(*) AS n FROM reminders')[0]?.['n']).toBe(0);
      expect(driver.exec(`SELECT COUNT(*) AS n FROM pending_actions WHERE status = 'pending'`)[0]?.['n']).toBe(1);
    });

    it('answers with the list itself when the model fails after the read', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      const done = await answer(out.queryId, SMS, [{ error: 'timeout' }]);
      if (done.action !== 'reply') throw new Error('expected reply');
      expect(plain(done.text)).toContain('הודעות SMS:');
      expect(plain(done.text)).toContain('אמא: תתקשר אליי');
      expect(done.private).toBe(true);
      // Nothing falls back to the parser once the phone has answered.
      expect(nlu.inputs).toHaveLength(0);
    });

    it('says in code that the permission is off, without asking the model', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      const done = await answer(out.queryId, { status: 'denied', items: [] }, []);
      expect(done).toMatchObject({ action: 'reply' });
      if (done.action !== 'reply') return;
      expect(done.text).toContain('אין הרשאה לקרוא SMS');
      expect(agent.calls).toHaveLength(0);
    });

    it('allows one phone read per turn', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      await answer(out.queryId, SMS, [{ tool: 'phone.notifications', args: {} }, { text: 'זה מה שיש' }]);
      expect(agent.calls[1]!.at(-1)).toMatchObject({ role: 'tool', content: '{"error":"one_phone_read_per_turn"}' });
      expect(driver.exec(`SELECT COUNT(*) AS n FROM agent_turns WHERE status = 'waiting'`)[0]?.['n']).toBe(0);
    });

    it('cleans what the phone sent before anyone reads it: no controls, no direction overrides', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      const spoofed: PhoneReadResult = { status: 'ok', items: [{ sender: 'X\u202e', text: 'שורה\u0007\nשנייה\u2066', at: NOW }] };
      const done = await answer(out.queryId, spoofed, [{ error: 'timeout' }]);
      if (done.action !== 'reply') throw new Error('expected reply');
      expect(done.text).not.toContain('\u0007');
      expect(done.text).not.toContain('\u202e');
      expect(done.text).toContain('שורה שנייה');
    });
  });

  describe('a newer message, and the lock', () => {
    it('supersedes a waiting turn: the phone\'s late answer cannot continue it', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      await handleInbound(text('עזוב, מה השעה?'), deps([{ text: 'שתים עשרה' }]));
      expect(turns.begin(out.queryId, PRINCIPAL)).toMatchObject({ kind: 'settled', status: 'superseded' });
    });

    it('cancels, never interleaves, when another turn holds the lock at resume', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      expect(lock.acquire(PRINCIPAL, 'app:in:other')).toBe(true);
      const done = await answer(out.queryId, SMS, [{ text: 'לא אמור לרוץ' }]);
      expect(done).toEqual({ action: 'reply', text: he.phoneReadCancelled });
      expect(agent.calls).toHaveLength(0);
    });

    it('releases the lock after resuming', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      await answer(out.queryId, SMS, [{ text: 'בסדר' }]);
      expect(lock.acquire(PRINCIPAL, 'app:in:next')).toBe(true);
    });

    it('forgets a waiting turn on /forget', async () => {
      const { out } = await suspendOn([{ tool: 'phone.sms', args: {} }]);
      await handleInbound(text('/forget'), deps([]));
      expect(turns.begin(out.queryId, PRINCIPAL)).toEqual({ kind: 'not_found' });
    });
  });
});

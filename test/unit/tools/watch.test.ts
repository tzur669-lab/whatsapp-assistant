/**
 * `reminders.when` (block J, J4, PLAN §6.30): offered only in the app for
 * "when … arrives"; its replies echo only its own call; Undo and `/watches`
 * cancel; the mail tick claims once per tick and only for new mail.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
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
import { ConversationConsents } from '../../../src/agent/consents.js';
import { QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { agentToolNames } from '../../../src/agent/tools.js';
import { namesWatch } from '../../../src/tools/watch.js';
import { checkMailWatches, MAIL_OVERLAP_MS, WatchStore } from '../../../src/tools/watch-store.js';
import type { MailIdLister } from '../../../src/tools/watch-store.js';
import { personalQuestion } from '../../../src/render/personal.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeAgent } from '../../integration/fake-agent.js';

/** Monday 2026-10-12, 12:00 local. */
const NOW = Date.parse('2026-10-12T09:00:00Z');
const PRINCIPAL = 'p_when';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(13)));
const ASK = 'כשיגיע מייל מ-DHL תזכיר לי לבדוק את המשלוח';
const CALL = { tool: 'reminders.when', args: { source: 'mail', keywords: ['DHL'], text: 'לבדוק את המשלוח' } };
const plain = (text: string) => stripIsolates(text);

describe('namesWatch', () => {
  for (const text of [ASK, 'כשתגיע הודעה מהבנק תזכיר לי', 'כשאקבל SMS עם המילה חבילה', 'when an email from DHL arrives remind me', 'remind me when I get a text from mom']) {
    it(`offers for "${text}"`, () => expect(namesWatch(text)).toBe(true));
  }
  for (const text of ['תזכיר לי מחר בשמונה', 'מתי מגיע המשלוח?', 'what is on my calendar when I land', 'מה כתוב במייל']) {
    it(`not for "${text}"`, () => expect(namesWatch(text)).toBe(false));
  }

  it('is never in the full catalog', () => {
    expect(agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } })).not.toContain(
      'reminders.when',
    );
  });
});

describe('reminders.when in a turn', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let watches: WatchStore;
  let history: ConversationHistory;
  let services: Omit<Services, 'nlu'>;
  let pushes: number;
  let seq = 0;

  const deps = (agent: FakeAgent, options: { channel?: 'app' | 'whatsapp'; smart?: FakeAgent } = {}): PipelineDeps => ({
    repo,
    log: createFakeLogger(),
    now: () => NOW,
    principal: PRINCIPAL,
    channel: options.channel ?? 'app',
    services: {
      ...services,
      nlu: [createFakeNlu([draft('unsupported')])],
      agent: { ...services.agent!, providers: [agent], ...(options.smart ? { smartProviders: [options.smart] } : {}) },
    },
  });
  const text = (body: string, options: { mode?: 'smart' | 'local' } = {}): InboundEvent =>
    ({
      kind: 'text',
      wamid: `app:in:when.${++seq}`,
      from: '972500000000',
      sentAtMs: NOW - 1_000,
      text: body,
      forwarded: false,
      conversationId: options.mode === 'smart' ? 'conv-smart-when' : 'conv-when',
      mode: options.mode ?? 'local',
    }) as InboundEvent;
  const tap = (buttonId: string): InboundEvent =>
    ({ kind: 'button', wamid: `app:in:tap.${++seq}`, from: '972500000000', sentAtMs: NOW - 500, buttonId, forwarded: false }) as InboundEvent;
  const offered = (agent: FakeAgent) => agent.tools[0]!.map((tool) => tool.function.name);
  const reply = (out: unknown) => {
    const outcome = out as { action: string; text: string; buttons?: { id: string; title: string }[] };
    if (outcome.action !== 'reply') throw new Error('expected a reply');
    return outcome;
  };

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    watches = new WatchStore(driver, () => NOW);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    pushes = 0;
    services = {
      reminders: new ReminderStore(driver, () => NOW),
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      watches,
      watchesChanged: async () => {
        pushes++;
      },
      agent: {
        providers: [],
        budget: new TokenBudget(() => NOW),
        history,
        lock: new AgentLock(driver, () => NOW),
        turns: new SuspendedTurns(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY })),
        consents: new ConversationConsents(driver, () => NOW),
      },
    };
  });
  afterEach(() => driver.close());

  it('creates a watch in the app, echoing only its own words, with an Undo', async () => {
    const agent = createFakeAgent([CALL], QWEN);
    const out = reply(await handleInbound(text(ASK), deps(agent)));
    expect(offered(agent)).toContain('reminders__when');
    expect(plain(out.text)).toContain('DHL');
    expect(plain(out.text)).toContain('לבדוק את המשלוח');
    expect(plain(out.text)).toContain('בתוקף עד');
    expect(watches.active(PRINCIPAL)).toHaveLength(1);
    expect(pushes).toBe(1);

    const undo = out.buttons!.find((button) => button.id.startsWith('undo:'))!;
    await handleInbound(tap(undo.id), deps(createFakeAgent([], QWEN)));
    expect(watches.active(PRINCIPAL)).toHaveLength(0);
    expect(pushes).toBe(2);
  });

  it('is never offered on WhatsApp', async () => {
    const agent = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text(ASK), deps(agent, { channel: 'whatsapp' }));
    expect(offered(agent)).not.toContain('reminders__when');
  });

  it('a missing source is a question, not a guess', async () => {
    const agent = createFakeAgent([{ tool: 'reminders.when', args: { keywords: ['DHL'], text: 'לבדוק' } }], QWEN);
    const out = reply(await handleInbound(text(ASK), deps(agent)));
    expect(out.text).toBe(personalQuestion('watch_source', 'he'));
    expect(watches.active(PRINCIPAL)).toHaveLength(0);
  });

  it('in a smart conversation Gemini gets no consent card, and nothing found is shown', async () => {
    // A secret in another watch's words: no reply may carry it.
    watches.create({ principal: PRINCIPAL, source: 'sms', said: ['סוד-1234'], text: 'סוד אחר', repeat: false, expiresAt: NOW + 1e9 });
    const gemini = createFakeAgent([CALL], SMART_MODELS[0]!.id, 500, 'smart');
    const out = reply(await handleInbound(text(ASK, { mode: 'smart' }), deps(createFakeAgent([], QWEN), { smart: gemini })));
    expect(gemini.calls).toHaveLength(1);
    // No consent card: a confirmation of its own words, as every smart write gets.
    expect(out.buttons?.map((button) => button.id.split(':')[0])).toEqual(['pa', 'pa']);
    expect(plain(out.text)).toContain('לבדוק את המשלוח');
    expect(out.text).not.toContain('סוד');
  });

  it('/watches lists them with cancel buttons that work once', async () => {
    watches.create({ principal: PRINCIPAL, source: 'notification', said: ['חבילה'], text: 'לאסוף', repeat: false, expiresAt: NOW + 1e9 });
    const out = reply(await handleInbound(text('/watches'), deps(createFakeAgent([], QWEN))));
    expect(plain(out.text)).toContain('חבילה');
    const cancel = out.buttons![0]!;
    expect(cancel.title).toBe('ביטול 1');
    await handleInbound(tap(cancel.id), deps(createFakeAgent([], QWEN)));
    expect(watches.active(PRINCIPAL)).toHaveLength(0);
    const again = reply(await handleInbound(tap(cancel.id), deps(createFakeAgent([], QWEN))));
    expect(again.text).not.toContain('בוטל');
  });
});

describe('the mail tick', () => {
  let driver: TestSqlDriver;
  let clock: number;
  let watches: WatchStore;
  let reminders: ReminderStore;
  let queries: string[];
  let inbox: string[];
  let failing: boolean;

  const gmail: MailIdLister = {
    async listIds(query) {
      queries.push(query);
      if (failing) return { ok: false, error: { code: 'rate_limited' } };
      return { ok: true, value: [...inbox] };
    },
  };
  const tick = () => checkMailWatches({ principal: 'p', watches, reminders, gmail, tickStart: clock });
  const scheduled = () => driver.exec("SELECT COUNT(*) AS n FROM reminders WHERE status = 'scheduled'")[0]?.['n'];

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    clock = NOW;
    watches = new WatchStore(driver, () => clock);
    reminders = new ReminderStore(driver, () => clock);
    queries = [];
    inbox = [];
    failing = false;
  });
  afterEach(() => driver.close());

  const watch = (repeat = false) =>
    watches.create({ principal: 'p', source: 'mail', said: ['DHL'], text: 'משלוח', repeat, expiresAt: clock + 30 * 86_400_000 });

  it('a new mail fires once; the same ids next tick do not', async () => {
    watch(true);
    inbox = ['m1', 'm2'];
    expect(await tick()).toBe(1);
    clock += 60 * 60 * 1000;
    expect(await tick()).toBe(0);
    expect(scheduled()).toBe(1);
  });

  it('a full page of 50 makes one claim', async () => {
    watch(true);
    inbox = Array.from({ length: 50 }, (_, i) => `m${i}`);
    expect(await tick()).toBe(1);
    expect(scheduled()).toBe(1);
  });

  it('a later tick looks back 15 minutes past the last check', async () => {
    watch();
    await tick();
    clock += 60 * 60 * 1000;
    await tick();
    // The first check was at NOW: the second looks back to NOW - 15 min, but never before creation (NOW).
    expect(queries[1]).toContain(`after:${Math.floor(Math.max(NOW, NOW - MAIL_OVERLAP_MS) / 1000)}`);
    clock += 60 * 60 * 1000;
    await tick();
    expect(queries[2]).toContain(`after:${Math.floor((NOW + 60 * 60 * 1000 - MAIL_OVERLAP_MS) / 1000)}`);
  });

  it('a failed list writes nothing, and the next tick looks back as far', async () => {
    watch();
    await tick();
    clock += 60 * 60 * 1000;
    failing = true;
    expect(await tick()).toBe(0);
    failing = false;
    clock += 60 * 60 * 1000;
    await tick();
    expect(queries[2]).toBe(queries[1]);
  });

  it('a watch cancelled during the list stays cancelled', async () => {
    const made = watch();
    if (!made.ok) throw new Error('full');
    inbox = ['m1'];
    const slow: MailIdLister = {
      async listIds() {
        watches.cancel('p', made.id);
        return { ok: true, value: ['m1'] };
      },
    };
    expect(await checkMailWatches({ principal: 'p', watches, reminders, gmail: slow, tickStart: clock })).toBe(0);
    expect(scheduled()).toBe(0);
    expect(driver.exec('SELECT status, last_checked FROM watches')[0]).toEqual({ status: 'cancelled', last_checked: null });
  });
});

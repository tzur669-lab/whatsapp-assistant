/**
 * The budget fitter and the calibrated estimator (ROADMAP block H part 17,
 * 2026-10-07).
 *
 * Before: at 2.5 characters a token, the full catalog alone estimated past the
 * 7,000 turn cap, so a message that named no tool group failed before any model
 * was asked. Now the estimate follows measured calls, and the oldest history
 * goes first when a turn would not fit; the last exchange always stays.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fitHistory, estimateTokens, FIT_HEADROOM, TURN_TOKEN_CAP } from '../../../src/agent/loop.js';
import type { HistoryEntry } from '../../../src/agent/history.js';
import { languageLine, nowLine, SYSTEM_PROMPT } from '../../../src/agent/prompt.js';
import { agentToolNames, wireTools } from '../../../src/agent/tools.js';
import { BRIEF_MAX, BRIEFS } from '../../../src/agent/briefs.js';
import { REGISTRY } from '../../../src/tools/registry.js';
import type { ToolName } from '../../../src/tools/registry.js';
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
import { FactStore, MAX_FACTS } from '../../../src/tools/fact-store.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import { createFakeAgent, seenByModel } from '../../integration/fake-agent.js';

const entry = (n: number, size = 10): HistoryEntry => ({ user: `שאלה ${n} ${'א'.repeat(size)}`, reply: `תשובה ${n}`, tainted: false });

describe('fitHistory', () => {
  const byLength = (history: readonly HistoryEntry[]) => history.reduce((sum, e) => sum + e.user.length, 0);

  it('keeps everything that fits', () => {
    const history = [entry(1), entry(2)];
    expect(fitHistory(history, byLength, 1_000)).toEqual({ history, dropped: 0 });
  });

  it('drops the oldest first', () => {
    const history = [entry(1, 100), entry(2, 100), entry(3, 100)];
    const fitted = fitHistory(history, byLength, 250);
    expect(fitted.dropped).toBe(1);
    expect(fitted.history.map((e) => e.reply)).toEqual(['תשובה 2', 'תשובה 3']);
  });

  it('never drops the last exchange, even when it alone is over', () => {
    const history = [entry(1, 500), entry(2, 500)];
    const fitted = fitHistory(history, byLength, 10);
    expect(fitted.history.map((e) => e.reply)).toEqual(['תשובה 2']);
  });

  it('leaves an empty history alone', () => {
    expect(fitHistory([], byLength, 0)).toEqual({ history: [], dropped: 0 });
  });
});

describe('the full catalog fits a turn now', () => {
  it('estimates a first call with every tool well under the turn cap', () => {
    const tools = agentToolNames({ cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } });
    const chars = JSON.stringify(wireTools(tools)).length;
    const first = estimateTokens(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${nowLine(Date.UTC(2026, 9, 7))}\n${languageLine('he')}\n\nמה נשמע` },
      ],
      chars,
    );
    // The hard line: call 0 with every tool, its completion reserve included,
    // fits the cap. (Above FIT_HEADROOM the fitter keeps only the last exchange.)
    expect(first + 400).toBeLessThanOrEqual(TURN_TOKEN_CAP);
    expect(first).toBeGreaterThan(TURN_TOKEN_CAP - 400 - FIT_HEADROOM - 1_500);
  });
});

describe('a turn with long history and every tool', () => {
  const NOW = Date.parse('2026-10-07T09:00:00Z');
  const PRINCIPAL = 'p_fit';
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)));
  let driver: TestSqlDriver;
  let repo: Repository;
  let history: ConversationHistory;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
  });
  afterEach(() => driver.close());

  it('answers a message that names no group, keeping the newest exchange', async () => {
    for (let i = 1; i <= 6; i++) {
      await history.append(PRINCIPAL, { user: `הודעה ${i} ${'ב'.repeat(160)}`, reply: `תשובה ${i} ${'ג'.repeat(160)}`, tainted: false });
    }
    const agent = createFakeAgent([{ text: 'הכול טוב' }]);
    const log = createFakeLogger();
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      gmail: {} as never,
      tasks: {} as never,
      drive: {} as never,
      agent: { providers: [agent], budget: new TokenBudget(() => NOW), history, lock: new AgentLock(driver, () => NOW) },
    };
    const deps: PipelineDeps = {
      repo,
      log,
      now: () => NOW,
      principal: PRINCIPAL,
      services,
      channel: 'app',
      deviceCaps: ['cards', 'file', 'device_query'],
    };
    const event = { kind: 'text', wamid: 'wamid.fit.1', from: '972500000000', sentAtMs: NOW - 1_000, text: 'מה נשמע', forwarded: false } as InboundEvent;

    const out = await handleInbound(event, deps);
    if (out.action !== 'reply') throw new Error('expected a reply');
    expect(stripIsolates(out.text)).toBe('הכול טוב');

    const seen = seenByModel(agent);
    const kept = (await history.recent(PRINCIPAL)).length;
    expect(seen).toContain('הודעה 6');
    expect(kept).toBeGreaterThan(1);
  });
});

describe('facts on a full turn (2026-10-14: 40 facts, 1,600 characters)', () => {
  const NOW = Date.parse('2026-10-14T09:00:00Z');
  const PRINCIPAL = 'p_fit_facts';
  const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
  const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
  let driver: TestSqlDriver;
  let repo: Repository;
  let history: ConversationHistory;
  let facts: FactStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    history = new ConversationHistory(driver, () => NOW, keyring);
    facts = new FactStore(driver, () => NOW, keyring);
  });
  afterEach(() => driver.close());

  // A last exchange that leaves no room for every fact, and room for the call.
  const TIGHT = 850;
  const turn = async (lastSide: number) => {
    // Forty facts of forty characters: the memory full, in the order told.
    for (let i = 0; i < MAX_FACTS; i++) {
      const fact = `עובדה ${String(i).padStart(2, '0')} ${'ד'.repeat(30)}`;
      expect((await facts.add(PRINCIPAL, fact)).kind).toBe('added');
    }
    await history.append(PRINCIPAL, { user: `אחרונה ${'ב'.repeat(lastSide)}`, reply: `תשובה ${'ג'.repeat(lastSide)}`, tainted: false });
    const agent = createFakeAgent([{ text: 'הכול טוב' }]);
    const services: Services = {
      reminders: new ReminderStore(driver, () => NOW),
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [createFakeNlu([draft('unsupported')])],
      facts,
      gmail: {} as never,
      tasks: {} as never,
      drive: {} as never,
      agent: { providers: [agent], budget: new TokenBudget(() => NOW), history, lock: new AgentLock(driver, () => NOW) },
    };
    const log = createFakeLogger();
    const deps: PipelineDeps = {
      repo,
      log,
      now: () => NOW,
      principal: PRINCIPAL,
      services,
      channel: 'app',
      deviceCaps: ['cards', 'file', 'device_query'],
    };
    const event = { kind: 'text', wamid: `wamid.fitf.${lastSide}`, from: '972500000000', sentAtMs: NOW - 1_000, text: 'מה נשמע', forwarded: false } as InboundEvent;
    const out = await handleInbound(event, deps);
    if (out.action !== 'reply') throw new Error('expected a reply');
    return seenByModel(agent);
  };

  it('a full memory fits a message that names no group', async () => {
    const seen = await turn(100);
    expect(seen).toContain('עובדה 00');
    expect(seen).toContain('עובדה 39');
  });

  it('when the turn is tight, the oldest facts go first and the newest stay', async () => {
    const seen = await turn(TIGHT);
    expect(seen).toContain('עובדה 39');
    expect(seen).not.toContain('עובדה 00');
  });
});

describe('the brief full catalog (block J, J2b)', () => {
  const FULL = { cards: true, fileCards: true, phoneReads: true, grants: { gmail: true, tasks: true, drive: true } };
  const firstCall = (brief: boolean) =>
    estimateTokens(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${nowLine(Date.UTC(2026, 9, 13))}\n${languageLine('he')}\n\nמה נשמע` },
      ],
      JSON.stringify(wireTools(agentToolNames(FULL), brief ? { brief: true } : {})).length,
    );

  it('keeps every brief within BRIEF_MAX and shorter than the description it replaces', () => {
    for (const [name, brief] of Object.entries(BRIEFS) as Array<[ToolName, string]>) {
      expect(brief.length, name).toBeLessThanOrEqual(BRIEF_MAX);
      expect(brief.length, name).toBeLessThan(REGISTRY[name].llmDescription.length);
    }
  });

  it('changes descriptions only: the same tools, slots and order', () => {
    const names = agentToolNames(FULL);
    const strip = (tools: ReturnType<typeof wireTools>) =>
      tools.map((tool) => ({ name: tool.function.name, parameters: tool.function.parameters }));
    expect(strip(wireTools(names, { brief: true }))).toEqual(strip(wireTools(names)));
  });

  it('frees room in the first call: measured, pinned so a growing catalog is seen', () => {
    const full = firstCall(false);
    const brief = firstCall(true);
    // 2026-10-13: 6,561 → 5,710 estimated tokens. The slot schemas, not the
    // descriptions, are most of the catalog, so briefs alone do not reach the
    // plan's 5,500 target; a follow-up's inherited groups (J2a) do the rest.
    expect(full - brief).toBeGreaterThanOrEqual(800);
    expect(brief).toBeLessThanOrEqual(5_750);
    expect(brief + 400).toBeLessThanOrEqual(TURN_TOKEN_CAP);
  });
});

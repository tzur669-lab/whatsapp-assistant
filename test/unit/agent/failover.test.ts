/**
 * Rate/budget failover, end to end through the pipeline (PLAN §6.19, 2026-10-06).
 *
 * The models are scripted; everything after them is the real code. What is
 * pinned here: a model that refused a message is never asked again for it, a
 * turn stays on its one model, a call after a read is text-only, and a backup
 * model's writes always confirm.
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
import { MINUTE_TOKEN_LIMIT, TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { GPT_OSS_120B, MODELS, QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import type { AgentProvider, AgentResponse } from '../../../src/agent/provider.js';
import { buildNluChain } from '../../../src/nlu/index.js';
import type { NluProvider } from '../../../src/nlu/provider.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import type { FakeNlu } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_failover';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const TOMORROW_AT_EIGHT_PM = {
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 20, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

const named = (provider: NluProvider, name: string): NluProvider & { inputs: unknown[] } => ({
  name,
  parse: provider.parse,
  inputs: (provider as FakeNlu).inputs,
});

describe('rate/budget failover', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let pending: PendingActions;
  let questions: OpenQuestions;
  let deferred: UndoActions;
  let history: ConversationHistory;
  let lock: AgentLock;
  let budget: TokenBudget;
  let clockMs: number;

  type Setup = {
    providers: AgentProvider[];
    fallbackProviders?: AgentProvider[];
    smartProviders?: AgentProvider[];
    nlu?: NluProvider[];
  };

  const deps = (setup: Setup): PipelineDeps => {
    const services: Services = {
      reminders,
      pending,
      questions,
      deferred,
      nlu: setup.nlu ?? [createFakeNlu([draft('unsupported')])],
      tokenBudget: budget,
      agent: {
        providers: setup.providers,
        ...(setup.fallbackProviders ? { fallbackProviders: setup.fallbackProviders } : {}),
        ...(setup.smartProviders ? { smartProviders: setup.smartProviders } : {}),
        budget,
        history,
        lock,
      },
    };
    return { repo, log: createFakeLogger(), now: () => NOW, principal: PRINCIPAL, services, channel: 'app' };
  };

  let seq = 0;
  const text = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: `wamid.fo.${++seq}`, from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

  const qwen = (steps: FakeStep[]) => createFakeAgent(steps, QWEN, 500, 'primary');
  const backup = (steps: FakeStep[], model = 'groq/backup-model') => createFakeAgent(steps, model, 500, 'backup');

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    reminders = new ReminderStore(driver, () => NOW);
    pending = new PendingActions(driver, () => NOW);
    questions = new OpenQuestions(driver, () => NOW);
    deferred = new UndoActions(driver, () => NOW);
    history = new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    lock = new AgentLock(driver, () => NOW);
    clockMs = NOW;
    budget = new TokenBudget(() => clockMs);
  });
  afterEach(() => driver.close());

  describe('model selection', () => {
    it('starts the turn on a backup when the primary has no room, and never asks the primary', async () => {
      budget.record(QWEN, MINUTE_TOKEN_LIMIT);
      const primary = qwen([{ text: 'מהראשי' }]);
      const second = backup([{ text: 'מהגיבוי' }]);
      const out = await handleInbound(text('כמה זמן מבשלים אורז?'), deps({ providers: [primary, second] }));
      expect(out).toMatchObject({ action: 'reply', text: 'מהגיבוי' });
      expect(primary.calls).toHaveLength(0);
      expect(second.calls).toHaveLength(1);
    });

    it('stays on its model mid-turn: no room for the next call ends the turn, without switching', async () => {
      const primary = qwen([{ tool: 'reminders.list', args: {} }, { text: 'never asked' }]);
      const second = backup([{ text: 'never asked either' }]);
      const wrapped: AgentProvider = {
        model: primary.model,
        role: 'primary',
        async complete(messages, tools): Promise<AgentResponse> {
          const response = await primary.complete(messages, tools);
          // The minute fills while the first call was out.
          budget.record(QWEN, MINUTE_TOKEN_LIMIT);
          return response;
        },
      };
      await handleInbound(text('מה התזכורות שלי?'), deps({ providers: [wrapped, second] }));
      expect(primary.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(0);
    });
  });

  describe('text-only calls', () => {
    it('offers no tools on the call after a read', async () => {
      const primary = qwen([{ tool: 'reminders.list', args: {} }, { text: 'אין תזכורות' }]);
      await handleInbound(text('מה התזכורות שלי?'), deps({ providers: [primary] }));
      expect(primary.tools[0]!.length).toBeGreaterThan(0);
      expect(primary.tools[1]).toEqual([]);
    });

    it('offers no tools on the last allowed call', async () => {
      const primary = qwen([
        { tool: 'reminders.create', args: '{not json' },
        { tool: 'reminders.create', args: '{not json' },
        { text: 'לא הצלחתי' },
      ]);
      await handleInbound(text('תזכיר לי משהו'), deps({ providers: [primary] }));
      expect(primary.tools).toHaveLength(3);
      expect(primary.tools[1]!.length).toBeGreaterThan(0);
      expect(primary.tools[2]).toEqual([]);
    });

    it('narrows the catalog to the one group the words name', async () => {
      const primary = qwen([{ text: 'בסדר' }]);
      await handleInbound(text('מה יש לי ביומן מחר?'), deps({ providers: [primary] }));
      const names = primary.tools[0]!.map((tool) => tool.function.name);
      expect(names).toContain('calendar__list_events');
      expect(names).not.toContain('notes__save');
    });
  });

  describe("a backup model's writes always confirm (§6)", () => {
    it('runs a Tier 1 write from the primary at once', async () => {
      const primary = qwen([{ tool: 'reminders.create', args: { text: 'להתקשר', ...TOMORROW_AT_EIGHT_PM } }]);
      await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps({ providers: [primary] }));
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    });

    it('puts the same Tier 1 write from a backup behind a confirmation', async () => {
      budget.record(QWEN, MINUTE_TOKEN_LIMIT);
      const second = backup([{ tool: 'reminders.create', args: { text: 'להתקשר', ...TOMORROW_AT_EIGHT_PM } }]);
      const out = await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps({ providers: [qwen([]), second] }));
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
      expect(out).toMatchObject({ action: 'reply' });
      expect(driver.exec('SELECT COUNT(*) AS n FROM pending_actions')[0]?.['n']).toBe(1);
    });

    it('treats a provider with no role as a backup', async () => {
      const anonymous = createFakeAgent([{ tool: 'reminders.create', args: { text: 'להתקשר', ...TOMORROW_AT_EIGHT_PM } }]);
      const roleless: AgentProvider = { model: anonymous.model, complete: anonymous.complete.bind(anonymous) };
      await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps({ providers: [roleless] }));
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    });

    it("stores a backup's open question tainted, so the answered write confirms too", async () => {
      budget.record(QWEN, MINUTE_TOKEN_LIMIT);
      const second = backup([{ tool: 'reminders.create', args: { text: 'להתקשר', date: TOMORROW_AT_EIGHT_PM.date } }]);
      await handleInbound(text('תזכיר לי מחר להתקשר'), deps({ providers: [qwen([]), second] }));
      expect(driver.exec('SELECT tainted FROM open_questions')[0]?.['tainted']).toBe(1);
    });
  });

  describe('the message scope (§2b)', () => {
    it('never asks a refused model again in the same message, though its retry-after has passed', async () => {
      // The qwen agent call 429s with retry-after 2, and the clock moves past it.
      const primary = qwen([{ error: 'rate_limited', retryAfterSeconds: 2 }]);
      const advancing: AgentProvider = {
        model: QWEN,
        role: 'primary',
        async complete(messages, tools) {
          const response = await primary.complete(messages, tools);
          clockMs += 61_000;
          return response;
        },
      };
      const qwenParser = named(createFakeNlu([draft('unsupported')]), `groq:${QWEN}`);
      const ossParser = named(createFakeNlu([{ ok: false, error: { code: 'rate_limited', status: 429, retryAfterSeconds: 2 } }]), `groq:${GPT_OSS_120B}`);
      const rules = named(createFakeNlu([draft('unsupported')]), 'rules');
      const ossAgent = backup([{ text: 'never asked' }], GPT_OSS_120B);

      const out = await handleInbound(
        text('ספר לי משהו מעניין'),
        deps({ providers: [advancing], fallbackProviders: [ossAgent], nlu: [qwenParser, ossParser, rules] }),
      );
      expect(out.action).toBe('reply');
      expect(primary.calls).toHaveLength(1);
      expect(qwenParser.inputs).toHaveLength(0);
      expect(ossParser.inputs).toHaveLength(1);
      expect(rules.inputs).toHaveLength(1);
      // gpt-oss refused this message in the parser: the read-only try skips it.
      expect(ossAgent.calls).toHaveLength(0);
    });

    it('starts the next message with an empty scope', async () => {
      const first = qwen([{ error: 'rate_limited', retryAfterSeconds: 2 }]);
      await handleInbound(text('שלום'), deps({ providers: [first] }));
      clockMs += 61_000;
      const second = qwen([{ text: 'היי' }]);
      const out = await handleInbound(text('שלום שוב'), deps({ providers: [second] }));
      expect(out).toMatchObject({ action: 'reply', text: 'היי' });
    });

    it("blocks a request-limited model until California midnight when its 429 named the day", async () => {
      const gemini = createFakeAgent([{ error: 'rate_limited', daily: true }], SMART_MODELS[0]!.id, 500, 'smart');
      // Only a smart conversation's turn reaches a smart model (slice 4).
      const smart = { ...text('שלום'), conversationId: 'conv-smart-fo', mode: 'smart' } as InboundEvent;
      await handleInbound(smart, deps({ providers: [], smartProviders: [gemini] }));
      expect(gemini.calls).toHaveLength(1);
      expect(budget.reservedFor(gemini.model)).toBe(0);
      // NOW is 02:00 PDT on 2026-09-24: the quota day ends at 07:00 UTC the next morning.
      expect(budget.snapshot([gemini.model])[0]?.blockedUntil).toBe(Date.parse('2026-09-25T07:00:00Z'));
    });

    it('leaves no reservation open after a 429', async () => {
      const primary = qwen([{ error: 'rate_limited', retryAfterSeconds: 2 }]);
      await handleInbound(text('שלום'), deps({ providers: [primary] }));
      expect(budget.reservedFor(QWEN)).toBe(0);
    });
  });
});

describe('the model table', () => {
  it('lists the primary first and pins fully versioned ids', () => {
    expect(MODELS[0]?.role).toBe('primary');
    expect(MODELS.filter((entry) => entry.role === 'primary')).toHaveLength(1);
    for (const entry of MODELS) expect(entry.id).not.toMatch(/latest/i);
    expect(new Set(MODELS.map((entry) => entry.id)).size).toBe(MODELS.length);
  });

  it('keeps the parser chain exactly qwen, gpt-oss, rules: new models are agent-only', () => {
    const chain = buildNluChain({ groqApiKey: 'k' }).map((provider) => provider.name);
    expect(chain).toEqual([`groq:${QWEN}`, `groq:${GPT_OSS_120B}`, 'rules']);
  });
});

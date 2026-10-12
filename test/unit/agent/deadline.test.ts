/**
 * The turn deadline (Improvement plan §3 T3, Batch 06), end to end through the
 * pipeline with a scripted clock.
 *
 * What is pinned: after the deadline no model call of any kind starts — not
 * the agent's next call, not the parser, not the read-only try — and a write
 * whose `execute` started before it answers with its own reply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps, Services } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { REMINDER_TOOLS } from '../../../src/tools/reminders.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { TokenBudget } from '../../../src/agent/budget.js';
import { ConversationHistory } from '../../../src/agent/history.js';
import { AgentLock } from '../../../src/agent/lock.js';
import { TURN_DEADLINE_MS } from '../../../src/agent/limits.js';
import { QWEN } from '../../../src/agent/models.js';
import type { AgentProvider, AgentResponse } from '../../../src/agent/provider.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { he } from '../../../src/render/he.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import type { FakeNlu } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_deadline';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(6)));
const CREATE = {
  text: 'להתקשר',
  date: { kind: 'relative_days', offset: 1 },
  time: { hour: 20, minute: 0, meridiem: 'unspecified', part_of_day: 'unspecified' },
};

describe('the turn deadline', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let reminders: ReminderStore;
  let lock: AgentLock;
  let clock: number;
  let nlu: FakeNlu;
  let readOnly: FakeAgent;
  let services: Services;

  let log: ReturnType<typeof createFakeLogger>;
  const deps = (providers: AgentProvider[]): PipelineDeps => ({
    repo,
    log,
    now: () => clock,
    principal: PRINCIPAL,
    services: { ...services, agent: { ...services.agent!, providers, fallbackProviders: [readOnly] } },
    channel: 'app',
  });

  const text = (body: string): InboundEvent =>
    ({ kind: 'text', wamid: 'wamid.dl.1', from: '972500000000', sentAtMs: NOW - 1_000, text: body, forwarded: false }) as InboundEvent;

  /** A scripted model whose call `n` (from 1) returns with the clock at `at[n]`, when given. */
  const timedModel = (steps: FakeStep[], at: Record<number, number>): FakeAgent & AgentProvider => {
    const inner = createFakeAgent(steps, QWEN, 500, 'primary');
    return {
      ...inner,
      async complete(messages, tools): Promise<AgentResponse> {
        const response = await inner.complete(messages, tools);
        const set = at[inner.calls.length];
        if (set !== undefined) clock = set;
        return response;
      },
    };
  };

  const outcomeOf = (wamid: string): unknown =>
    driver.exec('SELECT error_code FROM inbound_messages WHERE wamid = ?', wamid)[0]?.['error_code'];

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    clock = NOW;
    log = createFakeLogger();
    reminders = new ReminderStore(driver, () => NOW);
    lock = new AgentLock(driver, () => clock);
    nlu = createFakeNlu([draft('unsupported')]);
    readOnly = createFakeAgent([{ text: 'never asked' }], 'groq/backup-model', 500, 'backup');
    services = {
      reminders,
      pending: new PendingActions(driver, () => NOW),
      questions: new OpenQuestions(driver, () => NOW),
      deferred: new UndoActions(driver, () => NOW),
      nlu: [nlu],
      agent: {
        providers: [],
        budget: new TokenBudget(() => clock),
        history: new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY })),
        lock,
      },
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    driver.close();
  });

  it('(a) W3: a write whose execute started before the deadline answers with its own reply', async () => {
    const create = REMINDER_TOOLS['reminders.create'];
    const original = create.execute.bind(create);
    let heldAtEnd: boolean | undefined;
    vi.spyOn(create, 'execute').mockImplementation(async (input, ctx) => {
      clock = NOW + TURN_DEADLINE_MS + 4_000; // started 1 s before, took 5 s
      const result = await original(input, ctx);
      heldAtEnd = lock.isHeld(PRINCIPAL);
      return result;
    });
    const model = timedModel([{ tool: 'reminders.create', args: CREATE }, { text: 'never asked' }], {
      1: NOW + TURN_DEADLINE_MS - 1_000,
    });

    const out = await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model]));

    expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
    expect(out).toMatchObject({ action: 'reply' });
    expect(stripIsolates((out as { text: string }).text)).not.toBe(stripIsolates(he.agentFailed('deadline')));
    expect(model.calls).toHaveLength(1);
    expect(nlu.inputs).toHaveLength(0);
    expect(readOnly.calls).toHaveLength(0);
    // The lock outlives the write that started just before the deadline (T3-2).
    expect(heldAtEnd).toBe(true);
  });

  it('(b) a write call that arrives after the deadline never executes, and nothing else is asked', async () => {
    const create = REMINDER_TOOLS['reminders.create'];
    const execute = vi.spyOn(create, 'execute');
    const model = timedModel([{ tool: 'reminders.create', args: CREATE }, { text: 'never asked' }], {
      1: NOW + TURN_DEADLINE_MS + 1,
    });

    const out = await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model]));

    expect(execute).not.toHaveBeenCalled();
    expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
    expect(out).toMatchObject({ action: 'reply', text: he.agentFailed('deadline') });
    expect(model.calls).toHaveLength(1);
    expect(nlu.inputs).toHaveLength(0);
    expect(readOnly.calls).toHaveLength(0);
    expect(outcomeOf('wamid.dl.1')).toBe('E_AGENT_DEADLINE');
  });

  it('(d) R2: a read done before the deadline answers with its own text, with no next model call', async () => {
    const list = REMINDER_TOOLS['reminders.list'];
    const original = list.execute.bind(list);
    vi.spyOn(list, 'execute').mockImplementation(async (input, ctx) => {
      const result = await original(input, ctx);
      clock = NOW + TURN_DEADLINE_MS + 1; // the deadline passes before the next call
      return result;
    });
    const model = timedModel([{ tool: 'reminders.list', args: {} }, { text: 'never asked' }], {});

    const out = await handleInbound(text('מה התזכורות שלי?'), deps([model]));

    expect(model.calls).toHaveLength(1);
    expect(nlu.inputs).toHaveLength(0);
    expect(readOnly.calls).toHaveLength(0);
    expect(out).toMatchObject({ action: 'reply' });
    const reply = (out as { text: string }).text;
    expect(reply).not.toBe(he.agentFailed('deadline'));
    expect(reply).not.toBe(he.agentIncomplete);
  });

  it('(e) W4, a pre-existing limit: a write whose own request timed out reports failure, as before', async () => {
    const create = REMINDER_TOOLS['reminders.create'];
    vi.spyOn(create, 'execute').mockRejectedValue(new Error('E_TIMEOUT'));
    const model = timedModel([{ tool: 'reminders.create', args: CREATE }], {});

    const out = await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model]));

    // The remote side may have applied it; the reply still says it failed.
    expect(out).toMatchObject({ action: 'reply', text: he.internalError });
    expect(nlu.inputs).toHaveLength(0);
    expect(readOnly.calls).toHaveLength(0);
  });

  it('checks the deadline before a model call: a turn already past it asks no model at all', async () => {
    const model = timedModel([{ tool: 'reminders.list', args: {} }, { text: 'never asked' }], {});
    const list = REMINDER_TOOLS['reminders.list'];
    const original = list.execute.bind(list);
    vi.spyOn(list, 'execute').mockImplementation(async (input, ctx) => {
      clock = NOW + TURN_DEADLINE_MS; // exactly at the deadline is past it
      return original(input, ctx);
    });
    await handleInbound(text('מה התזכורות שלי?'), deps([model]));
    expect(model.calls).toHaveLength(1);
  });

  describe('the agent_turn record', () => {
    const records = () => log.captured.filter((entry) => entry.event === 'agent_turn').map((entry) => entry.fields);

    it('is one content-free record per loop, on a model reply', async () => {
      const model = timedModel([{ text: 'שלום' }], { 1: NOW + 2_500 });
      await handleInbound(text('היי'), deps([model]));
      expect(records()).toEqual([{ ms: 2_500, modelCalls: 1, toolsRun: 0, deadlineHit: false }]);
    });

    it('says when the deadline ended the turn', async () => {
      const model = timedModel([{ tool: 'reminders.create', args: CREATE }], { 1: NOW + TURN_DEADLINE_MS + 1 });
      await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model]));
      expect(records()).toEqual([{ ms: TURN_DEADLINE_MS + 1, modelCalls: 1, toolsRun: 0, deadlineHit: true }]);
    });

    it('counts the tools a write turn ran', async () => {
      const model = timedModel([{ tool: 'reminders.create', args: CREATE }], {});
      await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model]));
      expect(records()).toEqual([{ ms: 0, modelCalls: 1, toolsRun: 1, deadlineHit: false }]);
    });

    it('is written when the model call throws, too', async () => {
      const model: AgentProvider = { model: QWEN, role: 'primary', complete: () => Promise.reject(new Error('boom')) };
      await handleInbound(text('היי'), deps([model])).catch(() => undefined);
      expect(records()).toHaveLength(1);
      expect(Object.keys(records()[0]!).sort()).toEqual(['deadlineHit', 'modelCalls', 'ms', 'toolsRun']);
    });
  });
});

/**
 * The turn deadline (Improvement plan §3 T3, Batches 06–07), end to end through
 * the pipeline: a scripted clock for the checks between steps, fake timers for
 * the abort signal that cuts a step in flight.
 *
 * What is pinned: after the deadline no model call of any kind starts — not
 * the agent's next call, not the parser, not the read-only try — no write
 * starts, no data of a read the deadline may have cut is shown, and a write
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
import type { ToolContext } from '../../../src/tools/types.js';
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
  const audits = (tool: string): unknown[] =>
    driver.exec('SELECT outcome FROM audit_log WHERE tool = ?', tool).map((row) => row['outcome']);

  /** A promise that settles, with `value()`, when the turn's signal fires. */
  const onAbort = <T,>(signal: AbortSignal | null | undefined, value: () => T | Promise<T>): Promise<T> => {
    expect(signal).toBeInstanceOf(AbortSignal);
    return new Promise<T>((resolve, reject) => {
      signal!.addEventListener('abort', () => {
        Promise.resolve().then(value).then(resolve, reject);
      });
    });
  };

  /** Start the message, then let the turn's deadline timer fire. */
  const pastTheDeadline = async (pending: Promise<unknown>, extraMs = 0): Promise<unknown> => {
    await vi.advanceTimersByTimeAsync(TURN_DEADLINE_MS + extraMs);
    return pending;
  };

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
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (REMINDER_TOOLS['reminders.create'] as { resolveAsync?: unknown }).resolveAsync;
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

  describe('a step in flight at the deadline (T3-4, fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    const create = REMINDER_TOOLS['reminders.create'];
    const list = REMINDER_TOOLS['reminders.list'];
    /** `reminders.create` resolves synchronously; these cases give it a network resolve. */
    const giveResolveAsync = (fn: (slots: unknown, ctx: ToolContext) => Promise<unknown>) => {
      (create as { resolveAsync?: unknown }).resolveAsync = fn;
    };

    it('(c) W1: a resolve read in flight is cut, nothing executes, and the audit says deadline', async () => {
      // Even a question built from the cut read is not what the user gets.
      giveResolveAsync((_slots, ctx) => onAbort(ctx.signal, () => ({ kind: 'clarify', clarify: { code: 'not_found' } })));
      const execute = vi.spyOn(create, 'execute');
      const model = timedModel([{ tool: 'reminders.create', args: CREATE }, { text: 'never asked' }], {});

      const out = await pastTheDeadline(handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model])));

      expect(execute).not.toHaveBeenCalled();
      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(0);
      expect(out).toMatchObject({ action: 'reply', text: he.agentFailed('deadline') });
      expect(audits('reminders.create')).toEqual(['deadline']);
      expect(model.calls).toHaveLength(1);
      expect(nlu.inputs).toHaveLength(0);
      expect(readOnly.calls).toHaveLength(0);
      expect(outcomeOf('wamid.dl.1')).toBe('E_AGENT_DEADLINE');
    });

    it('(c2) W2: a resolve that completes 1 ms after the deadline executes nothing', async () => {
      giveResolveAsync(
        () => new Promise((resolve) => setTimeout(() => resolve({ kind: 'ready', input: { never: 'run' } }), TURN_DEADLINE_MS + 1)),
      );
      const execute = vi.spyOn(create, 'execute');
      const model = timedModel([{ tool: 'reminders.create', args: CREATE }, { text: 'never asked' }], {});

      const out = await pastTheDeadline(handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model])), 1);

      expect(execute).not.toHaveBeenCalled();
      expect(out).toMatchObject({ action: 'reply', text: he.agentFailed('deadline') });
      expect(audits('reminders.create')).toEqual(['deadline']);
      expect(nlu.inputs).toHaveLength(0);
      expect(readOnly.calls).toHaveLength(0);
    });

    it("a write's execute never gets the signal, and a read's does", async () => {
      const signals: Record<string, AbortSignal | undefined> = {};
      for (const tool of [create, list]) {
        const original = tool.execute.bind(tool);
        vi.spyOn(tool, 'execute').mockImplementation(async (input, ctx) => {
          signals[tool.name] = ctx.signal;
          return original(input, ctx);
        });
      }
      await handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([timedModel([{ tool: 'reminders.create', args: CREATE }], {})]));
      await handleInbound(
        { ...text('מה התזכורות שלי?'), wamid: 'wamid.dl.2' } as InboundEvent,
        deps([timedModel([{ tool: 'reminders.list', args: {} }, { text: 'יש אחת' }], {})]),
      );

      expect(Object.keys(signals).sort()).toEqual(['reminders.create', 'reminders.list']);
      expect(signals['reminders.create']).toBeUndefined();
      expect(signals['reminders.list']).toBeInstanceOf(AbortSignal);
    });

    it('(d2) R1: a read whose request is pending at the deadline shows nothing of it', async () => {
      const seen: AbortSignal[] = [];
      services.fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
        seen.push(init!.signal!);
        return onAbort(init?.signal, () => Promise.reject(new DOMException('aborted', 'AbortError')));
      }) as unknown as typeof fetch;
      vi.spyOn(list, 'execute').mockImplementation(async (_input, ctx) => {
        try {
          await ctx.fetchImpl!('https://example.com/data');
          return { text: 'DATA-FETCHED' };
        } catch {
          return { text: 'FETCH-FAILED' };
        }
      });
      const model = timedModel([{ tool: 'reminders.list', args: {} }, { text: 'never asked' }], {});

      const out = await pastTheDeadline(handleInbound(text('מה התזכורות שלי?'), deps([model])));

      expect(seen).toHaveLength(1);
      expect(out).toMatchObject({ action: 'reply', text: he.agentIncomplete });
      expect(model.calls).toHaveLength(1);
      expect(nlu.inputs).toHaveLength(0);
      expect(readOnly.calls).toHaveLength(0);
      expect(audits('reminders.list')).toEqual(['deadline']);
    });

    it('(d2) R3: data that arrives in the same tick as the abort is not shown either', async () => {
      vi.spyOn(list, 'execute').mockImplementation((_input, ctx) => onAbort(ctx.signal, () => ({ text: 'DATA-RACED' })));
      const model = timedModel([{ tool: 'reminders.list', args: {} }, { text: 'never asked' }], {});

      const out = await pastTheDeadline(handleInbound(text('מה התזכורות שלי?'), deps([model])));

      expect(out).toMatchObject({ action: 'reply', text: he.agentIncomplete });
      expect(JSON.stringify(out)).not.toContain('DATA-RACED');
      expect(model.calls).toHaveLength(1);
      expect(nlu.inputs).toHaveLength(0);
      expect(readOnly.calls).toHaveLength(0);
    });

    it('(f) a model call in flight at the deadline ends `deadline`, not timeout: no parser, no read-only try', async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const model: AgentProvider = {
        model: QWEN,
        role: 'primary',
        complete: (_messages, _tools, options) => {
          signals.push(options?.signal);
          // What the real provider answers when its fetch is aborted.
          return onAbort(options?.signal, (): AgentResponse => ({ ok: false, error: { code: 'timeout' } }));
        },
      };

      const out = await pastTheDeadline(handleInbound(text('היי'), deps([model])));

      expect(signals).toHaveLength(1);
      expect(out).toMatchObject({ action: 'reply', text: he.agentFailed('deadline') });
      expect(outcomeOf('wamid.dl.1')).toBe('E_AGENT_DEADLINE');
      expect(nlu.inputs).toHaveLength(0);
      expect(readOnly.calls).toHaveLength(0);
      const turn = log.captured.find((entry) => entry.event === 'agent_turn');
      expect(turn?.fields).toMatchObject({ modelCalls: 1, deadlineHit: true });
    });

    it('(a) still holds with the timer running: a write that started before the deadline finishes', async () => {
      const original = create.execute.bind(create);
      vi.spyOn(create, 'execute').mockImplementation(async (input, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 5_000)); // runs past the deadline
        return original(input, ctx);
      });
      const model = timedModel([{ tool: 'reminders.create', args: CREATE }, { text: 'never asked' }], {});
      const pending = handleInbound(text('תזכיר לי מחר בשמונה בערב להתקשר'), deps([model]));
      // The write starts 1 s before the deadline.
      await vi.advanceTimersByTimeAsync(0);
      const out = await pastTheDeadline(pending, 5_000);

      expect(reminders.listUpcoming(PRINCIPAL)).toHaveLength(1);
      expect(stripIsolates((out as { text: string }).text)).not.toBe(stripIsolates(he.agentFailed('deadline')));
      expect(audits('reminders.create')).toEqual(['ok']);
      expect(nlu.inputs).toHaveLength(0);
      expect(readOnly.calls).toHaveLength(0);
    });
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

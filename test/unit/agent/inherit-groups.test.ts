/**
 * Inherited tool groups and the brief catalog (block J, J2), end to end
 * through the pipeline. The model is scripted; selection, the store, the
 * fallback and the catalog are the real code.
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
import { LastSelections } from '../../../src/agent/last-selection.js';
import { BRIEFS } from '../../../src/agent/briefs.js';
import { GROUPS } from '../../../src/agent/tool-groups.js';
import { toWireName } from '../../../src/agent/tools.js';
import { QWEN, SMART_MODELS } from '../../../src/agent/models.js';
import { REGISTRY } from '../../../src/tools/registry.js';
import type { CalendarClient } from '../../../src/google/calendar.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import type { FakeNlu } from '../../integration/fake-nlu.js';
import { createFakeAgent } from '../../integration/fake-agent.js';
import type { FakeAgent, FakeStep } from '../../integration/fake-agent.js';

/** Thursday 2026-09-24, 12:00 local. */
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_inherit';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
const CONV = 'conv-local-j2';
const TIME_WIRE = new Set(GROUPS.time.map(toWireName));
const LIST_TOMORROW: FakeStep = { tool: 'calendar.list_events', args: { date: { kind: 'relative_days', offset: 1 } } };
/** Names no group, and is short: a follow-up. */
const FOLLOW_UP = 'תבטל אותה';

const calendar = {
  async listEvents() {
    return { ok: true as const, value: [] };
  },
  async listAllEvents() {
    return { ok: true as const, value: [] };
  },
} as unknown as CalendarClient;

describe('inherited groups (J2a)', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let services: Omit<Services, 'nlu' | 'agent'>;
  let history: ConversationHistory;
  let lock: AgentLock;
  let budget: TokenBudget;
  let selections: LastSelections;
  let clock: number;
  let nlu: FakeNlu;

  const deps = (agent: FakeAgent, parser: unknown[] = [draft('unsupported')], extra: { smart?: FakeAgent } = {}): PipelineDeps => {
    nlu = createFakeNlu(parser);
    return {
      repo,
      log: createFakeLogger(),
      now: () => clock,
      principal: PRINCIPAL,
      channel: 'app',
      services: {
        ...services,
        calendar,
        nlu: [nlu],
        agent: {
          providers: [agent],
          ...(extra.smart ? { smartProviders: [extra.smart] } : {}),
          budget,
          history,
          lock,
          selections,
        },
      } as Services,
    };
  };

  let seq = 0;
  const text = (body: string, options: { conversation?: string; mode?: 'smart' | 'local'; forwarded?: boolean } = {}): InboundEvent =>
    ({
      kind: 'text',
      wamid: `app:in:j2.${++seq}`,
      from: '972500000000',
      sentAtMs: clock - 1_000,
      text: body,
      forwarded: options.forwarded === true,
      conversationId: options.conversation ?? CONV,
      mode: options.mode ?? 'local',
    }) as InboundEvent;

  const offered = (agent: FakeAgent, call = 0) => agent.tools[call]!.map((tool) => tool.function.name);
  const descriptionOf = (agent: FakeAgent, wire: string, call = 0) =>
    agent.tools[call]!.find((tool) => tool.function.name === wire)?.function.description;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    clock = NOW;
    services = {
      reminders: new ReminderStore(driver, () => clock),
      pending: new PendingActions(driver, () => clock),
      questions: new OpenQuestions(driver, () => clock),
      deferred: new UndoActions(driver, () => clock),
    };
    history = new ConversationHistory(driver, () => clock, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
    lock = new AgentLock(driver, () => clock);
    budget = new TokenBudget(() => clock);
    selections = new LastSelections(driver, () => clock);
  });
  afterEach(() => driver.close());

  it('a follow-up after a calendar read is offered the time group; a failed turn falls to the parser', async () => {
    const first = createFakeAgent([LIST_TOMORROW, { text: 'אין לך כלום מחר.' }], QWEN);
    await handleInbound(text('מה יש לי ביומן מחר?'), deps(first));

    // The needed tool may be missing: no tool runs, and a turn that fails goes
    // to the parser with its own catalog, as any turn with no tool does.
    const second = createFakeAgent([{ text: '' }], QWEN);
    await handleInbound(text(FOLLOW_UP), deps(second));
    expect(new Set(offered(second))).toEqual(new Set([...TIME_WIRE].filter((wire) => offered(second).includes(wire))));
    expect(offered(second).every((wire) => TIME_WIRE.has(wire))).toBe(true);
    expect(offered(second).length).toBeGreaterThan(0);
    // The model ran no tool: the parser was asked, as for any turn with no tool.
    expect(nlu.inputs.length).toBe(1);
  });

  it('a follow-up after a turn that ran no tool gets the full set, briefly described', async () => {
    const first = createFakeAgent([{ text: 'שלום!' }], QWEN);
    await handleInbound(text('מה יש לי ביומן מחר?'), deps(first));

    const second = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text(FOLLOW_UP), deps(second));
    expect(offered(second)).toContain(toWireName('calc.compute'));
    expect(offered(second).some((wire) => !TIME_WIRE.has(wire))).toBe(true);
    expect(descriptionOf(second, toWireName('info.lookup'))).toBe(BRIEFS['info.lookup']);
  });

  it('ends after 10 minutes', async () => {
    await handleInbound(text('מה יש לי ביומן מחר?'), deps(createFakeAgent([LIST_TOMORROW, { text: 'כלום.' }], QWEN)));
    clock += 10 * 60_000 + 1;
    const second = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text(FOLLOW_UP), deps(second));
    expect(offered(second).some((wire) => !TIME_WIRE.has(wire))).toBe(true);
  });

  it('a long message is not a follow-up', async () => {
    await handleInbound(text('מה יש לי ביומן מחר?'), deps(createFakeAgent([LIST_TOMORROW, { text: 'כלום.' }], QWEN)));
    const second = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text('תגיד לי בבקשה משהו נחמד ומצחיק על החיים'), deps(second));
    expect(offered(second).some((wire) => !TIME_WIRE.has(wire))).toBe(true);
  });

  it('a turn that started tainted is never inherited', async () => {
    await handleInbound(
      text('מה יש לי ביומן מחר?', { forwarded: true }),
      deps(createFakeAgent([LIST_TOMORROW, { text: 'כלום.' }], QWEN)),
    );
    const second = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text(FOLLOW_UP), deps(second));
    expect(offered(second).some((wire) => !TIME_WIRE.has(wire))).toBe(true);
  });

  it('a tool the parser ran (the agent ran none) is never inherited', async () => {
    const first = createFakeAgent([{ error: 'timeout' }], QWEN);
    await handleInbound(text('מה יש לי ביומן מחר?'), deps(first, [draft('calendar.list_events', { date: { kind: 'relative_days', offset: 1 } })]));
    // The timed-out call was charged to this minute's budget.
    clock += 61_000;
    const second = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text(FOLLOW_UP), deps(second));
    expect(offered(second).some((wire) => !TIME_WIRE.has(wire))).toBe(true);
  });

  it('keeps each conversation apart', async () => {
    await handleInbound(text('מה יש לי ביומן מחר?'), deps(createFakeAgent([LIST_TOMORROW, { text: 'כלום.' }], QWEN)));
    const second = createFakeAgent([{ text: 'בסדר' }], QWEN);
    await handleInbound(text(FOLLOW_UP, { conversation: 'conv-local-other' }), deps(second));
    expect(offered(second).some((wire) => !TIME_WIRE.has(wire))).toBe(true);
  });

  it('a smart conversation neither records nor inherits, and its catalog is never brief', async () => {
    const gemini = (steps: FakeStep[]) => createFakeAgent(steps, SMART_MODELS[0]!.id, 500, 'smart');
    const g1 = gemini([{ text: 'שלום' }]);
    await handleInbound(text('מה המייל האחרון?', { conversation: 'conv-smart-j2', mode: 'smart' }), deps(createFakeAgent([], QWEN), undefined, { smart: g1 }));
    expect(driver.exec('SELECT COUNT(*) AS n FROM last_selection')[0]?.['n']).toBe(0);
    const g2 = gemini([{ text: 'בסדר' }]);
    await handleInbound(text(FOLLOW_UP, { conversation: 'conv-smart-j2', mode: 'smart' }), deps(createFakeAgent([], QWEN), undefined, { smart: g2 }));
    expect(descriptionOf(g2, toWireName('info.lookup'))).toBe(REGISTRY['info.lookup'].llmDescription);
  });

  it('a narrowed selection keeps the full descriptions', async () => {
    const agent = createFakeAgent([{ text: 'מחר יהיה נאה' }], QWEN);
    await handleInbound(text('מה מזג האוויר מחר?'), deps(agent));
    expect(offered(agent)).toContain(toWireName('info.lookup'));
    expect(offered(agent).length).toBeLessThan(40);
    expect(descriptionOf(agent, toWireName('info.lookup'))).toBe(REGISTRY['info.lookup'].llmDescription);
  });
});

/**
 * The canary through the agent (PLAN §6.9, §6.19): a unique string in the
 * message, in a calendar title the agent reads, and in the model's own reply
 * must reach neither the log sink nor the database in the clear.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Repository } from '../../src/core/repo.js';
import { handleInbound, resumeFromPhone } from '../../src/core/pipeline.js';
import { createLogger } from '../../src/security/redact.js';
import { MIGRATIONS } from '../../src/platform/migrations.js';
import { ReminderStore } from '../../src/tools/reminder-store.js';
import { PendingActions } from '../../src/confirm/pending.js';
import { UndoActions } from '../../src/confirm/undo.js';
import { OpenQuestions } from '../../src/confirm/questions.js';
import { parseKeyring } from '../../src/security/crypto.js';
import { TokenBudget } from '../../src/agent/budget.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { AgentLock } from '../../src/agent/lock.js';
import { SuspendedTurns } from '../../src/agent/turns.js';
import type { CalendarClient } from '../../src/google/calendar.js';
import { TestSqlDriver } from '../integration/sqlite-driver.js';
import { createFakeAgent } from '../integration/fake-agent.js';
import { createFakeNlu } from '../integration/fake-nlu.js';

const CANARY = 'CANARY-agent-5d1e';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const NOW = Date.parse('2026-09-24T09:00:00Z');

describe('agent log canary', () => {
  let written: string[];
  let driver: TestSqlDriver;

  beforeEach(() => {
    written = [];
    driver = new TestSqlDriver();
    for (const method of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(' '));
      });
    }
  });
  afterEach(() => {
    driver.close();
    vi.restoreAllMocks();
  });

  it('keeps the message, the data read and the model reply out of the logs and out of plaintext storage', async () => {
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const calendar = {
      async listEvents() {
        return {
          ok: true as const,
          value: [{ id: 'e1', title: `${CANARY}-title`, startUtc: NOW + 3_600_000, endUtc: NOW + 7_200_000, allDay: false, createdByAssistant: false, etag: null }],
        };
      },
    } as unknown as CalendarClient;

    const agent = createFakeAgent([
      { tool: 'calendar.list_events', args: {} },
      { text: `${CANARY}-reply` },
    ]);

    const out = await handleInbound(
      { kind: 'text', wamid: 'wamid.AGENTCANARY', from: '972500000000', sentAtMs: NOW, text: `${CANARY}-message`, forwarded: false },
      {
        repo,
        log: createLogger({ component: 'canary' }),
        now: () => NOW,
        principal: 'p_canary',
        channel: 'app',
        services: {
          reminders: new ReminderStore(driver, () => NOW),
          pending: new PendingActions(driver, () => NOW),
          questions: new OpenQuestions(driver, () => NOW),
          deferred: new UndoActions(driver, () => NOW),
          nlu: [createFakeNlu([])],
          calendar,
          agent: {
            providers: [agent],
            budget: new TokenBudget(() => NOW),
            history: new ConversationHistory(driver, () => NOW, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY })),
            lock: new AgentLock(driver, () => NOW),
          },
        },
      },
    );
    expect(out).toMatchObject({ action: 'reply', text: `${CANARY}-reply` });

    const logs = written.join('\n');
    expect(logs).toContain('agent_call');
    expect(logs).not.toContain(CANARY);

    const tables = driver.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => String(row['name']));
    const dump = tables.map((table) => JSON.stringify(driver.exec(`SELECT * FROM "${table}"`))).join('\n');
    expect(dump).not.toContain(CANARY);
  });
  it('keeps a phone read out of the logs, and out of storage once the turn is over (§6.21)', async () => {
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
    const turns = new SuspendedTurns(driver, () => NOW, keyring);
    const lock = new AgentLock(driver, () => NOW);
    const history = new ConversationHistory(driver, () => NOW, keyring);
    const budget = new TokenBudget(() => NOW);
    const deps = (steps: Parameters<typeof createFakeAgent>[0]) => ({
      repo,
      log: createLogger({ component: 'canary' }),
      now: () => NOW,
      principal: 'p_canary',
      channel: 'app' as const,
      deviceCaps: ['device_query'],
      services: {
        reminders: new ReminderStore(driver, () => NOW),
        pending: new PendingActions(driver, () => NOW),
        questions: new OpenQuestions(driver, () => NOW),
        deferred: new UndoActions(driver, () => NOW),
        nlu: [createFakeNlu([])],
        agent: { providers: [createFakeAgent(steps)], budget, history, lock, turns },
      },
    });

    const asked = await handleInbound(
      { kind: 'text', wamid: 'app:in:CANARY', from: '972500000000', sentAtMs: NOW, text: `${CANARY}-message`, forwarded: false },
      deps([{ tool: 'phone.sms', args: { sender: `${CANARY}-sender` } }]),
    );
    if (asked.action !== 'device_query') throw new Error('expected device_query');

    const begun = turns.begin(asked.queryId, 'p_canary');
    if (begun.kind !== 'run') throw new Error('expected run');
    const done = await resumeFromPhone(
      {
        queryId: asked.queryId,
        wamid: begun.wamid,
        ciphertext: begun.ciphertext,
        sentAtMs: NOW,
        result: { status: 'ok', items: [{ sender: `${CANARY}-sender`, text: `${CANARY}-sms`, at: NOW }] },
      },
      deps([{ text: `${CANARY}-reply` }]),
    );
    expect(done).toMatchObject({ action: 'reply', text: `${CANARY}-reply` });

    const logs = written.join('\n');
    expect(logs).toContain('agent_resumed');
    expect(logs).not.toContain(CANARY);

    const tables = driver.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => String(row['name']));
    const dump = tables.map((table) => JSON.stringify(driver.exec(`SELECT * FROM "${table}"`))).join('\n');
    expect(dump).not.toContain(CANARY);
    expect(driver.exec('SELECT ciphertext FROM agent_turns')[0]?.['ciphertext']).toBeNull();
  });
});

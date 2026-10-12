/**
 * Thrown error text never reaches the log (Improvement plan §3 T5).
 *
 * Every tool's `resolve`, `execute`, confirmed execute and `undo` failures pass
 * through the orchestrator's generic catch sites. A tool here throws an error
 * whose message is the canary — the way a native `SyntaxError` or a SQLite
 * error can quote input — and the real sink must never see it.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Repository } from '../../src/core/repo.js';
import { runButton, runIntent } from '../../src/core/orchestrator.js';
import type { TurnContext } from '../../src/core/orchestrator.js';
import type { IntentDraft } from '../../src/nlu/intent-schema.js';
import { calcCompute } from '../../src/tools/calc.js';
import { REMINDER_TOOLS } from '../../src/tools/reminders.js';
import type { ToolDefinition } from '../../src/tools/types.js';
import { ReminderStore } from '../../src/tools/reminder-store.js';
import type { PendingActions } from '../../src/confirm/pending.js';
import type { UndoActions } from '../../src/confirm/undo.js';
import { createLogger } from '../../src/security/redact.js';
import { MIGRATIONS } from '../../src/platform/migrations.js';
import { TestSqlDriver } from '../integration/sqlite-driver.js';
import { draft } from '../integration/fake-nlu.js';

const CANARY = 'CANARY-5e0c7d21 user words 972500000000';
const NOW = Date.parse('2026-09-24T09:00:00Z');

describe('error text never reaches the log', () => {
  let written: string[];
  let driver: TestSqlDriver;
  let turn: TurnContext;

  beforeEach(() => {
    written = [];
    driver = new TestSqlDriver();
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      written.push(String(line));
    });
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const log = createLogger({ component: 'canary' });
    const pending = {
      confirm: () => ({ ok: true, action: { id: 'a1', tool: 'calc.compute', input: {} } }),
      confirmResolved: () => ({ ok: true, action: { id: 'a1', tool: 'calc.compute', input: {} } }),
    } as unknown as PendingActions;
    const deferred = {
      use: () => ({ ok: true, tool: 'reminders.create', compensating: {} }),
    } as unknown as UndoActions;
    turn = {
      tool: {
        principal: 'p_test',
        nowMs: NOW,
        lang: 'he',
        repo,
        reminders: new ReminderStore(driver, () => NOW),
        log,
        lastInboundAt: null,
        monthlySent: 0,
        channel: 'app',
      },
      pending,
      deferred,
      messageSentAtMs: NOW - 1_000,
      forwarded: false,
      paused: false,
      source: 'text',
    };
  });

  afterEach(() => {
    driver.close();
    vi.restoreAllMocks();
  });

  const calc = draft('calc.compute', { expression: '1+1' }) as IntentDraft;

  const expectNoCanary = (event: string): void => {
    const all = written.join('\n');
    expect(all).toContain(event);
    expect(all).not.toContain('CANARY');
    expect(all).not.toContain('972500000000');
  };

  it('in resolve', async () => {
    vi.spyOn(calcCompute, 'resolve').mockImplementation(() => {
      throw new SyntaxError(CANARY);
    });
    await runIntent(calc, turn);
    expectNoCanary('resolve_failed');
    expect(written.join('\n')).toContain('"errorCode":"SyntaxError"');
  });

  it('in execute', async () => {
    vi.spyOn(calcCompute, 'resolve').mockReturnValue({ kind: 'ready', input: {} });
    vi.spyOn(calcCompute, 'execute').mockRejectedValue(new Error(CANARY));
    await runIntent(calc, turn);
    expectNoCanary('execute_failed');
  });

  it('in a confirmed execute', async () => {
    vi.spyOn(calcCompute, 'execute').mockRejectedValue(new Error(CANARY));
    await runButton('pa:a1:b2:ok', turn);
    expectNoCanary('confirmed_execute_failed');
  });

  it('in undo', async () => {
    const create = REMINDER_TOOLS['reminders.create'] as Required<ToolDefinition>;
    vi.spyOn(create, 'undo').mockRejectedValue(new TypeError(CANARY));
    await runButton('undo:a1:b2:ok', turn);
    expectNoCanary('undo_failed');
    expect(written.join('\n')).toContain('"errorCode":"TypeError"');
  });
});

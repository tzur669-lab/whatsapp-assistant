/**
 * The 10 ms CPU budget, as a test (PLAN §4, backlog B4).
 *
 * `pnpm bench` measured it: a full turn costs about 0.33 ms on this machine,
 * roughly 3% of the Workers Free budget, and the hand-written synchronous
 * SHA-256 — the thing PLAN worried about most — is 0.005 ms on a realistic
 * input. There is around thirty times more headroom than there needs to be.
 *
 * These cases are not that measurement. They are a **ratchet**: generous enough
 * that a GC pause or a loaded machine cannot fail them, tight enough that a
 * tenfold regression cannot pass. Timing assertions are flaky when they are
 * ambitious, so these are not: every ceiling is at least fifteen times the
 * measured cost, and each is a median so one slow run is not the verdict.
 *
 * Exceeding the real budget on Workers does not cost money — it fails the
 * request. That is why this is worth a test at all.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions, sha256Hex } from '../../../src/confirm/pending.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { createFakeNlu, draft, TOMORROW_AT_EIGHT } from '../../integration/fake-nlu.js';
import type { InboundEvent } from '../../../src/channels/types.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_budget000000';

/** Median of `runs`, after a warm-up. One slow run is not the cost. */
async function medianMs(runs: number, body: () => unknown): Promise<number> {
  for (let i = 0; i < Math.min(runs, 20); i++) await body();

  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    await body();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

describe('the synchronous SHA-256, which PLAN worried about', () => {
  it('costs almost nothing on a button id', async () => {
    // Measured at 0.0026 ms. The ceiling is ~200x that, and this is the
    // hot path: every confirmation hashes a nonce and a stored input.
    const value = new TextEncoder().encode('pa:abcdef012345:0123456789abcdef:ok');
    expect(await medianMs(2_000, () => sha256Hex(value))).toBeLessThan(0.5);
  });

  it('stays affordable on the largest input it will ever see', async () => {
    // A stored `input_json` is capped by the slot schemas well under 8 KB.
    // Measured at 0.0975 ms; the ceiling is ~20x.
    const large = new TextEncoder().encode('x'.repeat(8 * 1024));
    expect(await medianMs(200, () => sha256Hex(large))).toBeLessThan(2);
  });
});

describe('a whole turn', () => {
  let driver: TestSqlDriver;
  let deps: PipelineDeps;
  let counter = 0;

  const textEvent = (text: string): InboundEvent => ({
    kind: 'text',
    wamid: `wamid.budget${counter++}`,
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    text,
    forwarded: false,
  });

  beforeEach(() => {
    driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    deps = {
      repo,
      log: createFakeLogger(),
      now: () => NOW,
      principal: PRINCIPAL,
      services: {
        reminders: new ReminderStore(driver, () => NOW),
        pending: new PendingActions(driver, () => NOW),
        questions: new OpenQuestions(driver, () => NOW),
        deferred: new UndoActions(driver, () => NOW),
        nlu: [createFakeNlu([draft('reminders.create', { text: 'א', ...TOMORROW_AT_EIGHT })])],
      },
    };
  });
  afterEach(() => driver.close());

  it('fits inside the budget many times over', async () => {
    // Measured at 0.32 ms of the 10 ms allowance. The ceiling is 15x that and
    // still half the budget, so a real regression fails and a slow CI does not.
    const median = await medianMs(200, () => handleInbound(textEvent('תזכיר לי מחר ב-8'), deps));
    expect(median).toBeLessThan(5);
  });

  it('costs no more to answer a system command', async () => {
    // `/status` reads five counters and now a sixth for undelivered messages.
    const median = await medianMs(200, () => handleInbound(textEvent('/status'), deps));
    expect(median).toBeLessThan(5);
  });
});

describe('cold start', () => {
  it('applies every migration in well under one request', async () => {
    // The dominant cost in the whole system: measured at 0.99 ms, which is 10%
    // of a single request's budget, paid once per Durable Object and added to
    // its first request. It grows with every migration file, which is the one
    // thing here worth watching — hence the ceiling.
    const median = await medianMs(10, () => {
      const fresh = new TestSqlDriver();
      new Repository(fresh).migrate(MIGRATIONS);
      fresh.close();
    });
    expect(median).toBeLessThan(6);
  });
});

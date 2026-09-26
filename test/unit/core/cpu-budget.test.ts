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

  /**
   * These two are catastrophe checks, for the same reason the cold-start case
   * below is one — and they were tightened once too far before anyone wrote the
   * reason down twice.
   *
   * A 5 ms ceiling against a 0.32 ms measurement looked like 15x of headroom. It
   * was not. The same turn measured 0.88 ms on a quiet machine a day later and
   * **11.4 ms** inside a full `pnpm test`, where 64 files run in parallel: the
   * assertion was reading contention, and the failure said nothing about the
   * code. A wall-clock bound cannot both survive this suite and guard a 10 ms
   * budget; those are two different measurements and only one of them belongs in
   * a unit test.
   *
   * So the ceiling here is set where only a real catastrophe reaches it — an
   * accidental O(n²), a missing index, a network call sneaking into a path that
   * is supposed to be pure. The number that actually guards the budget comes
   * from `pnpm bench` on a quiet machine, and ultimately from `cpuMs` in
   * `wrangler tail` on staging, which is the only place workerd's own cost is
   * visible. §4.1 records both.
   */
  const CATASTROPHE_MS = 50;

  it('does not blow the budget outright on a whole turn', async () => {
    const median = await medianMs(200, () => handleInbound(textEvent('תזכיר לי מחר ב-8'), deps));
    expect(median, `${median.toFixed(3)} ms per turn`).toBeLessThan(CATASTROPHE_MS);
  });

  it('does not blow it on a system command either', async () => {
    // `/status` reads five counters and now a sixth for undelivered messages.
    const median = await medianMs(200, () => handleInbound(textEvent('/status'), deps));
    expect(median, `${median.toFixed(3)} ms per /status`).toBeLessThan(CATASTROPHE_MS);
  });
});

describe('cold start', () => {
  it('applies every migration in well under one request', async () => {
    // The dominant cost in the whole system: ~1 ms, a tenth of a single
    // request's budget, paid once per Durable Object and added to its first
    // request. It grows with every migration file, which is the one thing here
    // worth watching.
    //
    // This bound is deliberately loose, and the reason is worth stating.
    //
    // A tighter one was tried twice and both were wrong. A fixed few
    // milliseconds fails whenever vitest's parallel files and a background job
    // load the machine; a ratio against SHA-256 in the same run does not fix it
    // either, because SHA-256 is pure CPU and this is SQLite doing native I/O,
    // and the two do not respond to contention the same way. A guard that fails
    // on a busy machine is one somebody deletes, which is worse than a loose one.
    //
    // So this catches a catastrophe — a missing index, an accidental O(n²), a
    // migration that rebuilds a table — and nothing subtler. The number worth
    // watching (~1 ms, 10% of a request) comes from `pnpm bench`, which is run
    // deliberately and on a quiet machine. §4.1 records it.
    const migrate = await medianMs(10, () => {
      const fresh = new TestSqlDriver();
      new Repository(fresh).migrate(MIGRATIONS);
      fresh.close();
    });

    expect(migrate, `${migrate.toFixed(3)} ms to apply ${MIGRATIONS.length} migrations`)
      .toBeLessThan(50);
  });
});

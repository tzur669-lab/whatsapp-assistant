/**
 * The same message twice, at once (PLAN §6.18). The app retries a message with
 * the same id after a timeout while the first attempt may still be waiting on
 * the parser. The dedupe is the atomic insert in `recordInbound`, reached
 * before the pipeline's first await — so the second attempt must stop there,
 * never reach the parser, and never act.
 *
 * This is the guard the review asked for: if a refactor ever put an await in
 * front of the record, the second call would reach the parser and this fails.
 */
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import type { PipelineDeps } from '../../../src/core/pipeline.js';
import { ReminderStore } from '../../../src/tools/reminder-store.js';
import { PendingActions } from '../../../src/confirm/pending.js';
import { OpenQuestions } from '../../../src/confirm/questions.js';
import { UndoActions } from '../../../src/confirm/undo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import type { NluProvider, NluResponse } from '../../../src/nlu/provider.js';
import type { InboundEvent } from '../../../src/channels/types.js';

describe('one message, twice at once', () => {
  it('is parsed and acted on once; the twin stops at the record', async () => {
    const driver = new TestSqlDriver();
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const now = Date.UTC(2026, 8, 29, 9, 0, 0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let parses = 0;
    const slow: NluProvider = {
      name: 'slow',
      async parse(): Promise<NluResponse> {
        parses++;
        await gate;
        return { ok: false, error: { code: 'timeout' } } as NluResponse;
      },
    };

    const deps: PipelineDeps = {
      repo,
      log: createFakeLogger(),
      now: () => now,
      principal: 'p_test',
      channel: 'app',
      services: {
        reminders: new ReminderStore(driver, () => now),
        pending: new PendingActions(driver, () => now),
        questions: new OpenQuestions(driver, () => now),
        deferred: new UndoActions(driver, () => now),
        nlu: [slow],
      },
    };
    const event: InboundEvent = {
      kind: 'text',
      wamid: 'app:in:3f2b8c1e-4d5a-4b6c-8d7e-9f0a1b2c3d4e',
      from: '972500000000',
      sentAtMs: now,
      text: 'תזכיר לי משהו',
      forwarded: false,
    };

    const first = handleInbound(event, deps);
    const second = handleInbound(event, deps);
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(parses).toBe(1);
    expect(b).toEqual({ action: 'none', reason: 'duplicate' });
    expect(a.action).toBe('reply');
    driver.close();
  });
});

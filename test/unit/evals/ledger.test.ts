/**
 * The evals' daily ledger (PLAN §9): one run at a time, charged before sending.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalLedger, LEDGER_MODEL_TOKENS, LEDGER_TOTAL_REQUESTS } from '../../evals/ledger.js';

describe('EvalLedger', () => {
  let dir: string;
  const NOW = Date.parse('2026-10-06T10:00:00Z');
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lets one run hold the lock, and frees it on close', () => {
    const first = EvalLedger.open(dir, () => NOW);
    expect(() => EvalLedger.open(dir, () => NOW)).toThrow(/Another eval/);
    first.close();
    EvalLedger.open(dir, () => NOW).close();
  });

  it('charges before sending, corrects after, and keeps the reservation without usage', () => {
    const ledger = EvalLedger.open(dir, () => NOW);
    const a = ledger.begin('m', 3_000);
    expect(ledger.spentToday()).toMatchObject({ tokens: { m: 3_000 }, requests: 1 });
    ledger.settle(a, 1_200);
    const b = ledger.begin('m', 3_000);
    ledger.settle(b, 0);
    expect(ledger.spentToday()).toMatchObject({ tokens: { m: 4_200 }, requests: 2 });
    ledger.close();
  });

  it('survives a crash: what was charged is on disk, and the next run starts from it', () => {
    const ledger = EvalLedger.open(dir, () => NOW);
    ledger.begin('m', 5_000);
    ledger.close();
    const file = join(dir, 'ledger-2026-10-06.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ tokens: { m: 5_000 }, requests: 1 });
    const next = EvalLedger.open(dir, () => NOW);
    expect(next.spentToday().tokens['m']).toBe(5_000);
    next.close();
  });

  it('stops on a model reaching its tokens, or on the requests across all models', () => {
    const ledger = EvalLedger.open(dir, () => NOW);
    expect(ledger.stopReason('m')).toBeNull();
    ledger.begin('m', LEDGER_MODEL_TOKENS);
    expect(ledger.stopReason('m')).toMatch(/eval tokens/);
    expect(ledger.stopReason('other')).toBeNull();
    for (let i = 1; i < LEDGER_TOTAL_REQUESTS; i++) ledger.begin(`model-${i % 5}`, 1);
    expect(ledger.stopReason('other')).toMatch(/across all models/);
    ledger.close();
  });
});

/**
 * The evals' daily ledger (PLAN §9): one run at a time, charged before sending.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalLedger, LEDGER_MODEL_TOKENS, LEDGER_REQUEST_SHARE, LEDGER_TOTAL_REQUESTS } from '../../evals/ledger.js';

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

  describe('a model guarded by requests (Gemini, 2026-10-08)', () => {
    const GUARD = { dayRequests: 250 };
    const LIMIT = Math.floor(250 * LEDGER_REQUEST_SHARE);

    it('stops at 80% of its daily requests, never on the Groq token guard', () => {
      const ledger = EvalLedger.open(dir, () => NOW);
      ledger.begin('g', LEDGER_MODEL_TOKENS * 2, GUARD);
      expect(ledger.stopReason('g', GUARD)).toBeNull();
      for (let i = 1; i < LIMIT - 1; i++) ledger.begin('g', 10_000, GUARD);
      expect(ledger.stopReason('g', GUARD)).toBeNull();
      ledger.begin('g', 10_000, GUARD);
      expect(ledger.stopReason('g', GUARD)).toMatch(new RegExp(`${LIMIT} eval requests .*guard ${LIMIT}`));
      ledger.close();
    });

    it("leaves the Groq runs' guards as they were: its requests are not in their total", () => {
      const ledger = EvalLedger.open(dir, () => NOW);
      for (let i = 0; i < LIMIT; i++) ledger.begin('g', 1, GUARD);
      expect(ledger.spentToday().requests).toBe(0);
      expect(ledger.stopReason('qwen')).toBeNull();
      ledger.close();
    });

    it('counts by the Pacific quota day, not the UTC one', () => {
      // 16:30 in California on 2026-10-07; UTC is already near its midnight.
      let now = Date.parse('2026-10-07T23:30:00Z');
      const ledger = EvalLedger.open(dir, () => now);
      for (let i = 0; i < LIMIT; i++) ledger.begin('g', 1, GUARD);
      expect(ledger.stopReason('g', GUARD)).not.toBeNull();
      // A new UTC day, the same Pacific one: still stopped.
      now = Date.parse('2026-10-08T00:30:00Z');
      expect(ledger.stopReason('g', GUARD)).not.toBeNull();
      // California midnight (PDT): the quota starts over.
      now = Date.parse('2026-10-08T07:00:00Z');
      expect(ledger.stopReason('g', GUARD)).toBeNull();
      ledger.close();
    });

    it('records a failed call at what it used: zero, not its reservation', () => {
      const ledger = EvalLedger.open(dir, () => NOW);
      const failed = ledger.begin('g', 9_000, GUARD);
      ledger.settleExact(failed, 0);
      expect(ledger.spentToday().tokens['g']).toBe(0);
      const answered = ledger.begin('g', 9_000, GUARD);
      ledger.settleExact(answered, 1_234);
      expect(ledger.spentToday().tokens['g']).toBe(1_234);
      ledger.close();
    });
  });
});

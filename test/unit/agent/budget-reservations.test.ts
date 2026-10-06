/**
 * Reservations, 429s and the message scope (PLAN §6.19, 2026-10-06).
 *
 * What is asserted is what the ledger guarantees — every open reservation is
 * subtracted, each call is charged exactly once, a measured call is never
 * charged as less — not that an estimate is above what the provider counts.
 */
import { describe, expect, it } from 'vitest';
import {
  estimateParserTokens,
  meterParsers,
  MINUTE_TOKEN_LIMIT,
  newMessageScope,
  TokenBudget,
  wasNeverSent,
} from '../../../src/agent/budget.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import type { NluProvider, NluResponse } from '../../../src/nlu/provider.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const seen = (now: number, remaining: number, resetInMs: number) => ({ limit: 8_000, remaining, resetAt: now + resetInMs });

describe('reservations', () => {
  it('subtracts every open reservation, on the window path', () => {
    const budget = new TokenBudget(clock().now);
    const a = budget.reserve('m', 3_000);
    expect(a).not.toBeNull();
    expect(budget.available('m')).toBe(MINUTE_TOKEN_LIMIT - 3_000);
    const b = budget.reserve('m', 3_000);
    expect(b).not.toBeNull();
    expect(budget.reserve('m', 3_000)).toBeNull();
    expect(budget.available('m')).toBe(MINUTE_TOKEN_LIMIT - 6_000);
  });

  it('subtracts every open reservation from a fresh Groq reading too', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', seen(c.now(), 6_000, 30_000));
    const a = budget.reserve('m', 2_000)!;
    expect(budget.available('m')).toBe(6_000 - 500 - 2_000);
    // A header that already includes the call in flight double-counts it: conservative.
    budget.observe('m', seen(c.now(), 4_000, 30_000));
    expect(budget.available('m')).toBe(4_000 - 500 - 2_000);
    budget.settle(a, 1_800);
    expect(budget.isOpen(a)).toBe(false);
    expect(budget.available('m')).toBe(4_000 - 500);
  });

  it('charges a settled call exactly once, with what it measured', () => {
    const spent: number[] = [];
    const budget = new TokenBudget(clock().now, (_m, t) => spent.push(t));
    const a = budget.reserve('m', 3_000)!;
    budget.settle(a, 1_200);
    budget.settle(a, 1_200);
    expect(spent).toEqual([1_200]);
    expect(budget.usedInWindow('m')).toBe(1_200);
  });

  it('charges the whole reservation when the answer carried no usage', () => {
    const budget = new TokenBudget(clock().now);
    const a = budget.reserve('m', 3_000)!;
    budget.settle(a, 0);
    expect(budget.usedInWindow('m')).toBe(3_000);
  });

  it('charges an unanswered call, and takes it off a fresh reading that never saw it', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', seen(c.now(), 6_000, 60_000));
    const a = budget.reserve('m', 2_000)!;
    budget.chargeUnanswered(a);
    expect(budget.isOpen(a)).toBe(false);
    expect(budget.usedInWindow('m')).toBe(2_000);
    expect(budget.available('m')).toBe(4_000 - 500);
  });

  it('releases a call that was never sent, charging nothing', () => {
    const budget = new TokenBudget(clock().now);
    const a = budget.reserve('m', 3_000)!;
    budget.release(a);
    expect(budget.available('m')).toBe(MINUTE_TOKEN_LIMIT);
    expect(budget.usedInWindow('m')).toBe(0);
  });

  it('two calls in flight: B sees A open; A settling leaves B subtracted until its own settle', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    const a = budget.reserve('m', 3_000)!;
    const b = budget.reserve('m', 3_000)!;
    expect(budget.reserve('m', 2_000)).toBeNull();
    budget.observe('m', seen(c.now(), 5_000, 30_000));
    budget.settle(a, 2_500);
    expect(budget.isOpen(b)).toBe(true);
    expect(budget.available('m')).toBe(5_000 - 500 - 3_000);
    budget.settle(b, 2_500);
    expect(budget.available('m')).toBe(5_000 - 500);
    expect(budget.usedInWindow('m')).toBe(5_000);
  });

  it("follows each model's configured bucket", () => {
    const budget = new TokenBudget(clock().now);
    expect(budget.limitFor('qwen/qwen3.8-27b')).toBe(7_500);
    expect(budget.limitFor('unknown/model')).toBe(MINUTE_TOKEN_LIMIT);
  });
});

describe('429s', () => {
  it('closes the refused reservation, blocks the model, and leaves another call in flight open', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    const a = budget.reserve('m', 2_000)!;
    const b = budget.reserve('m', 2_000)!;
    budget.refused(a, 3);
    expect(budget.isOpen(a)).toBe(false);
    expect(budget.isOpen(b)).toBe(true);
    expect(budget.reserve('m', 1)).toBeNull();
    budget.settle(b, 1_000);
    expect(budget.isOpen(b)).toBe(false);
  });

  it('never unblocks before the retry-after, even when an older reading resets sooner', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', seen(c.now(), 4_000, 2_000));
    budget.rateLimited('m', 20);
    c.advance(5_000);
    // The old reading would have refilled by now; the 429 said 20 s.
    expect(budget.available('m')).toBe(0);
    c.advance(16_000);
    expect(budget.available('m')).toBeGreaterThan(0);
  });

  it('a short retry-after blocks within the minute, never long-term', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited('m', 2);
    expect(budget.fits('m', 100)).toBe(false);
    c.advance(61_000);
    expect(budget.fits('m', 100)).toBe(true);
  });

  it('a long retry-after blocks exactly until then', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited('m', 300);
    c.advance(299_000);
    expect(budget.fits('m', 1)).toBe(false);
    c.advance(2_000);
    expect(budget.fits('m', 1)).toBe(true);
  });

  it('sets a model the provider does not have aside for an hour', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited('m', undefined, 'unavailable');
    c.advance(59 * 60_000);
    expect(budget.fits('m', 1)).toBe(false);
    c.advance(2 * 60_000);
    expect(budget.fits('m', 1)).toBe(true);
  });
});

describe('meterParsers with a message scope (§2b)', () => {
  const named = (provider: NluProvider, name: string): NluProvider => ({ name, parse: provider.parse });
  const input = { text: 'x', nowLocalIso: '', weekday: 'Sunday' as const, tools: [] };
  const limited: NluResponse = { ok: false, error: { code: 'rate_limited', status: 429, retryAfterSeconds: 2 } };

  it('skips a model whose minute cannot take the call, without a fetch, and remembers it', async () => {
    const budget = new TokenBudget(clock().now);
    budget.record('m', MINUTE_TOKEN_LIMIT);
    const scope = newMessageScope();
    const fake = createFakeNlu([draft('reminders.list')]);
    const [metered] = meterParsers([named(fake, 'groq:m')], budget, scope);
    const response = await metered!.parse(input);
    expect(response.ok).toBe(false);
    expect(fake.inputs).toHaveLength(0);
    expect(scope.refused.has('m')).toBe(true);
  });

  it('a 429 joins the refused set; the same message never asks that model again', async () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    const scope = newMessageScope();
    const fake = createFakeNlu([limited, draft('reminders.list')]);
    const [metered] = meterParsers([named(fake, 'groq:m')], budget, scope);
    await metered!.parse(input);
    c.advance(61_000);
    const again = await metered!.parse(input);
    expect(again.ok).toBe(false);
    expect(fake.inputs).toHaveLength(1);
  });

  it('the next message starts with an empty scope', async () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    const fake = createFakeNlu([limited, draft('reminders.list')]);
    await meterParsers([named(fake, 'groq:m')], budget, newMessageScope())[0]!.parse(input);
    c.advance(61_000);
    const next = await meterParsers([named(fake, 'groq:m')], budget, newMessageScope())[0]!.parse(input);
    expect(next.ok).toBe(true);
    expect(fake.inputs).toHaveLength(2);
  });

  it('leaves no reservation open, whatever the outcome', async () => {
    const outcomes: NluResponse[] = [
      draft('reminders.list') as NluResponse,
      limited,
      { ok: false, error: { code: 'timeout' } },
      { ok: false, error: { code: 'provider_error', status: 500 } },
      { ok: false, error: { code: 'invalid_json' } },
      { ok: false, error: { code: 'not_configured' } },
    ];
    for (const outcome of outcomes) {
      const budget = new TokenBudget(clock().now);
      const [metered] = meterParsers([named(createFakeNlu([outcome]), 'groq:m')], budget, newMessageScope());
      await metered!.parse(input);
      expect(budget.reservedFor('m')).toBe(0);
    }
  });

  it('charges a timeout as sent, and releases a call that never left', async () => {
    const budget = new TokenBudget(clock().now);
    const estimate = estimateParserTokens(input);
    await meterParsers([named(createFakeNlu([{ ok: false, error: { code: 'timeout' } }]), 'groq:m')], budget)[0]!.parse(input);
    expect(budget.usedInWindow('m')).toBe(estimate);

    const other = new TokenBudget(clock().now);
    await meterParsers([named(createFakeNlu([{ ok: false, error: { code: 'not_configured' } }]), 'groq:m')], other)[0]!.parse(input);
    expect(other.usedInWindow('m')).toBe(0);
  });

  it('knows which failures never left', () => {
    expect(wasNeverSent({ code: 'not_configured' })).toBe(true);
    expect(wasNeverSent({ code: 'network_error', cause: 'ECONNREFUSED' })).toBe(true);
    expect(wasNeverSent({ code: 'network_error', cause: 'ECONNRESET' })).toBe(false);
    expect(wasNeverSent({ code: 'timeout' })).toBe(false);
  });
});

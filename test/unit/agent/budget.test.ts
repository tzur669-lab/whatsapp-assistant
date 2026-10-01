/**
 * The per-model token budget (PLAN §2, §6.19).
 */
import { describe, expect, it } from 'vitest';
import { MINUTE_TOKEN_LIMIT, meterParsers, TokenBudget } from '../../../src/agent/budget.js';
import { createFakeNlu, draft } from '../../integration/fake-nlu.js';
import type { NluProvider } from '../../../src/nlu/provider.js';

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('TokenBudget', () => {
  it('fits a call while the minute has room, and not after', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    expect(budget.fits('m', 3_000)).toBe(true);
    budget.record('m', 5_000);
    expect(budget.fits('m', 3_000)).toBe(false);
    expect(budget.fits('m', MINUTE_TOKEN_LIMIT - 5_000)).toBe(true);
  });

  it('forgets spend older than a minute', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.record('m', 7_000);
    c.advance(61_000);
    expect(budget.usedInWindow('m')).toBe(0);
  });

  it('keeps each model separate and picks the first that fits', () => {
    const budget = new TokenBudget(clock().now);
    budget.record('a', 7_000);
    expect(budget.pick(['a', 'b'], 2_000)).toBe('b');
    budget.record('b', 7_000);
    expect(budget.pick(['a', 'b'], 2_000)).toBeNull();
  });

  it('reads a long retry-after as the daily budget, and sets the model aside until then', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited('m', 600);
    expect(budget.isExhausted('m')).toBe(true);
    expect(budget.fits('m', 1)).toBe(false);
    c.advance(601_000);
    expect(budget.isExhausted('m')).toBe(false);
  });

  it('reads a short retry-after as the minute bucket, which simply fills', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.rateLimited('m', 7);
    expect(budget.isExhausted('m')).toBe(false);
    expect(budget.fits('m', 100)).toBe(false);
    c.advance(61_000);
    expect(budget.fits('m', 100)).toBe(true);
  });
});

describe('meterParsers', () => {
  const named = (provider: NluProvider, name: string): NluProvider => ({ name, parse: provider.parse });

  it('records what the parser spends against its model', async () => {
    const budget = new TokenBudget(clock().now);
    const fake = createFakeNlu([
      { ok: true, draft: draft('reminders.list'), usage: { promptTokens: 900, completionTokens: 100, cachedTokens: 0 } },
    ]);
    const [metered] = meterParsers([named(fake, 'groq:m')], budget);
    await metered!.parse({ text: 'x', nowLocalIso: '', weekday: 'Sunday', tools: [] });
    expect(budget.usedInWindow('m')).toBe(1_000);
  });

  it('skips a model already out for the day, without calling it', async () => {
    const budget = new TokenBudget(clock().now);
    budget.rateLimited('m', 3_600);
    const fake = createFakeNlu([draft('reminders.list')]);
    const [metered] = meterParsers([named(fake, 'groq:m')], budget);
    const response = await metered!.parse({ text: 'x', nowLocalIso: '', weekday: 'Sunday', tools: [] });
    expect(response.ok).toBe(false);
    expect(fake.inputs).toHaveLength(0);
  });

  it('leaves the rules fallback alone', () => {
    const budget = new TokenBudget(clock().now);
    const rules = createFakeNlu([]);
    const [same] = meterParsers([named(rules, 'rules')], budget);
    expect(same!.name).toBe('rules');
  });
});

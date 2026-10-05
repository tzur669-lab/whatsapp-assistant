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

  it("takes Groq's own minute limit when it is lower, keeping a margin under it", () => {
    const budget = new TokenBudget(clock().now);
    expect(budget.limitFor('m')).toBe(MINUTE_TOKEN_LIMIT);
    budget.learnMinuteLimit('m', 6_000);
    expect(budget.limitFor('m')).toBe(5_500);
    expect(budget.fits('m', 5_600)).toBe(false);
    // A higher limit than assumed is not trusted beyond the assumption.
    budget.learnMinuteLimit('m', 30_000);
    expect(budget.limitFor('m')).toBe(MINUTE_TOKEN_LIMIT);
  });

  it('reports, per model, the minute used, its limit, and how long a model is set aside', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.record('a', 2_000);
    budget.rateLimited('b', 3_600);
    expect(budget.snapshot(['a', 'b'])).toEqual([
      { model: 'a', used: 2_000, limit: MINUTE_TOKEN_LIMIT, freesAt: c.now() + 60_000, blockedUntil: null },
      { model: 'b', used: 0, limit: MINUTE_TOKEN_LIMIT, freesAt: null, blockedUntil: c.now() + 3_600_000 },
    ]);
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

describe("TokenBudget trusts Groq's own minute bucket (2026-10-05)", () => {
  // Measured: the header already subtracts the call that carried it, prompt
  // plus its reserved max_tokens (8000 - 615 - 50 = 7335).
  const seen = (now: number, remaining: number, resetInMs: number) => ({
    limit: 8_000,
    remaining,
    resetAt: now + resetInMs,
  });

  it("admits a turn Groq has room for, though this server's own window is full", () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.record('m', 3_344);
    budget.observe('m', seen(c.now(), 4_600, 25_000));
    c.advance(14_000);
    // 4,600 + 3,400 * 14/25 = 6,504 refilled, 500 under it.
    expect(budget.available('m')).toBe(6_004);
    expect(budget.fits('m', 3_800)).toBe(true);
    expect(budget.fits('m', 6_100)).toBe(false);
  });

  it('refills to the limit, less the margin, once the reset has passed', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', seen(c.now(), 1_000, 10_000));
    c.advance(10_000);
    expect(budget.available('m')).toBe(7_500);
  });

  it("goes back to this server's own window when the reading is over a minute old", () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', seen(c.now(), 0, 60_000));
    c.advance(61_000);
    budget.record('m', 7_000);
    expect(budget.available('m')).toBe(MINUTE_TOKEN_LIMIT - 7_000);
  });

  it('a short 429 empties the observed bucket and keeps its reset time', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', seen(c.now(), 2_000, 20_000));
    budget.rateLimited('m', 3);
    expect(budget.available('m')).toBe(0);
    expect(budget.fits('m', 100)).toBe(false);
    c.advance(10_000);
    // Half way to the observed reset: 8,000 / 2, less the margin.
    expect(budget.available('m')).toBe(3_500);
  });

  it('shows the quota screen the same room that fits() uses', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', seen(c.now(), 4_000, 30_000));
    const [snap] = budget.snapshot(['m']);
    expect(snap).toMatchObject({ used: 4_000, limit: 8_000, freesAt: c.now() + 30_000 });
  });

  it('ignores a reading without a usable limit', () => {
    const c = clock();
    const budget = new TokenBudget(c.now);
    budget.observe('m', { limit: 0, remaining: 0, resetAt: c.now() + 1_000 });
    expect(budget.available('m')).toBe(MINUTE_TOKEN_LIMIT);
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

describe('TokenBudget spend sink (quota screen, 2026-10-01)', () => {
  it('reports real spend, and not the window it fills on a 429', () => {
    const spent: Array<[string, number]> = [];
    const budget = new TokenBudget(() => 1_000, (model, tokens) => spent.push([model, tokens]));
    budget.record('m', 1_234);
    budget.rateLimited('m', 5);
    budget.rateLimited('m', 600);
    expect(spent).toEqual([['m', 1_234]]);
  });
});

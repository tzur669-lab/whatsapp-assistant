/**
 * The token estimator's calibration (PLAN §6.19, 2026-10-06).
 *
 * Monitoring, not an invariant: a reservation's prompt part is an estimate.
 * The fixture holds pairs from real eval runs — the characters the estimator
 * divides, and the prompt tokens Groq counted — integers only, from the
 * synthetic eval corpus. With the code's divisor, the estimate must reach the
 * measured count for at least 99% of calls.
 *
 * If it fails: lower `CHARS_PER_TOKEN` by 0.25 at a time, down to 1.5; if even
 * 1.5 fails, stop and report it — the estimator is wrong for these prompts.
 * Refresh the fixture with `tsx scripts/calibration-sample.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN } from '../../../src/agent/budget.js';

type Pair = { chars: number; promptTokens: number };

const pairs = (
  JSON.parse(readFileSync(resolve(__dirname, '../../fixtures/token-calibration.json'), 'utf8')) as { pairs: Pair[] }
).pairs;

describe('the token estimator', () => {
  it('has real pairs to judge by', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(10);
    for (const pair of pairs) {
      expect(Number.isInteger(pair.chars) && Number.isInteger(pair.promptTokens)).toBe(true);
    }
  });

  it('reaches the measured prompt tokens for at least 99% of calls', () => {
    const under = pairs.filter((pair) => Math.ceil(pair.chars / CHARS_PER_TOKEN) < pair.promptTokens);
    const worst = Math.max(0, ...pairs.map((pair) => pair.promptTokens - Math.ceil(pair.chars / CHARS_PER_TOKEN)));
    process.stderr.write(`calibration: ${pairs.length} pairs, ${under.length} under, largest underestimate ${worst} tokens\n`);
    expect(under.length / pairs.length).toBeLessThanOrEqual(0.01);
  });
});

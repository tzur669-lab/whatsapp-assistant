/**
 * The sample is what the prompt gets iterated against, so a biased one would
 * quietly stop reporting whole categories (PLAN §2: roughly one full run per
 * model per day).
 */
import { describe, expect, it } from 'vitest';
import { sampleCases } from '../../evals/run-evals.js';

type Case = { id: string; now: string; input: string; expect: { intent: string } };

const make = (id: string): Case => ({
  id,
  now: '2026-09-24T21:00:00+03:00',
  input: 'x',
  expect: { intent: 'unsupported' },
});

const corpus = [
  ...Array.from({ length: 20 }, (_, i) => make(`he-rem-${String(i).padStart(3, '0')}`)),
  ...Array.from({ length: 10 }, (_, i) => make(`he-cal-${String(i).padStart(3, '0')}`)),
  ...Array.from({ length: 8 }, (_, i) => make(`he-inj-${String(i).padStart(3, '0')}`)),
  ...Array.from({ length: 6 }, (_, i) => make(`en-rem-${String(i).padStart(3, '0')}`)),
];

const categoriesIn = (cases: Case[]) => new Set(cases.map((c) => c.id.replace(/-\d+$/, '')));

describe('sampleCases', () => {
  it('returns everything when no size is given', () => {
    expect(sampleCases(corpus, null)).toHaveLength(corpus.length);
  });

  it('returns everything when the size exceeds the corpus', () => {
    expect(sampleCases(corpus, 500)).toHaveLength(corpus.length);
  });

  it('returns exactly the requested size', () => {
    expect(sampleCases(corpus, 12)).toHaveLength(12);
  });

  it('covers every category before repeating any', () => {
    // Four categories exist; a sample of four must contain one of each.
    expect(categoriesIn(sampleCases(corpus, 4)).size).toBe(4);
  });

  it('never drops a category from a reasonable sample', () => {
    for (const size of [4, 8, 16, 24]) {
      expect(categoriesIn(sampleCases(corpus, size)).size).toBe(4);
    }
  });

  it('does not simply take the head of the file', () => {
    // The corpus is grouped by category, so the first 12 are all he-rem.
    const sample = sampleCases(corpus, 12);
    expect(categoriesIn(sample).size).toBeGreaterThan(1);
  });

  it('is deterministic, so two runs are comparable', () => {
    expect(sampleCases(corpus, 15).map((c) => c.id)).toEqual(
      sampleCases(corpus, 15).map((c) => c.id),
    );
  });

  it('spreads evenly when the size divides across categories', () => {
    const counts = new Map<string, number>();
    for (const c of sampleCases(corpus, 8)) {
      const key = c.id.replace(/-\d+$/, '');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
  });

  it('handles a corpus with a single category', () => {
    const single = corpus.filter((c) => c.id.startsWith('he-rem'));
    expect(sampleCases(single, 5)).toHaveLength(5);
  });

  it('handles an empty corpus without throwing', () => {
    expect(sampleCases([], 10)).toEqual([]);
  });
});

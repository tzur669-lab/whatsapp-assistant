/**
 * The write gate's fingerprint (PLAN §6.19, 2026-10-06): a model that may write
 * was evaluated in the environment the bot runs now.
 */
import { describe, expect, it } from 'vitest';
import { MODELS, SMART_MODELS } from '../../../src/agent/models.js';
import { fingerprintFor, judgingHash, judgingHashOf, judgingParts, smartFingerprintFor } from '../../evals/fingerprint.js';

describe('the eval fingerprint', () => {
  it('matches for every backup that may write', () => {
    for (const entry of MODELS.filter((e) => e.canWrite && e.role === 'backup')) {
      expect(entry.evaluated?.fingerprint, `${entry.id}: run pnpm eval:agent --model ${entry.id} --select-tools`).toBe(fingerprintFor(entry));
    }
  });

  it("matches for the primary once it has one; until then, says so", () => {
    for (const entry of MODELS.filter((e) => e.role === 'primary')) {
      if (entry.evaluated) {
        expect(entry.evaluated.fingerprint, `${entry.id}: evaluated in another environment`).toBe(fingerprintFor(entry));
      } else {
        process.stderr.write(`note: ${entry.id} has no --select-tools eval yet (fingerprint ${fingerprintFor(entry)})\n`);
      }
    }
  });

  it('changes when what is offered changes', () => {
    const entry = MODELS[0]!;
    expect(fingerprintFor({ ...entry, maxCompletionTokens: entry.maxCompletionTokens + 1 })).not.toBe(fingerprintFor(entry));
    expect(fingerprintFor({ ...entry, params: {} })).not.toBe(fingerprintFor(entry));
  });

  it('is unchanged for the Groq models by smart conversations (2026-10-08)', () => {
    // Pinned before slice 4: the smart note and the smart catalog live in a
    // fingerprint of their own, so a Groq eval stays valid. Re-pinned
    // 2026-10-12, one value per model, when the model's identity joined the
    // hash; no entry had recorded `evaluated`, so nothing recorded moved.
    // Re-pinned 2026-10-12 for the calendar's past reads (catalog and cases).
    // Re-pinned 2026-10-13 for block J2b: the brief catalog joined the hash.
    const pinned: Record<string, string> = { 'qwen/qwen3.8-27b': '8f90bbe3301a443e', 'openai/gpt-oss-120b': 'def28efe991df92c' };
    for (const entry of MODELS) expect(fingerprintFor(entry), entry.id).toBe(pinned[entry.id]);
  });

  it("changes with the model's identity (2026-10-12)", () => {
    // Another model under the same entry was never judged.
    const entry = MODELS[0]!;
    expect(fingerprintFor({ ...entry, id: `${entry.id}-other` })).not.toBe(fingerprintFor(entry));
    expect(fingerprintFor({ ...entry, provider: 'gemini' })).not.toBe(fingerprintFor(entry));
    const gemini = SMART_MODELS[0]!;
    expect(smartFingerprintFor({ ...gemini, id: `${gemini.id}-other` })).not.toBe(smartFingerprintFor(gemini));
    expect(smartFingerprintFor({ ...gemini, provider: 'groq' })).not.toBe(smartFingerprintFor(gemini));
  });

  it('pins a smart model to the smart note and the smart catalog policy', () => {
    const gemini = SMART_MODELS[0]!;
    const smart = smartFingerprintFor(gemini);
    expect(smart).toMatch(/^[0-9a-f]{16}$/);
    expect(smart).not.toBe(fingerprintFor(gemini));
    expect(smartFingerprintFor({ ...gemini, maxCompletionTokens: gemini.maxCompletionTokens + 1 })).not.toBe(smart);
    // Its reasoning effort is part of the request it was judged on (2026-10-08).
    expect(smartFingerprintFor({ ...gemini, params: {} })).not.toBe(smart);
  });

  it('matches for every smart model that may write', () => {
    for (const entry of SMART_MODELS.filter((e) => e.canWrite)) {
      expect(entry.evaluated?.fingerprint, `${entry.id}: run pnpm eval:agent --model ${entry.id}`).toBe(smartFingerprintFor(entry));
    }
  });

  it('judges every evaluated model by the current expectations, scoring and thresholds (2026-10-12)', () => {
    const current = judgingHash();
    for (const entry of [...MODELS, ...SMART_MODELS].filter((e) => e.evaluated)) {
      expect(
        entry.evaluated?.judging,
        `${entry.id}: the judging changed since its eval. Re-score for free with ` +
          `pnpm eval:agent --model ${entry.id}${entry.role === 'smart' ? '' : ' --select-tools'} --report --resume; ` +
          `if it still passes, set evaluated.judging to ${current} in src/agent/models.ts`,
      ).toBe(current);
    }
  });

  it('moves the judging hash with a threshold or an expectation, not with line endings', () => {
    const parts = judgingParts();
    const base = judgingHashOf(parts);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    const scoring = parts.sources.map((source) => source.replace('toolChoice: 0.97', 'toolChoice: 0.98'));
    expect(scoring).not.toEqual(parts.sources);
    expect(judgingHashOf({ ...parts, sources: scoring })).not.toBe(base);
    const [first, ...rest] = parts.expects;
    expect(judgingHashOf({ ...parts, expects: [{ ...first!, expect: { intent: 'other' } }, ...rest] })).not.toBe(base);
    // A checkout with CRLF judges exactly like one with LF.
    expect(judgingHashOf({ ...parts, sources: parts.sources.map((s) => s.replace(/\r?\n/g, '\r\n')) })).toBe(base);
  });
});

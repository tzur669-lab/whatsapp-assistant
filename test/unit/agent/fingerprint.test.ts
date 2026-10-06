/**
 * The write gate's fingerprint (PLAN §8, 2026-10-06): a model that may write
 * was evaluated in the environment the bot runs now.
 */
import { describe, expect, it } from 'vitest';
import { MODELS } from '../../../src/agent/models.js';
import { fingerprintFor } from '../../evals/fingerprint.js';

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
});

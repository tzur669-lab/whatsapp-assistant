/**
 * The write gate's fingerprint (PLAN §6.19, 2026-10-06): a model that may write
 * was evaluated in the environment the bot runs now.
 */
import { describe, expect, it } from 'vitest';
import { MODELS, SMART_MODELS } from '../../../src/agent/models.js';
import { fingerprintFor, smartFingerprintFor } from '../../evals/fingerprint.js';

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
    // fingerprint of their own, so a Groq eval stays valid.
    for (const entry of MODELS) expect(fingerprintFor(entry), entry.id).toBe('ec8897b5e26d0c57');
  });

  it('pins a smart model to the smart note and the smart catalog policy', () => {
    const gemini = SMART_MODELS[0]!;
    const smart = smartFingerprintFor(gemini);
    expect(smart).toMatch(/^[0-9a-f]{16}$/);
    expect(smart).not.toBe(fingerprintFor(gemini));
    expect(smartFingerprintFor({ ...gemini, maxCompletionTokens: gemini.maxCompletionTokens + 1 })).not.toBe(smart);
  });

  it('matches for every smart model that may write', () => {
    for (const entry of SMART_MODELS.filter((e) => e.canWrite)) {
      expect(entry.evaluated?.fingerprint, `${entry.id}: run pnpm eval:agent --model ${entry.id}`).toBe(smartFingerprintFor(entry));
    }
  });
});

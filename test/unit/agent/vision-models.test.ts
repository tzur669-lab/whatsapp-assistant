/**
 * The image readers' models (PLAN §6.32): Gemini, in every conversation (the
 * user's decision, 2026-10-14: the Groq key has no vision model), and never
 * Gemini 3.5 Flash, whose 20 a day are the screen agent's.
 */
import { describe, expect, it } from 'vitest';
import { GEMINI_FLASH, MODELS, modelEntry, VISION_MODELS } from '../../../src/agent/models.js';

describe('vision models', () => {
  it('reads with Gemini only, each with its own entry', () => {
    expect(VISION_MODELS.length).toBeGreaterThan(0);
    for (const id of VISION_MODELS) expect(modelEntry(id)?.provider, id).toBe('gemini');
  });

  it('never a model of the local chat table', () => {
    const local = new Set(MODELS.map((entry) => entry.id));
    for (const id of VISION_MODELS) expect(local.has(id), id).toBe(false);
  });

  it("leaves Gemini 3.5 Flash to the screen agent: its 20 a day are not the reader's", () => {
    expect(VISION_MODELS).not.toContain(GEMINI_FLASH);
  });

  it('pins versioned ids, no -latest aliases', () => {
    for (const id of VISION_MODELS) expect(id).not.toMatch(/latest/);
  });
});

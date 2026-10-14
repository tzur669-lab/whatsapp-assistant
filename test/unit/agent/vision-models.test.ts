/**
 * The image readers' models (PLAN §6.32; the user's decision, 2026-10-14):
 * a regular conversation's image reaches Groq only, a smart one's Gemini only,
 * and no vision-only model ever runs a chat turn or a screen step.
 */
import { describe, expect, it } from 'vitest';
import {
  GEMINI_FLASH,
  MODELS,
  modelEntry,
  SCREEN_MODELS,
  SCREEN_SMART_MODELS,
  SMART_MODELS,
  VISION_MODELS,
  VISION_ONLY_MODELS,
  VISION_SMART_MODELS,
} from '../../../src/agent/models.js';

describe('vision models', () => {
  it('keeps the two families apart', () => {
    for (const id of VISION_MODELS) expect(modelEntry(id)?.provider, id).toBe('groq');
    for (const id of VISION_SMART_MODELS) expect(modelEntry(id)?.provider, id).toBe('gemini');
    expect(VISION_MODELS.filter((id) => VISION_SMART_MODELS.includes(id))).toEqual([]);
  });

  it('gives every vision model its own entry, never the 8K default', () => {
    for (const id of [...VISION_MODELS, ...VISION_SMART_MODELS]) expect(modelEntry(id), id).toBeDefined();
  });

  it('never lets a vision-only model run a chat turn or a screen step', () => {
    const elsewhere = new Set([...MODELS, ...SMART_MODELS].map((entry) => entry.id).concat(SCREEN_MODELS, SCREEN_SMART_MODELS));
    for (const entry of VISION_ONLY_MODELS) {
      expect(elsewhere.has(entry.id), entry.id).toBe(false);
      expect(entry.canWrite).toBe(false);
    }
  });

  it('leaves Gemini 3.5 Flash to the screen agent: its 20 a day are not the reader\'s', () => {
    expect(VISION_SMART_MODELS).not.toContain(GEMINI_FLASH);
  });

  it('pins versioned ids, no -latest aliases', () => {
    for (const id of [...VISION_MODELS, ...VISION_SMART_MODELS]) expect(id).not.toMatch(/latest/);
  });
});

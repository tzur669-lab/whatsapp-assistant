/**
 * Assembles the NLU chain from configuration (PLAN §6.2, "Fallback chain").
 *
 * Order is primary model -> secondary model -> deterministic rules. The two
 * model slots are separate settings so the Phase 3 eval result decides which is
 * which, and so a model can be swapped without touching code.
 */
import type { NluProvider } from './provider.js';
import { createGroqProvider } from './groq.js';
import { createRulesProvider } from './rules-fallback.js';

/**
 * Chosen by measurement — PLAN §4, decided 2026-09-27. qwen met every §11.2 accuracy
 * threshold on prompt v5; gpt-oss-120b could not be measured to the end inside
 * the free tier's daily budget, and per §4 the other model is the fallback.
 */
export const PRIMARY_MODEL = 'qwen/qwen3.8-27b';
export const SECONDARY_MODEL = 'openai/gpt-oss-120b';

export function buildNluChain(config: {
  groqApiKey: string;
  primaryModel?: string;
  secondaryModel?: string;
  fetchImpl?: typeof fetch;
}): NluProvider[] {
  const providers: NluProvider[] = [];

  if (config.groqApiKey) {
    const base = { apiKey: config.groqApiKey, ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}) };
    providers.push(createGroqProvider({ ...base, model: config.primaryModel ?? PRIMARY_MODEL }));
    providers.push(createGroqProvider({ ...base, model: config.secondaryModel ?? SECONDARY_MODEL }));
  }

  // Always last, and always present: with no key and no network the common
  // phrasings still parse rather than the bot going silent.
  providers.push(createRulesProvider());

  return providers;
}

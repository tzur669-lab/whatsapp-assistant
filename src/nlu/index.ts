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

/** Chosen by eval; see PLAN §14. */
export const PRIMARY_MODEL = 'openai/gpt-oss-120b';
export const SECONDARY_MODEL = 'openai/gpt-oss-20b';

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

/**
 * The NLU provider contract and the fallback chain (PLAN §6.2).
 *
 * `draft` is `unknown` on purpose. Nothing downstream may touch it before it has
 * passed `validateIntentDraft` (CLAUDE.md invariant 3).
 */
import type { PromptInput } from './prompt.js';
import type { IntentDraft } from './intent-schema.js';
import { validateIntentDraft } from './intent-schema.js';
import type { Logger } from '../security/redact.js';

export type Usage = {
  promptTokens: number;
  completionTokens: number;
  /**
   * Prompt tokens served from the provider's cache. Groq does not count these
   * toward the free tier's rate limits (PLAN §2), so this is what decides
   * whether the system prompt's size is a real throughput ceiling.
   */
  cachedTokens: number;
};

export type NluErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_json'
  | 'network_error'
  | 'schema_invalid'
  | 'not_configured';

export type NluError = {
  code: NluErrorCode;
  status?: number;
  /**
   * The provider's `retry-after`, in seconds. On Groq a value of minutes rather
   * than seconds means the daily token budget is gone, not the per-minute one —
   * the only safe signal for that, since the daily counter is absent from the
   * rate-limit headers and reading the error body is not allowed (PLAN §2).
   */
  retryAfterSeconds?: number;
};

export type NluResponse =
  | { ok: true; draft: unknown; usage: Usage }
  | { ok: false; error: NluError };

export interface NluProvider {
  readonly name: string;
  parse(input: PromptInput): Promise<NluResponse>;
}

export type NluOutcome =
  | { ok: true; draft: IntentDraft; provider: string; attempts: number }
  | { ok: false; errorCode: NluErrorCode | 'all_providers_failed'; attempts: number };

/**
 * Try each provider in order until one returns a draft that passes the schema.
 *
 * A provider that answers with something malformed is treated the same as one
 * that fails outright: the chain moves on. Nothing is ever executed on a partial
 * parse (PLAN §6.2, "Fallback chain").
 */
export async function parseWithFallback(
  providers: readonly NluProvider[],
  input: PromptInput,
  log: Logger,
): Promise<NluOutcome> {
  let attempts = 0;
  let lastError: NluErrorCode = 'not_configured';

  for (const provider of providers) {
    attempts++;
    const started = Date.now();

    let response: NluResponse;
    try {
      response = await provider.parse(input);
    } catch {
      // A provider must not be able to take the request down with it.
      response = { ok: false, error: { code: 'provider_error' } };
    }

    if (!response.ok) {
      lastError = response.error.code;
      log.warn('nlu_provider_failed', {
        provider: provider.name,
        errorCode: response.error.code,
        status: response.error.status,
        latencyMs: Date.now() - started,
      });
      continue;
    }

    const validated = validateIntentDraft(response.draft);
    if (!validated.ok) {
      lastError = 'schema_invalid';
      // Issue paths only. The values would echo the user's own words.
      log.warn('nlu_schema_rejected', {
        provider: provider.name,
        errorCode: 'schema_invalid',
        issues: validated.issues,
        latencyMs: Date.now() - started,
      });
      continue;
    }

    log.info('nlu_parsed', {
      provider: provider.name,
      intent: validated.draft.intent,
      missingCount: validated.draft.missing.length,
      ambiguityCount: validated.draft.ambiguities.length,
      latencyMs: Date.now() - started,
      promptTokens: response.usage.promptTokens,
      completionTokens: response.usage.completionTokens,
    });

    return { ok: true, draft: validated.draft, provider: provider.name, attempts };
  }

  log.warn('nlu_exhausted', { errorCode: lastError, attempts });
  return { ok: false, errorCode: attempts === 0 ? 'not_configured' : lastError, attempts };
}

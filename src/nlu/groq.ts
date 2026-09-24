/**
 * Groq NLU provider (PLAN §4, §6.2).
 *
 * Settings are fixed by the plan: temperature 0, JSON-object response format,
 * low reasoning effort, an 8 second timeout, and exactly one repair retry when
 * the body is not parseable JSON. Failures are returned, never thrown.
 */
import type { NluProvider, NluResponse } from './provider.js';
import { buildPrompt } from './prompt.js';
import type { PromptInput } from './prompt.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 8_000;
const MAX_COMPLETION_TOKENS = 512;

export type GroqConfig = {
  apiKey: string;
  model: string;
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
};

export function createGroqProvider(config: GroqConfig): NluProvider {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    name: `groq:${config.model}`,

    async parse(input: PromptInput): Promise<NluResponse> {
      if (!config.apiKey) return { ok: false, error: { code: 'not_configured' } };

      const { system, user } = buildPrompt(input);

      // One repair retry: an otherwise-good model occasionally wraps the object
      // in prose. A second failure means fall through to the next provider.
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await callOnce(doFetch, config, system, user, attempt > 0);
        if (result.ok || result.error.code !== 'invalid_json') return result;
      }

      return { ok: false, error: { code: 'invalid_json' } };
    },
  };
}

async function callOnce(
  doFetch: typeof fetch,
  config: GroqConfig,
  system: string,
  user: string,
  isRepair: boolean,
): Promise<NluResponse> {
  const body = {
    model: config.model,
    temperature: 0,
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    reasoning_effort: 'low',
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: isRepair ? `${user}\n\nYour previous reply was not valid JSON. Reply with the JSON object only.` : user,
      },
    ],
  };

  let response: Response;
  try {
    response = await doFetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, error: { code: timedOut ? 'timeout' : 'provider_error' } };
  }

  if (response.status === 429) {
    // Header only. The body carries the quota detail but may quote the request,
    // so it is never read (CLAUDE.md, Secrets and privacy).
    const retryAfter = Number(response.headers.get('retry-after'));
    return {
      ok: false,
      error: {
        code: 'rate_limited',
        status: 429,
        ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      },
    };
  }
  if (!response.ok) {
    // The body may quote the prompt back, so it is not read or logged.
    return { ok: false, error: { code: 'provider_error', status: response.status } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: { code: 'invalid_json' } };
  }

  const content = contentOf(payload);
  if (content === null) return { ok: false, error: { code: 'invalid_json' } };

  let draft: unknown;
  try {
    draft = JSON.parse(stripFences(content));
  } catch {
    return { ok: false, error: { code: 'invalid_json' } };
  }

  return { ok: true, draft, usage: usageOf(payload) };
}

function contentOf(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const content = (choices[0] as { message?: { content?: unknown } })?.message?.content;
  return typeof content === 'string' && content.length > 0 ? content : null;
}

function usageOf(payload: unknown): {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
} {
  const usage = (payload as {
    usage?: {
      prompt_tokens?: unknown;
      completion_tokens?: unknown;
      prompt_tokens_details?: { cached_tokens?: unknown };
    };
  }).usage;

  const cached = usage?.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
    cachedTokens: typeof cached === 'number' ? cached : 0,
  };
}

/** Some models wrap JSON in a fence despite the response format. */
function stripFences(content: string): string {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(content);
  return fenced?.[1] ?? content;
}

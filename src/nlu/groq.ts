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
import { buildResponseSchema, stripNulls } from './json-schema.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const TIMEOUT_MS = 8_000;

/**
 * Reasoning tokens are drawn from this same budget on the gpt-oss models, and a
 * draft that runs out mid-object comes back as unparseable JSON. 512 was too
 * small: a schema-constrained reply plus its reasoning routinely exceeded it,
 * which showed up as invalid-JSON retries rather than as the truncation it was.
 */
const MAX_COMPLETION_TOKENS = 2_048;

/**
 * `strict: true`. Non-strict was measured and does not actually enforce the
 * schema — a model asked for `reminders.list` with no range answered
 * `range: "unspecified"`, a value absent from the enum. Strict mode enforces it,
 * at the cost of requiring every key to be present; an absent slot arrives as
 * `null` and `stripNulls` reconciles that with Zod.
 */
const RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'intent_draft', strict: true, schema: buildResponseSchema() },
} as const;

export type GroqConfig = {
  apiKey: string;
  model: string;
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
  /**
   * Override the request timeout.
   *
   * Production keeps the 8 seconds below, and should: a user waiting longer
   * than that for a reply has already had a bad experience, and the fallback
   * chain exists precisely so a slow model is not waited on.
   *
   * The **eval** raises it, because there the timeout answers the wrong
   * question. A run that cuts a model off is measuring how fast it is, which
   * §11.2 already has a separate threshold for — and reporting the cut-off
   * cases as parse failures makes the accuracy number meaningless. Measure
   * accuracy and latency separately, then decide (PLAN §13).
   */
  timeoutMs?: number;
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
    response_format: RESPONSE_FORMAT,
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
      signal: AbortSignal.timeout(config.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    // A failure to connect is a network fault, not a slow model. Counting the
    // two together made the provider look slower than it is.
    const name = error instanceof Error ? error.name : '';
    const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code ?? '';
    // A timeout is the model being slow; everything else here is the connection
    // never working, and which fault it was is the whole diagnosis. The code
    // travels, the message does not.
    const timedOut =
      cause === '' && (name === 'TimeoutError' || name === 'AbortError');
    return {
      ok: false,
      error: {
        code: timedOut ? 'timeout' : 'network_error',
        ...(cause === '' ? {} : { cause }),
      },
    };
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
    // Under a structured-output schema an absent slot comes back as null rather
    // than as an omitted key; Zod models absence as omission (PLAN §6.2).
    draft = stripNulls(JSON.parse(stripFences(content)));
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

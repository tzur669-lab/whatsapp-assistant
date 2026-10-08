/**
 * The agent's model call: Groq chat completions with tools (PLAN §6.19), and
 * Gemini's OpenAI-compatible endpoint (smart conversations, 2026-10-08).
 *
 * The same rules as the parser's provider (`src/nlu/groq.ts`): failures are
 * returned, never thrown; an error body is never read, because it may quote the
 * prompt back; a 429 is classified from its `retry-after` header alone.
 *
 * One documented exception (PLAN §7, 2026-10-08): a **Gemini 429** body is
 * read, at most `RATE_LIMIT_BODY_MAX_BYTES` of it, and only two values survive
 * — `error.status` when it is an enum-like word, and whether any quota id
 * names a day (`PerDay`). Everything else is dropped on the spot: never
 * logged, never returned, never kept. A body that is malformed, unfamiliar or
 * too big is simply "not daily": the budget's backoff does not depend on it.
 *
 * What comes back is untrusted. Tool-call arguments are a string the loop parses
 * and validates with the tool's strict Zod schema; text is display-only.
 */
import type { NluError } from '../nlu/provider.js';
import type { ModelRole } from './models.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const TIMEOUT_MS = 12_000;

/** Reasoning tokens count against this too on the gpt-oss models. */
const MAX_COMPLETION_TOKENS = 1_024;

/**
 * Bumped by hand whenever what this adapter puts on the wire changes. It is
 * part of the eval fingerprint (PLAN §6.19): a model judged on one translation is not
 * silently trusted with another.
 */
export const ADAPTER_VERSION = 'openai-compatible/1';

export type ToolCall = { id: string; name: string; arguments: string };

export type AgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

type WireToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type WireTool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** Zero for both when the answer carried no usage: the budget then charges the reservation. */
export type AgentUsage = { promptTokens: number; completionTokens: number; cachedTokens?: number };

export type AgentResponse =
  | { ok: true; text: string | null; toolCalls: ToolCall[]; usage: AgentUsage }
  | { ok: false; error: NluError };

export interface AgentProvider {
  readonly model: string;
  /**
   * From the model table. Anything but `primary` (`backup`, `smart`, or none)
   * is treated as a backup: its writes always confirm (§6).
   */
  readonly role?: ModelRole;
  /** What the request asks for, and so what is reserved before it is sent. */
  readonly maxCompletionTokens?: number;
  /** An empty tool list means a text-only call: no `tools`, no `tool_choice` on the wire. */
  complete(messages: readonly AgentMessage[], tools: readonly WireTool[]): Promise<AgentResponse>;
}

export type AgentProviderConfig = {
  apiKey: string;
  model: string;
  role?: ModelRole;
  maxCompletionTokens?: number;
  /** Sent only when present. Defaults to today's `reasoning_effort: low`. */
  params?: { reasoningEffort?: 'low' };
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** How one OpenAI-compatible endpoint differs on the wire. */
type Transport = {
  endpoint: string;
  /** The completion-size field this endpoint documents. Default `max_completion_tokens`. */
  completionField?: 'max_completion_tokens' | 'max_tokens';
  /** Gemini only: read a 429's body, narrowly (header comment). */
  classifyRateLimitBody?: boolean;
};

/** An OpenAI-compatible chat endpoint: a transport, nothing about how a model behaves. */
export function createOpenAiCompatibleAgentProvider(config: AgentProviderConfig & Transport): AgentProvider {
  const doFetch = config.fetchImpl ?? fetch;
  const maxCompletionTokens = config.maxCompletionTokens ?? MAX_COMPLETION_TOKENS;
  const params = config.params ?? { reasoningEffort: 'low' };
  const completionField = config.completionField ?? 'max_completion_tokens';

  return {
    model: config.model,
    ...(config.role ? { role: config.role } : {}),
    maxCompletionTokens,

    async complete(messages, tools): Promise<AgentResponse> {
      if (!config.apiKey) return { ok: false, error: { code: 'not_configured' } };

      let response: Response;
      try {
        response = await doFetch(config.endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            [completionField]: maxCompletionTokens,
            ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
            // A text-only call carries neither: an empty list is a 400 on
            // OpenAI-compatible endpoints.
            ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
            messages,
          }),
          signal: AbortSignal.timeout(config.timeoutMs ?? TIMEOUT_MS),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        const cause = (error as { cause?: { code?: string } } | undefined)?.cause?.code ?? '';
        const timedOut = cause === '' && (name === 'TimeoutError' || name === 'AbortError');
        return {
          ok: false,
          error: { code: timedOut ? 'timeout' : 'network_error', ...(cause === '' ? {} : { cause }) },
        };
      }

      if (response.status === 429) {
        // Header only: the body may quote the request (CLAUDE.md, Secrets and privacy).
        const retryAfter = Number(response.headers.get('retry-after'));
        // The one exception, Gemini only: two values from the body, nothing else.
        const quota = config.classifyRateLimitBody ? classifyGeminiRateLimit(await readJsonCapped(response)) : null;
        return {
          ok: false,
          error: {
            code: 'rate_limited',
            status: 429,
            ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
            ...(quota ? { daily: quota.daily, ...(quota.status ? { quotaStatus: quota.status } : {}) } : {}),
          },
        };
      }
      if (!response.ok) {
        return { ok: false, error: { code: 'provider_error', status: response.status } };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { ok: false, error: { code: 'invalid_json' } };
      }

      const message = messageOf(payload);
      if (message === null) return { ok: false, error: { code: 'invalid_json' } };
      return { ok: true, ...message, usage: usageOf(payload) };
    },
  };
}

export function createGroqAgentProvider(config: AgentProviderConfig): AgentProvider {
  return createOpenAiCompatibleAgentProvider({ ...config, endpoint: ENDPOINT });
}

/**
 * Gemini through its OpenAI-compatible endpoint (smart conversations,
 * 2026-10-08). It gets only the params its entry declares, never Groq's
 * default `reasoning_effort`, and `max_tokens`, the field Google documents.
 */
export function createGeminiAgentProvider(config: AgentProviderConfig): AgentProvider {
  return createOpenAiCompatibleAgentProvider({
    ...config,
    params: config.params ?? {},
    endpoint: GEMINI_ENDPOINT,
    completionField: 'max_tokens',
    classifyRateLimitBody: true,
  });
}

/** A Gemini 429 body is about 1 KB; anything past this is not read, and not daily. */
const RATE_LIMIT_BODY_MAX_BYTES = 16 * 1024;
/** How many details and violations are looked at, at most. */
const RATE_LIMIT_MAX_ITEMS = 20;
const QUOTA_STATUS = /^[A-Z_]{1,40}$/;

/** The body as JSON, or undefined when it is missing, too big, or not JSON. Never thrown, never kept. */
async function readJsonCapped(response: Response): Promise<unknown> {
  const body = response.body;
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RATE_LIMIT_BODY_MAX_BYTES) {
        reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => typeof value === 'object' && value !== null && !Array.isArray(value);
const itemsOf = (value: unknown): unknown[] => (Array.isArray(value) ? value.slice(0, RATE_LIMIT_MAX_ITEMS) : []);

/**
 * What a Gemini 429 body may tell the budget, and nothing more: its status
 * when enum-like, and whether a quota id names a day. Accepts the object and
 * the array-wrapped form; anything else is "not daily".
 */
export function classifyGeminiRateLimit(payload: unknown): { status?: string; daily: boolean } {
  const root: unknown = Array.isArray(payload) ? payload[0] : payload;
  const error = isFields(root) ? root['error'] : undefined;
  if (!isFields(error)) return { daily: false };

  const rawStatus = error['status'];
  const status = typeof rawStatus === 'string' && QUOTA_STATUS.test(rawStatus) ? rawStatus : undefined;
  let daily = false;
  for (const detail of itemsOf(error['details'])) {
    if (!isFields(detail)) continue;
    for (const violation of itemsOf(detail['violations'])) {
      const quotaId = isFields(violation) ? violation['quotaId'] : undefined;
      if (typeof quotaId === 'string' && quotaId.includes('PerDay')) daily = true;
    }
  }
  return { ...(status ? { status } : {}), daily };
}

function messageOf(payload: unknown): { text: string | null; toolCalls: ToolCall[] } | null {
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;

  const content = (message as { content?: unknown }).content;
  const rawCalls = (message as { tool_calls?: unknown }).tool_calls;

  const toolCalls: ToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    for (const raw of rawCalls) {
      const id = (raw as { id?: unknown }).id;
      const fn = (raw as { function?: { name?: unknown; arguments?: unknown } }).function;
      if (typeof id !== 'string' || typeof fn?.name !== 'string') continue;
      toolCalls.push({
        id,
        name: fn.name,
        arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
      });
    }
  }

  const text = typeof content === 'string' && content.trim().length > 0 ? content : null;
  if (text === null && toolCalls.length === 0) return null;
  return { text, toolCalls };
}

function usageOf(payload: unknown): AgentUsage {
  const usage = (payload as {
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  }).usage;
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
    // For the log only: the budget charges the full count (§2).
    ...(typeof cached === 'number' ? { cachedTokens: cached } : {}),
  };
}

/** The wire form of a tool call the loop sends back with its result. */
export function wireToolCall(call: ToolCall): WireToolCall {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
}

/**
 * The agent's model call: Groq chat completions with tools (PLAN §6.19).
 *
 * The same rules as the parser's provider (`src/nlu/groq.ts`): failures are
 * returned, never thrown; an error body is never read, because it may quote the
 * prompt back; a 429 is classified from its `retry-after` header alone.
 *
 * What comes back is untrusted. Tool-call arguments are a string the loop parses
 * and validates with the tool's strict Zod schema; text is display-only.
 */
import type { NluError } from '../nlu/provider.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
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
   * `primary` or `backup`, from the model table. A provider without one is
   * treated as a backup: its writes always confirm (§6).
   */
  readonly role?: 'primary' | 'backup';
  /** What the request asks for, and so what is reserved before it is sent. */
  readonly maxCompletionTokens?: number;
  /** An empty tool list means a text-only call: no `tools`, no `tool_choice` on the wire. */
  complete(messages: readonly AgentMessage[], tools: readonly WireTool[]): Promise<AgentResponse>;
}

export type AgentProviderConfig = {
  apiKey: string;
  model: string;
  role?: 'primary' | 'backup';
  maxCompletionTokens?: number;
  /** Sent only when present. Defaults to today's `reasoning_effort: low`. */
  params?: { reasoningEffort?: 'low' };
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/** An OpenAI-compatible chat endpoint: a transport, nothing about how a model behaves. */
export function createOpenAiCompatibleAgentProvider(
  config: AgentProviderConfig & { endpoint: string },
): AgentProvider {
  const doFetch = config.fetchImpl ?? fetch;
  const maxCompletionTokens = config.maxCompletionTokens ?? MAX_COMPLETION_TOKENS;
  const params = config.params ?? { reasoningEffort: 'low' };

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
            max_completion_tokens: maxCompletionTokens,
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

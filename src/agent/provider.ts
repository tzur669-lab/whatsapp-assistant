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

export type AgentUsage = { promptTokens: number; completionTokens: number };

export type AgentResponse =
  | { ok: true; text: string | null; toolCalls: ToolCall[]; usage: AgentUsage }
  | { ok: false; error: NluError };

export interface AgentProvider {
  readonly model: string;
  complete(messages: readonly AgentMessage[], tools: readonly WireTool[]): Promise<AgentResponse>;
}

export type AgentProviderConfig = {
  apiKey: string;
  model: string;
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createGroqAgentProvider(config: AgentProviderConfig): AgentProvider {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    model: config.model,

    async complete(messages, tools): Promise<AgentResponse> {
      if (!config.apiKey) return { ok: false, error: { code: 'not_configured' } };

      let response: Response;
      try {
        response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: config.model,
            temperature: 0,
            max_completion_tokens: MAX_COMPLETION_TOKENS,
            reasoning_effort: 'low',
            tools,
            tool_choice: 'auto',
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
  const usage = (payload as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } }).usage;
  return {
    promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
    completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : 0,
  };
}

/** The wire form of a tool call the loop sends back with its result. */
export function wireToolCall(call: ToolCall): WireToolCall {
  return { id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } };
}

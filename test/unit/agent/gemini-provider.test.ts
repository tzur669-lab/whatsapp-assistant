/**
 * Gemini as a provider and a model (smart conversations, slice 2). Nothing
 * routes a turn to it yet: these hold the transport, the narrow 429 body
 * exception (provider.ts header) and the model table.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyGeminiRateLimit,
  createGeminiAgentProvider,
  createGroqAgentProvider,
  GEMINI_ENDPOINT,
} from '../../../src/agent/provider.js';
import type { WireTool } from '../../../src/agent/provider.js';
import { CHARS_PER_TOKEN } from '../../../src/agent/budget.js';
import { MAX_MODEL_CALLS } from '../../../src/agent/loop.js';
import { modelEntry, MODELS, SMART_MODELS } from '../../../src/agent/models.js';
import { workersFetch } from '../../integration/workers-fetch.js';

const FAKE_KEY = 'fake-gemini-key-not-real';
const GEMINI = SMART_MODELS[0]!;
const tool: WireTool = { type: 'function', function: { name: 'x', description: 'x', parameters: { type: 'object' } } };
const messages = [{ role: 'user' as const, content: 'hi' }];

type Seen = { url: string; headers: Headers; body: Record<string, unknown> };

function capture(answer: () => Response = ok) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return answer();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

function ok(): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function gemini(fetchImpl: typeof fetch) {
  return createGeminiAgentProvider({
    apiKey: FAKE_KEY,
    model: GEMINI.id,
    role: GEMINI.role,
    maxCompletionTokens: GEMINI.maxCompletionTokens,
    params: GEMINI.params,
    fetchImpl,
  });
}

/** A Google-shaped 429: what the quota is called, and a message that may quote the request. */
function quotaBody(quotaId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota. PROMPT-CANARY-7f3a quoted back',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'm', quotaId }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '36s' },
      ],
      ...extra,
    },
  });
}

const PER_DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
const PER_MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';

describe('Gemini agent provider', () => {
  it("posts to Gemini's OpenAI-compatible endpoint with the key as a bearer token", async () => {
    const { seen, fetchImpl } = capture();
    const response = await gemini(fetchImpl).complete(messages, [tool]);
    expect(response.ok).toBe(true);
    expect(seen[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(seen[0]!.url).toBe(GEMINI_ENDPOINT);
    expect(seen[0]!.headers.get('authorization')).toBe(`Bearer ${FAKE_KEY}`);
    expect(seen[0]!.body).toMatchObject({ model: GEMINI.id, tools: [tool], tool_choice: 'auto', messages });
  });

  it('sends only what its entry declares: no Groq reasoning effort, and its own completion size', async () => {
    const { seen, fetchImpl } = capture();
    await gemini(fetchImpl).complete(messages, []);
    const body = seen[0]!.body;
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body['max_tokens']).toBe(GEMINI.maxCompletionTokens);
  });

  it('sends no reasoning effort even when built without params', async () => {
    const { seen, fetchImpl } = capture();
    await createGeminiAgentProvider({ apiKey: FAKE_KEY, model: GEMINI.id, fetchImpl }).complete(messages, []);
    expect(seen[0]!.body).not.toHaveProperty('reasoning_effort');
  });

  it('is not configured without a key, and sends nothing', async () => {
    const { seen, fetchImpl } = capture();
    const response = await createGeminiAgentProvider({ apiKey: '', model: GEMINI.id, fetchImpl }).complete(messages, []);
    expect(response).toEqual({ ok: false, error: { code: 'not_configured' } });
    expect(seen).toHaveLength(0);
  });

  it('calls fetch through a closure, as Workers requires', async () => {
    const { fetchImpl } = capture();
    const response = await gemini(workersFetch(fetchImpl)).complete(messages, []);
    expect(response.ok).toBe(true);
  });

  it('keeps the role from the table: smart, never primary', () => {
    expect(gemini(capture().fetchImpl).role).toBe('smart');
  });

  describe('a 429: the one body it reads', () => {
    const refuse = (body: BodyInit, headers: Record<string, string> = {}) => () =>
      new Response(body, { status: 429, headers: { 'content-type': 'application/json', ...headers } });

    it('marks a per-day quota as daily, and keeps the status', async () => {
      const response = await gemini(capture(refuse(quotaBody(PER_DAY))).fetchImpl).complete(messages, []);
      expect(response).toEqual({
        ok: false,
        error: { code: 'rate_limited', status: 429, daily: true, quotaStatus: 'RESOURCE_EXHAUSTED' },
      });
    });

    it('marks a per-minute quota as not daily', async () => {
      const response = await gemini(capture(refuse(quotaBody(PER_MINUTE))).fetchImpl).complete(messages, []);
      expect(response.ok === false && response.error).toMatchObject({ code: 'rate_limited', daily: false });
    });

    it('reads the array-wrapped form too', async () => {
      const response = await gemini(capture(refuse(`[${quotaBody(PER_DAY)}]`)).fetchImpl).complete(messages, []);
      expect(response.ok === false && response.error.daily).toBe(true);
    });

    it('respects retry-after', async () => {
      const response = await gemini(capture(refuse(quotaBody(PER_MINUTE), { 'retry-after': '42' })).fetchImpl).complete(
        messages,
        [],
      );
      expect(response.ok === false && response.error.retryAfterSeconds).toBe(42);
    });

    it('is still a rate limit, not daily, when the body is malformed, empty or unfamiliar', async () => {
      for (const body of ['not json {', '', '{"error":"x"}', '{"unexpected":[1,2,3]}', 'null']) {
        const response = await gemini(capture(refuse(body)).fetchImpl).complete(messages, []);
        expect(response).toEqual({ ok: false, error: { code: 'rate_limited', status: 429, daily: false } });
      }
    });

    it('stops reading a huge body and treats it as not daily', async () => {
      // Well-formed and per-day — but past the cap, so never parsed.
      const huge = JSON.stringify({
        error: { status: 'RESOURCE_EXHAUSTED', padding: 'x'.repeat(1_000_000), details: [{ violations: [{ quotaId: PER_DAY }] }] },
      });
      const response = await gemini(capture(refuse(huge)).fetchImpl).complete(messages, []);
      expect(response).toEqual({ ok: false, error: { code: 'rate_limited', status: 429, daily: false } });
    });

    it('drops a status that is not an enum-like word', async () => {
      for (const status of ['resource exhausted', 'X'.repeat(41), 'RESOURCE_EXHAUSTED<script>', 7]) {
        const body = JSON.stringify({ error: { status, details: [] } });
        const response = await gemini(capture(refuse(body)).fetchImpl).complete(messages, []);
        expect(response.ok === false && response.error).not.toHaveProperty('quotaStatus');
      }
    });

    it('never lets the body text into the error', async () => {
      const response = await gemini(capture(refuse(quotaBody(PER_DAY))).fetchImpl).complete(messages, []);
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain('PROMPT-CANARY');
      expect(serialized).not.toContain('exceeded');
      expect(serialized).not.toContain('PerDay');
      expect(serialized).not.toContain('36s');
    });

    it('classifies at most the status and a per-day flag', () => {
      expect(classifyGeminiRateLimit(JSON.parse(quotaBody(PER_DAY)))).toEqual({ status: 'RESOURCE_EXHAUSTED', daily: true });
      expect(classifyGeminiRateLimit(undefined)).toEqual({ daily: false });
      expect(classifyGeminiRateLimit({ error: { details: [{ violations: [{ quotaId: 42 }] }] } })).toEqual({ daily: false });
    });
  });

  it('reads no error body on any other status, nor on a Groq 429', async () => {
    for (const [build, status] of [
      [gemini, 500],
      [gemini, 400],
      [(f: typeof fetch) => createGroqAgentProvider({ apiKey: 'k', model: 'm', fetchImpl: f }), 429],
    ] as const) {
      let sent: Response | undefined;
      const fetchImpl = (async () => {
        sent = new Response(quotaBody(PER_DAY), { status });
        return sent;
      }) as typeof fetch;
      const response = await build(fetchImpl).complete(messages, []);
      expect(response.ok).toBe(false);
      expect(response.ok === false && response.error).not.toHaveProperty('daily');
      expect(sent!.bodyUsed).toBe(false);
    }
  });
});

describe('the smart model table', () => {
  it('finds Gemini by id, after the Groq table', () => {
    expect(modelEntry(GEMINI.id)).toBe(GEMINI);
    for (const entry of MODELS) expect(modelEntry(entry.id)).toBe(entry);
  });

  it('never overlaps the Groq table', () => {
    const groq = new Set(MODELS.map((entry) => entry.id));
    for (const entry of SMART_MODELS) expect(groq.has(entry.id)).toBe(false);
    for (const entry of MODELS) expect(entry.role).not.toBe('smart');
  });

  it('pins fully versioned Gemini ids that may not write until a human reads an eval', () => {
    expect(SMART_MODELS.length).toBeGreaterThan(0);
    expect(new Set(SMART_MODELS.map((entry) => entry.id)).size).toBe(SMART_MODELS.length);
    for (const entry of SMART_MODELS) {
      expect(entry.id).not.toMatch(/latest/i);
      expect(entry.provider).toBe('gemini');
      expect(entry.role).toBe('smart');
      expect(entry.canWrite).toBe(false);
      expect(entry.params).toEqual({});
      expect(entry.minuteRequests).toBeGreaterThan(0);
      expect(entry.dayRequests).toBeGreaterThan(0);
    }
  });

  it("keeps every Groq model exactly as before: today's call cap and estimate, no request limits", () => {
    for (const entry of MODELS) {
      expect(entry.provider).toBe('groq');
      expect(entry.maxModelCalls).toBe(MAX_MODEL_CALLS);
      expect(entry.charsPerToken).toBe(CHARS_PER_TOKEN);
      expect(entry.minuteRequests).toBeUndefined();
      expect(entry.dayRequests).toBeUndefined();
    }
  });
});

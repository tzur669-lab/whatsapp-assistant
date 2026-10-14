/**
 * The image reader (PLAN §6.32): one model call of the conversation's family,
 * a fixed prompt, no tools, and the text it read — capped, cleaned, and never
 * more than display text. Fake fetch only: no network.
 */
import { describe, expect, it } from 'vitest';
import { TokenBudget } from '../../../src/agent/budget.js';
import { GEMINI_FLASH_LITE, LLAMA_4_SCOUT } from '../../../src/agent/models.js';
import type { Logger } from '../../../src/security/redact.js';
import {
  cleanReadText,
  createImageReader,
  createVisionClient,
  NO_TEXT,
  VISION_RESERVE_TOKENS,
  VISION_SYSTEM_PROMPT,
  type VisionClient,
} from '../../../src/vision/read-image.js';
import { MAX_SHARED_CHARS } from '../../../src/channels/app/parse.js';

const NOW = Date.UTC(2026, 9, 14, 9, 0);
const IMAGE = { mimeType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRgABAQ==' };

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: init?.headers as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function answer(content: string | null, usage = { prompt_tokens: 900, completion_tokens: 120 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status: code, headers });
}

const lines: Array<{ level: string; event: string; fields: unknown }> = [];
const log: Logger = {
  debug: (event, fields) => lines.push({ level: 'debug', event, fields }),
  info: (event, fields) => lines.push({ level: 'info', event, fields }),
  warn: (event, fields) => lines.push({ level: 'warn', event, fields }),
  error: (event, fields) => lines.push({ level: 'error', event, fields }),
};

function client(model: string, provider: 'groq' | 'gemini', responses: Array<Response | Error>, apiKey = 'k') {
  const fake = fakeFetch(responses);
  return { client: createVisionClient({ model, provider, apiKey, fetchImpl: (...a) => fake.fetchImpl(...a) }), calls: fake.calls };
}

describe('createVisionClient', () => {
  it('sends the fixed prompt and the image as a data URI, nothing else', async () => {
    const { client: groq, calls } = client(LLAMA_4_SCOUT, 'groq', [answer('שלום')]);
    const result = await groq.call(IMAGE, AbortSignal.timeout(1_000));
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = calls[0]!.body;
    expect(body['model']).toBe(LLAMA_4_SCOUT);
    expect(body['tools']).toBeUndefined();
    expect(body['temperature']).toBe(0);
    const messages = body['messages'] as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ role: 'system', content: VISION_SYSTEM_PROMPT });
    const parts = messages[1]!.content as Array<Record<string, unknown>>;
    expect(parts.map((p) => p['type'])).toEqual(['text', 'image_url']);
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${IMAGE.data}` } });
  });

  it('uses Gemini\'s endpoint and `max_tokens` for a Gemini model', async () => {
    const { client: gemini, calls } = client(GEMINI_FLASH_LITE, 'gemini', [answer('x')]);
    await gemini.call(IMAGE, AbortSignal.timeout(1_000));
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(calls[0]!.body['max_tokens']).toBeTypeOf('number');
    expect(calls[0]!.body['max_completion_tokens']).toBeUndefined();
  });

  it('answers not_configured without a key, and sends nothing', async () => {
    const { client: groq, calls } = client(LLAMA_4_SCOUT, 'groq', [], '');
    const result = await groq.call(IMAGE, AbortSignal.timeout(1_000));
    expect(result).toEqual({ ok: false, error: { code: 'not_configured' } });
    expect(calls).toHaveLength(0);
  });

  it('reads a 429\'s retry-after, and a 503 as a provider error', async () => {
    const { client: groq } = client(LLAMA_4_SCOUT, 'groq', [status(429, { 'retry-after': '7' }), status(503)]);
    expect(await groq.call(IMAGE, AbortSignal.timeout(1_000))).toEqual({
      ok: false,
      error: { code: 'rate_limited', status: 429, retryAfterSeconds: 7 },
    });
    expect(await groq.call(IMAGE, AbortSignal.timeout(1_000))).toEqual({ ok: false, error: { code: 'provider_error', status: 503 } });
  });

  it('refuses an answer that is not the expected shape', async () => {
    const { client: groq } = client(LLAMA_4_SCOUT, 'groq', [new Response('{"nope":1}', { status: 200 })]);
    expect(await groq.call(IMAGE, AbortSignal.timeout(1_000))).toEqual({ ok: false, error: { code: 'invalid_json' } });
  });
});

describe('cleanReadText', () => {
  it('trims, drops control characters, keeps newlines', () => {
    expect(cleanReadText('  שורה\u0000 1\r\nשורה 2\u0007  ')).toBe('שורה 1\nשורה 2');
  });

  it('is null for nothing, or for the no-text marker', () => {
    expect(cleanReadText(null)).toBeNull();
    expect(cleanReadText('   ')).toBeNull();
    expect(cleanReadText(` ${NO_TEXT} `)).toBeNull();
    expect(cleanReadText(`${NO_TEXT}.`)).toBeNull();
  });

  it('caps at the shared-text limit, on a whole character', () => {
    const long = '😀'.repeat(MAX_SHARED_CHARS);
    const capped = cleanReadText(long)!;
    expect(capped.length).toBeLessThanOrEqual(MAX_SHARED_CHARS);
    expect(capped.length % 2).toBe(0);
  });
});

function reader(local: VisionClient[], smart: VisionClient[], budget = new TokenBudget(() => NOW)) {
  return { read: createImageReader({ local, smart, budget, log, now: () => NOW }).read, budget };
}

describe('createImageReader', () => {
  it('reads with the local family in a regular conversation', async () => {
    const groq = client(LLAMA_4_SCOUT, 'groq', [answer('פגישה ביום ראשון 10:00')]);
    const gemini = client(GEMINI_FLASH_LITE, 'gemini', [answer('never')]);
    const { read } = reader([groq.client], [gemini.client]);
    expect(await read({ mode: 'local', ...IMAGE })).toEqual({ status: 'ok', text: 'פגישה ביום ראשון 10:00' });
    expect(gemini.calls).toHaveLength(0);
  });

  it('reads with the smart family in a smart conversation, and never falls to Groq', async () => {
    const groq = client(LLAMA_4_SCOUT, 'groq', [answer('never')]);
    const gemini = client(GEMINI_FLASH_LITE, 'gemini', [status(503)]);
    const { read } = reader([groq.client], [gemini.client]);
    const result = await read({ mode: 'smart', ...IMAGE });
    expect(result.status).not.toBe('ok');
    expect(groq.calls).toHaveLength(0);
  });

  it('is not_configured when the family has no model', async () => {
    const groq = client(LLAMA_4_SCOUT, 'groq', [answer('never')]);
    const { read } = reader([groq.client], []);
    expect(await read({ mode: 'smart', ...IMAGE })).toEqual({ status: 'not_configured' });
    expect(groq.calls).toHaveLength(0);
  });

  it('moves to the next model of the family on a 429 or a failure', async () => {
    const first = client(GEMINI_FLASH_LITE, 'gemini', [status(429, { 'retry-after': '30' })]);
    const second = client('gemini-other', 'gemini', [answer('טקסט')]);
    const { read } = reader([], [first.client, second.client]);
    expect(await read({ mode: 'smart', ...IMAGE })).toEqual({ status: 'ok', text: 'טקסט' });
  });

  it('answers busy when the only model is rate limited, and rests it', async () => {
    const groq = client(LLAMA_4_SCOUT, 'groq', [status(429, { 'retry-after': '30' })]);
    const { read } = reader([groq.client], []);
    expect(await read({ mode: 'local', ...IMAGE })).toEqual({ status: 'busy' });
    // Rested: the next image does not call it at all.
    expect(await read({ mode: 'local', ...IMAGE })).toEqual({ status: 'busy' });
    expect(groq.calls).toHaveLength(1);
  });

  it('answers quota when the day is out', async () => {
    const groq = client(LLAMA_4_SCOUT, 'groq', [status(429, { 'retry-after': '7200' })]);
    const { read } = reader([groq.client], []);
    expect(await read({ mode: 'local', ...IMAGE })).toEqual({ status: 'quota' });
  });

  it('answers failed on a provider error, and unreadable on the marker', async () => {
    const broken = client(LLAMA_4_SCOUT, 'groq', [status(500)]);
    expect(await reader([broken.client], []).read({ mode: 'local', ...IMAGE })).toEqual({ status: 'failed' });
    const blank = client(LLAMA_4_SCOUT, 'groq', [answer(NO_TEXT)]);
    expect(await reader([blank.client], []).read({ mode: 'local', ...IMAGE })).toEqual({ status: 'unreadable' });
  });

  it('answers failed on a timeout', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const slow = client(LLAMA_4_SCOUT, 'groq', [timeout]);
    expect(await reader([slow.client], []).read({ mode: 'local', ...IMAGE })).toEqual({ status: 'failed' });
  });

  it('reserves before the call and settles with the measured usage', async () => {
    const groq = client(LLAMA_4_SCOUT, 'groq', [answer('x', { prompt_tokens: 1_000, completion_tokens: 50 })]);
    const { read, budget } = reader([groq.client], []);
    await read({ mode: 'local', ...IMAGE });
    expect(budget.usedInWindow(LLAMA_4_SCOUT)).toBe(1_050);
    expect(budget.reservedFor(LLAMA_4_SCOUT)).toBe(0);
    expect(VISION_RESERVE_TOKENS).toBeGreaterThan(1_050);
  });

  it('logs codes and numbers only, never the text or the image', async () => {
    lines.length = 0;
    const groq = client(LLAMA_4_SCOUT, 'groq', [status(500)]);
    const next = client('groq-other', 'groq', [answer('סוד גדול')]);
    await reader([groq.client, next.client], []).read({ mode: 'local', ...IMAGE });
    const dump = JSON.stringify(lines);
    expect(dump).not.toContain('סוד');
    expect(dump).not.toContain(IMAGE.data);
    expect(lines.length).toBeGreaterThan(0);
  });
});

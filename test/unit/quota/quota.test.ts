/**
 * Quotas shown in the app (2026-10-01): what Groq reports in its headers,
 * what the server counts itself, and the report that says which is which.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Repository } from '../../../src/core/repo.js';
import { MIGRATIONS } from '../../../src/platform/migrations.js';
import {
  DAY_TOKEN_LIMIT,
  QuotaStore,
  WORKER_REQUESTS_PER_DAY,
  meterGroqFetch,
  parseGroqDuration,
  readRateLimits,
} from '../../../src/core/quota.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const NOW = Date.parse('2026-10-01T18:00:00Z');

const headers = (values: Record<string, string>) => new Headers(values);

describe('parseGroqDuration', () => {
  it('reads the forms Groq sends', () => {
    expect(parseGroqDuration('7.66s')).toBe(7_660);
    expect(parseGroqDuration('2m59.56s')).toBe(179_560);
    expect(parseGroqDuration('1h2m3s')).toBe(3_723_000);
    expect(parseGroqDuration('250ms')).toBe(250);
  });

  it('refuses anything else', () => {
    expect(parseGroqDuration('')).toBeNull();
    expect(parseGroqDuration('soon')).toBeNull();
    expect(parseGroqDuration('5')).toBeNull();
  });
});

describe('readRateLimits', () => {
  it('reads the request and minute-token buckets', () => {
    const limits = readRateLimits(
      headers({
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '987',
        'x-ratelimit-reset-requests': '1m30s',
        'x-ratelimit-limit-tokens': '8000',
        'x-ratelimit-remaining-tokens': '6500',
        'x-ratelimit-reset-tokens': '11.25s',
      }),
      NOW,
    );
    expect(limits).toEqual({
      requests: { limit: 1000, remaining: 987, resetAt: NOW + 90_000 },
      minuteTokens: { limit: 8000, remaining: 6500, resetAt: NOW + 11_250 },
    });
  });

  it('is null when a response carries none, and leaves out a half-read bucket', () => {
    expect(readRateLimits(headers({}), NOW)).toBeNull();
    expect(
      readRateLimits(headers({ 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': 'lots' }), NOW),
    ).toBeNull();
  });
});

describe('meterGroqFetch', () => {
  const seen: { model: string }[] = [];
  const groq = (async () =>
    new Response('{}', {
      status: 200,
      headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '999', 'x-ratelimit-reset-requests': '1s' },
    })) as unknown as typeof fetch;

  beforeEach(() => {
    seen.length = 0;
  });

  it('takes the model from a JSON body, and from a form', async () => {
    const metered = meterGroqFetch(groq, (model) => seen.push({ model }), () => NOW);
    await metered('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'qwen/qwen3.8-27b', messages: [] }),
    });
    const form = new FormData();
    form.append('model', 'whisper-large-v3');
    await metered('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', body: form });
    expect(seen.map((s) => s.model)).toEqual(['qwen/qwen3.8-27b', 'whisper-large-v3']);
  });

  it('leaves every other host alone, and returns the response untouched', async () => {
    const metered = meterGroqFetch(groq, (model) => seen.push({ model }), () => NOW);
    const response = await metered('https://www.googleapis.com/calendar/v3/x', { method: 'GET' });
    expect(seen).toEqual([]);
    expect(await response.text()).toBe('{}');
  });

  it('still records the headers of a 429', async () => {
    const limited = (async () =>
      new Response('', { status: 429, headers: { 'x-ratelimit-limit-tokens': '8000', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '30s' } })) as unknown as typeof fetch;
    const metered = meterGroqFetch(limited, (model) => seen.push({ model }), () => NOW);
    const response = await metered('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', body: '{"model":"m"}' });
    expect(response.status).toBe(429);
    expect(seen).toEqual([{ model: 'm' }]);
  });

  it('calls fetch without a `this`, as Workers requires', async () => {
    const strict = function (this: unknown) {
      if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(new Response('{}'));
    } as unknown as typeof fetch;
    await expect(meterGroqFetch(strict, () => {}, () => NOW)('https://api.groq.com/x', {})).resolves.toBeInstanceOf(Response);
  });
});

describe('QuotaStore', () => {
  let driver: TestSqlDriver;
  let now: number;
  let store: QuotaStore;

  beforeEach(() => {
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    now = NOW;
    store = new QuotaStore(driver, () => now);
  });
  afterEach(() => driver.close());

  const MODELS = [{ model: 'qwen', role: 'primary' as const, dayTokens: true }];
  const report = () => store.report(MODELS, { used: 3, limit: 60 });

  it('reports what Groq said, with when it said it', () => {
    store.recordLimits('qwen', {
      requests: { limit: 1000, remaining: 900, resetAt: NOW + 60_000 },
      minuteTokens: { limit: 8000, remaining: 5000, resetAt: NOW + 20_000 },
    });
    now += 5_000;
    const model = report().models[0]!;
    expect(model.requests).toEqual({ limit: 1000, remaining: 900, resetAt: NOW + 60_000, observedAt: NOW });
    expect(model.minuteTokens).toEqual({ limit: 8000, remaining: 5000, resetAt: NOW + 20_000, observedAt: NOW });
  });

  it('shows a bucket as full once the time Groq gave for it has passed', () => {
    store.recordLimits('qwen', {
      requests: { limit: 1000, remaining: 900, resetAt: NOW + 60_000 },
      minuteTokens: { limit: 8000, remaining: 0, resetAt: NOW + 20_000 },
    });
    now += 30_000;
    const model = report().models[0]!;
    expect(model.minuteTokens?.remaining).toBe(8000);
    expect(model.requests?.remaining).toBe(900);
  });

  it('keeps a bucket it was not told about this time', () => {
    store.recordLimits('qwen', { requests: { limit: 1000, remaining: 900, resetAt: NOW + 60_000 } });
    store.recordLimits('qwen', { minuteTokens: { limit: 8000, remaining: 7000, resetAt: NOW + 5_000 } });
    const model = report().models[0]!;
    expect(model.requests?.remaining).toBe(900);
    expect(model.minuteTokens?.remaining).toBe(7000);
  });

  it('counts tokens over the last 24 hours, per model', () => {
    store.recordTokens('qwen', 1_000);
    now += 12 * 60 * 60 * 1000;
    store.recordTokens('qwen', 2_500);
    store.recordTokens('other', 9_999);
    expect(report().models[0]!.dayTokens).toEqual({ limit: DAY_TOKEN_LIMIT, used: 3_500 });

    now += 13 * 60 * 60 * 1000; // the first spend is now over a day old
    expect(report().models[0]!.dayTokens?.used).toBe(2_500);
  });

  it('counts requests per UTC day, the day Cloudflare resets on', () => {
    store.countRequest();
    store.countRequest();
    expect(report().workerRequests).toEqual({
      limit: WORKER_REQUESTS_PER_DAY,
      used: 2,
      resetAt: Date.parse('2026-10-02T00:00:00Z'),
    });
    now = Date.parse('2026-10-02T00:00:01Z');
    expect(report().workerRequests.used).toBe(0);
  });

  it('reports a model it has heard nothing about as unknown, not as full', () => {
    const model = report().models[0]!;
    expect(model.requests).toBeNull();
    expect(model.minuteTokens).toBeNull();
    expect(model.dayTokens).toEqual({ limit: DAY_TOKEN_LIMIT, used: 0 });
  });

  it('passes the voice count through', () => {
    expect(report().voice).toEqual({ used: 3, limit: 60 });
  });
});

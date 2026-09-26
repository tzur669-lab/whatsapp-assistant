import { describe, expect, it } from 'vitest';
import { createGroqProvider } from '../../../src/nlu/groq.js';
import { createFakeGroq } from '../../integration/fake-groq.js';
import { toolCatalog } from '../../../src/tools/registry.js';

const INPUT = {
  text: 'תזכיר לי מחר ב-8 להתקשר לאבא',
  nowLocalIso: '2026-09-24T21:00:00+03:00',
  weekday: 'Thursday',
  tools: toolCatalog(),
};

const DRAFT_JSON = JSON.stringify({
  intent: 'reminders.create',
  language: 'he',
  slots: { text: 'להתקשר לאבא' },
  missing: ['time'],
  ambiguities: [],
});

const provider = (fake: ReturnType<typeof createFakeGroq>) =>
  createGroqProvider({ apiKey: 'test-key', model: 'test-model', fetchImpl: fake.fetchImpl });

describe('createGroqProvider', () => {
  it('returns the parsed draft on a clean response', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: DRAFT_JSON }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toMatchObject({ ok: true, usage: { promptTokens: 120, completionTokens: 40 } });
  });

  it('sends temperature 0 and the configured model', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: DRAFT_JSON }]);
    await provider(fake).parse(INPUT);
    expect(fake.requests[0]).toMatchObject({ temperature: 0, model: 'test-model' });
  });

  it('sends only the message, the clock and the tool catalog', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: DRAFT_JSON }]);
    await provider(fake).parse(INPUT);
    const sent = JSON.stringify(fake.requests[0]);
    expect(sent).toContain(INPUT.text);
    expect(sent).toContain('reminders.create');
    // Nothing policy-bearing or identifying may cross the wire.
    expect(sent).not.toMatch(/\btier\b/i);
    expect(sent).not.toContain('googleapis.com');
    expect(sent).not.toContain('test-key');
  });

  it('strips a code fence the model added anyway', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: '```json\n' + DRAFT_JSON + '\n```' }]);
    const res = await provider(fake).parse(INPUT);
    expect(res.ok).toBe(true);
  });

  it('retries once when the body is not JSON, then gives up', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: 'Sure! Here you go.' }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'invalid_json' } });
    expect(fake.requests).toHaveLength(2);
  });

  it('succeeds on the repair retry', async () => {
    const fake = createFakeGroq([
      { kind: 'content', content: 'oops' },
      { kind: 'content', content: DRAFT_JSON },
    ]);
    const res = await provider(fake).parse(INPUT);
    expect(res.ok).toBe(true);
    expect(fake.requests).toHaveLength(2);
  });

  it('reports a rate limit without retrying', async () => {
    const fake = createFakeGroq([{ kind: 'status', status: 429 }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'rate_limited', status: 429 } });
    expect(fake.requests).toHaveLength(1);
  });

  it('reports a server error with its status', async () => {
    const fake = createFakeGroq([{ kind: 'status', status: 503 }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'provider_error', status: 503 } });
  });

  it('reports a timeout', async () => {
    const fake = createFakeGroq([{ kind: 'timeout' }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'timeout' } });
  });

  it('reports a network failure without throwing, distinct from a slow model', async () => {
    const fake = createFakeGroq([{ kind: 'network_error' }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'network_error' } });
  });

  it('reports a connect timeout as a network fault, and says which fault', async () => {
    // The code alone made every connection failure look identical. The cause
    // rides with it — the runtime's short code, never the error's text, which
    // commonly carries the URL.
    const fake = createFakeGroq([{ kind: 'connect_timeout' }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toEqual({
      ok: false,
      error: { code: 'network_error', cause: 'UND_ERR_CONNECT_TIMEOUT' },
    });
  });

  it('constrains generation with the response schema', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: DRAFT_JSON }]);
    await provider(fake).parse(INPUT);
    const sent = JSON.stringify(fake.requests[0]);
    expect(sent).toContain('json_schema');
    expect(sent).toContain('intent_draft');
  });

  it('leaves room for reasoning tokens in the completion budget', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: DRAFT_JSON }]);
    await provider(fake).parse(INPUT);
    const body = fake.requests[0] as unknown as { max_completion_tokens: number };
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(2048);
  });

  it('treats a null slot as absent, the way the schema mode reports it', async () => {
    const withNulls = JSON.stringify({
      intent: 'reminders.create',
      language: 'he',
      slots: { text: 'להתקשר לאבא', date: null, time: null },
      missing: ['date', 'time'],
      ambiguities: [],
    });
    const fake = createFakeGroq([{ kind: 'content', content: withNulls }]);
    const res = await provider(fake).parse(INPUT);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect((res.draft as { slots: Record<string, unknown> }).slots).toEqual({ text: 'להתקשר לאבא' });
    }
  });

  it('reports an empty choices envelope as invalid json', async () => {
    const fake = createFakeGroq([{ kind: 'bad_envelope' }]);
    const res = await provider(fake).parse(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'invalid_json' } });
  });

  it('refuses to call out with no API key', async () => {
    const fake = createFakeGroq([{ kind: 'content', content: DRAFT_JSON }]);
    const res = await createGroqProvider({
      apiKey: '',
      model: 'test-model',
      fetchImpl: fake.fetchImpl,
    }).parse(INPUT);
    expect(res).toEqual({ ok: false, error: { code: 'not_configured' } });
    expect(fake.requests).toHaveLength(0);
  });
});

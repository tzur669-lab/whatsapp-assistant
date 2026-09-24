/**
 * The Groq Whisper provider (PLAN §2, §6.10).
 *
 * What matters here is the same as for the NLU provider: failures come back as
 * codes rather than exceptions, error bodies are never read, and a malformed
 * response is refused instead of half-believed.
 */
import { describe, expect, it } from 'vitest';
import { createGroqWhisperProvider } from '../../../src/voice/groq-whisper.js';

const AUDIO = { bytes: new Uint8Array([0x4f, 0x67, 0x67, 0x53]), mimeType: 'audio/ogg' };

const VERBOSE_JSON = {
  task: 'transcribe',
  language: 'hebrew',
  duration: 3.4,
  text: 'תזכיר לי מחר בשמונה',
  segments: [
    {
      id: 0,
      start: 0,
      end: 3.4,
      text: 'תזכיר לי מחר בשמונה',
      avg_logprob: -0.21,
      compression_ratio: 1.12,
      no_speech_prob: 0.004,
    },
  ],
};

type Call = { url: string; init: RequestInit | undefined };

function fakeGroq(build: () => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: typeof input === 'string' ? input : input.toString(), init });
    return build();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const provider = (fetchImpl: typeof fetch) =>
  createGroqWhisperProvider({ apiKey: 'gsk_fake', model: 'whisper-large-v3', fetchImpl });

describe('a successful transcription', () => {
  it('returns the text with its per-segment confidence intact', async () => {
    const { fetchImpl } = fakeGroq(() => json(VERBOSE_JSON));
    const result = await provider(fetchImpl).transcribe(AUDIO);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.text).toBe('תזכיר לי מחר בשמונה');
    expect(result.transcript.language).toBe('hebrew');
    expect(result.transcript.segments[0]).toMatchObject({
      avgLogprob: -0.21,
      noSpeechProb: 0.004,
      compressionRatio: 1.12,
      endSeconds: 3.4,
    });
  });

  it('asks for the format that carries confidence, at temperature zero', async () => {
    const { fetchImpl, calls } = fakeGroq(() => json(VERBOSE_JSON));
    await provider(fetchImpl).transcribe(AUDIO);

    const form = calls[0]?.init?.body as FormData;
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('temperature')).toBe('0');
    expect(form.get('model')).toBe('whisper-large-v3');
  });

  it('names the file by its format, which is how the API dispatches', async () => {
    const { fetchImpl, calls } = fakeGroq(() => json(VERBOSE_JSON));
    await provider(fetchImpl).transcribe({ ...AUDIO, mimeType: 'audio/mpeg' });

    const file = (calls[0]?.init?.body as FormData).get('file') as unknown as File;
    expect(file.name).toBe('voice.mp3');
  });

  it('does not pin a language, so Hebrew and English both stay possible', async () => {
    const { fetchImpl, calls } = fakeGroq(() => json(VERBOSE_JSON));
    await provider(fetchImpl).transcribe(AUDIO);
    expect((calls[0]?.init?.body as FormData).get('language')).toBeNull();
  });
});

describe('failures', () => {
  it('reports a rate limit with its retry-after', async () => {
    const { fetchImpl } = fakeGroq(() => json({}, 429, { 'retry-after': '42' }));
    const result = await provider(fetchImpl).transcribe(AUDIO);
    expect(result).toEqual({
      ok: false,
      error: { code: 'rate_limited', status: 429, retryAfterSeconds: 42 },
    });
  });

  it('reports a server error by status', async () => {
    const { fetchImpl } = fakeGroq(() => json({}, 503));
    const result = await provider(fetchImpl).transcribe(AUDIO);
    expect(result).toEqual({ ok: false, error: { code: 'provider_error', status: 503 } });
  });

  it('refuses a response with no text rather than returning an empty one', async () => {
    const { fetchImpl } = fakeGroq(() => json({ language: 'hebrew', segments: [] }));
    const result = await provider(fetchImpl).transcribe(AUDIO);
    expect(result).toEqual({ ok: false, error: { code: 'invalid_response' } });
  });

  it('refuses a body that is not JSON', async () => {
    const { fetchImpl } = fakeGroq(() => new Response('not json', { status: 200 }));
    const result = await provider(fetchImpl).transcribe(AUDIO);
    expect(result).toEqual({ ok: false, error: { code: 'invalid_response' } });
  });

  it('separates a timeout from a connection failure', async () => {
    const timeout = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(await provider(timeout).transcribe(AUDIO)).toEqual({
      ok: false,
      error: { code: 'timeout' },
    });

    const refused = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await provider(refused).transcribe(AUDIO)).toEqual({
      ok: false,
      error: { code: 'network_error' },
    });
  });

  it('says so when no key is configured, instead of calling out', async () => {
    const { fetchImpl, calls } = fakeGroq(() => json(VERBOSE_JSON));
    const result = await createGroqWhisperProvider({
      apiKey: '',
      model: 'whisper-large-v3',
      fetchImpl,
    }).transcribe(AUDIO);

    expect(result).toEqual({ ok: false, error: { code: 'not_configured' } });
    expect(calls).toHaveLength(0);
  });
});

describe('missing confidence fields', () => {
  it('reads a segment with no scores as untrustworthy, not as perfect', async () => {
    const { fetchImpl } = fakeGroq(() =>
      json({ ...VERBOSE_JSON, segments: [{ start: 0, end: 2, text: 'x' }] }),
    );
    const result = await provider(fetchImpl).transcribe(AUDIO);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transcript.segments[0]?.avgLogprob).toBe(Number.NEGATIVE_INFINITY);
    expect(result.transcript.segments[0]?.noSpeechProb).toBe(1);
  });
});

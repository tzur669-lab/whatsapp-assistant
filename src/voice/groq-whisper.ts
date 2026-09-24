/**
 * Groq Whisper transcription provider (PLAN §2, §6.10).
 *
 * Runs on the same Groq account as the parser but against a different model, so
 * it draws on a separate rate-limit budget: exhausting the parser's daily tokens
 * does not stop voice notes, and vice versa.
 *
 * Settings mirror the NLU provider where they matter: temperature 0, failures
 * returned rather than thrown, and error bodies never read — a transcription
 * error body can quote the audio's own content back.
 *
 * `verbose_json` is not a debugging luxury here. It is the only response format
 * that carries the per-segment confidence the gate in `transcribe.ts` runs on.
 */
import type { AsrResponse, AudioInput, TranscriptionProvider, TranscriptSegment } from './transcribe.js';

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';

/**
 * `whisper-large-v3`, not the turbo variant. Turbo is faster, but this is
 * unvocalized Hebrew with names and times in it, and accuracy is what decides
 * whether a reminder lands on the right day. Latency is not on a critical path:
 * the webhook was answered before transcription started.
 */
export const WHISPER_MODEL = 'whisper-large-v3';

/**
 * Longer than the NLU's 8 s: transcription time scales with the length of the
 * recording, and the webhook has already been answered, so nothing is waiting
 * on this but the reply.
 */
const TIMEOUT_MS = 20_000;

/** Whisper needs a plausible file extension; it dispatches on it. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/aac': 'aac',
  'audio/amr': 'amr',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
};

export type GroqWhisperConfig = {
  apiKey: string;
  model: string;
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
};

export function createGroqWhisperProvider(config: GroqWhisperConfig): TranscriptionProvider {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    name: `groq:${config.model}`,

    async transcribe(audio: AudioInput): Promise<AsrResponse> {
      if (!config.apiKey) return { ok: false, error: { code: 'not_configured' } };

      const form = new FormData();
      const extension = EXTENSIONS[audio.mimeType] ?? 'ogg';
      form.append('file', new Blob([audio.bytes], { type: audio.mimeType }), `voice.${extension}`);
      form.append('model', config.model);
      form.append('response_format', 'verbose_json');
      form.append('temperature', '0');
      // The language is deliberately not pinned. This assistant takes Hebrew and
      // English, and forcing one makes the recognizer transliterate the other
      // rather than admit it guessed wrong (PLAN §13).

      let response: Response;
      try {
        response = await doFetch(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${config.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : '';
        const timedOut = name === 'TimeoutError' || name === 'AbortError';
        return { ok: false, error: { code: timedOut ? 'timeout' : 'network_error' } };
      }

      if (response.status === 429) {
        // Header only — the body carries quota detail but may quote the request.
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
        return { ok: false, error: { code: 'invalid_response' } };
      }

      const transcript = readTranscript(payload);
      if (transcript === null) return { ok: false, error: { code: 'invalid_response' } };

      return { ok: true, transcript };
    },
  };
}

function readTranscript(payload: unknown): {
  text: string;
  language: string;
  durationSeconds: number;
  segments: TranscriptSegment[];
} | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;

  if (typeof record.text !== 'string') return null;

  return {
    text: record.text,
    language: typeof record.language === 'string' ? record.language : '',
    durationSeconds: asNumber(record.duration, 0),
    segments: readSegments(record.segments),
  };
}

function readSegments(value: unknown): TranscriptSegment[] {
  if (!Array.isArray(value)) return [];

  const segments: TranscriptSegment[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    segments.push({
      startSeconds: asNumber(record.start, 0),
      endSeconds: asNumber(record.end, 0),
      // A missing confidence field must not read as perfect confidence, so the
      // defaults are the pessimistic end of each scale.
      avgLogprob: asNumber(record.avg_logprob, Number.NEGATIVE_INFINITY),
      noSpeechProb: asNumber(record.no_speech_prob, 1),
      compressionRatio: asNumber(record.compression_ratio, 0),
    });
  }
  return segments;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

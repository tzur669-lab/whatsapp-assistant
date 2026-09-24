/**
 * The voice-note confidence gate (PLAN §6.10).
 *
 * Recognition is a guess, and the user never sees what the system received. The
 * gate is what turns that guess into one of three honest answers: use it, use it
 * but confirm first, or ask again. These tests pin all three boundaries.
 */
import { describe, expect, it } from 'vitest';
import {
  gradeTranscript,
  normalizeLanguage,
  transcribeVoice,
  COMPRESSION_RATIO_THRESHOLD,
  LOGPROB_REJECT,
  LOGPROB_UNCERTAIN,
  NO_SPEECH_THRESHOLD,
} from '../../../src/voice/transcribe.js';
import type {
  AsrResponse,
  RawTranscript,
  TranscriptionProvider,
  TranscriptSegment,
} from '../../../src/voice/transcribe.js';

function segment(overrides: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    startSeconds: 0,
    endSeconds: 4,
    avgLogprob: -0.2,
    noSpeechProb: 0.01,
    compressionRatio: 1.3,
    ...overrides,
  };
}

function transcript(overrides: Partial<RawTranscript> = {}): RawTranscript {
  return {
    text: 'תזכיר לי מחר בשמונה להתקשר לאבא',
    language: 'hebrew',
    durationSeconds: 4,
    segments: [segment()],
    ...overrides,
  };
}

const fakeProvider = (response: AsrResponse | (() => never)): TranscriptionProvider => ({
  name: 'fake',
  transcribe: async () => (typeof response === 'function' ? response() : response),
});

describe('a clear recording', () => {
  it('is used as written', () => {
    const outcome = gradeTranscript(transcript());
    expect(outcome).toEqual({
      status: 'ok',
      text: 'תזכיר לי מחר בשמונה להתקשר לאבא',
      confidence: 'high',
      language: 'he',
    });
  });

  it('collapses the whitespace the recognizer leaves behind', () => {
    const outcome = gradeTranscript(transcript({ text: '  תזכיר   לי\n מחר  ' }));
    expect(outcome).toMatchObject({ status: 'ok', text: 'תזכיר לי מחר' });
  });

  it('caps the length, so voice cannot carry a longer message than text', () => {
    const outcome = gradeTranscript(transcript({ text: 'א'.repeat(9000) }));
    expect(outcome.status === 'ok' && outcome.text.length).toBe(4096);
  });
});

describe('recordings that must not reach the parser', () => {
  it('treats silence as nothing said', () => {
    const outcome = gradeTranscript(
      transcript({ segments: [segment({ noSpeechProb: NO_SPEECH_THRESHOLD + 0.1 })] }),
    );
    expect(outcome).toEqual({ status: 'unclear', reason: 'silence' });
  });

  it('treats an empty transcript as silence, whatever the scores say', () => {
    expect(gradeTranscript(transcript({ text: '   ' }))).toEqual({
      status: 'unclear',
      reason: 'silence',
    });
  });

  it('rejects a transcript the recognizer itself has little faith in', () => {
    const outcome = gradeTranscript(
      transcript({ segments: [segment({ avgLogprob: LOGPROB_REJECT - 0.1 })] }),
    );
    expect(outcome).toEqual({ status: 'unclear', reason: 'low_confidence' });
  });

  it('rejects the fluent repetition Whisper produces on noise', () => {
    // High confidence, low silence, and completely invented.
    const outcome = gradeTranscript(
      transcript({
        segments: [segment({ compressionRatio: COMPRESSION_RATIO_THRESHOLD + 0.1, avgLogprob: -0.1 })],
      }),
    );
    expect(outcome).toEqual({ status: 'unclear', reason: 'low_confidence' });
  });

  it('rejects a language this assistant does not take', () => {
    expect(gradeTranscript(transcript({ language: 'russian' }))).toEqual({
      status: 'unclear',
      reason: 'unknown_language',
    });
  });
});

describe('the uncertain band', () => {
  it('uses a middling transcript but marks it for confirmation', () => {
    const outcome = gradeTranscript(
      transcript({ segments: [segment({ avgLogprob: LOGPROB_UNCERTAIN - 0.1 })] }),
    );
    expect(outcome).toMatchObject({ status: 'ok', confidence: 'uncertain' });
  });

  it('is generous exactly at the threshold, not one step before it', () => {
    const outcome = gradeTranscript(
      transcript({ segments: [segment({ avgLogprob: LOGPROB_UNCERTAIN })] }),
    );
    expect(outcome).toMatchObject({ confidence: 'high' });
  });

  it('does not trust a transcript that came with no confidence data at all', () => {
    expect(gradeTranscript(transcript({ segments: [] }))).toMatchObject({
      status: 'ok',
      confidence: 'uncertain',
    });
  });
});

describe('weighting by duration', () => {
  it('does not let a moment of throat-clearing reject eight good seconds', () => {
    const outcome = gradeTranscript(
      transcript({
        segments: [
          segment({ startSeconds: 0, endSeconds: 0.2, avgLogprob: -2.5 }),
          segment({ startSeconds: 0.2, endSeconds: 8.2, avgLogprob: -0.15 }),
        ],
      }),
    );
    expect(outcome).toMatchObject({ status: 'ok', confidence: 'high' });
  });

  it('still rejects when the long stretch is the bad one', () => {
    const outcome = gradeTranscript(
      transcript({
        segments: [
          segment({ startSeconds: 0, endSeconds: 0.2, avgLogprob: -0.1 }),
          segment({ startSeconds: 0.2, endSeconds: 8.2, avgLogprob: -1.4 }),
        ],
      }),
    );
    expect(outcome).toEqual({ status: 'unclear', reason: 'low_confidence' });
  });
});

describe('language names', () => {
  it('accepts every spelling the recognizer uses for Hebrew', () => {
    for (const name of ['he', 'iw', 'hebrew', 'Hebrew', ' HEBREW ']) {
      expect(normalizeLanguage(name)).toBe('he');
    }
  });

  it('accepts English', () => {
    for (const name of ['en', 'english', 'English']) expect(normalizeLanguage(name)).toBe('en');
  });

  it('returns null for anything else', () => {
    for (const name of ['', 'arabic', 'ru', 'nn']) expect(normalizeLanguage(name)).toBeNull();
  });
});

describe('transcribeVoice', () => {
  const audio = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/ogg' };

  it('passes a provider success through the gate', async () => {
    const outcome = await transcribeVoice(fakeProvider({ ok: true, transcript: transcript() }), audio);
    expect(outcome).toMatchObject({ status: 'ok', language: 'he' });
  });

  it('reports a provider failure as a failure, not as an unclear recording', async () => {
    const outcome = await transcribeVoice(
      fakeProvider({ ok: false, error: { code: 'rate_limited', status: 429 } }),
      audio,
    );
    expect(outcome).toEqual({ status: 'failed', errorCode: 'rate_limited' });
  });

  it('contains a provider that throws', async () => {
    const outcome = await transcribeVoice(
      fakeProvider(() => {
        throw new Error('boom');
      }),
      audio,
    );
    expect(outcome).toEqual({ status: 'failed', errorCode: 'provider_error' });
  });
});

/**
 * Voice notes: the contract, and the confidence gate (PLAN §6.10).
 *
 * Speech recognition is the one component in this system that returns a *guess*
 * rather than a fact, and the user never sees what was received — unlike typed
 * text, which they wrote themselves. So the gate here is deliberately strict:
 * a transcript that the recognizer itself is unsure about is never handed to
 * the parser. It becomes a question instead (CLAUDE.md invariant 12).
 *
 * The transcript is the user's own words. It is returned to them and passed to
 * the parser exactly as message text would be, and it is never logged, never
 * stored, and never written to the audit trail (PLAN §6.9).
 */

/** One Whisper segment, reduced to the three numbers that say how sure it is. */
export type TranscriptSegment = {
  startSeconds: number;
  endSeconds: number;
  /** Mean log probability of the tokens. Closer to 0 is more confident. */
  avgLogprob: number;
  /** How likely this stretch is silence or noise rather than speech. */
  noSpeechProb: number;
  /** Text-to-token ratio. A high value means the model repeated itself. */
  compressionRatio: number;
};

export type RawTranscript = {
  text: string;
  /** As reported by the recognizer, in whatever spelling it uses. */
  language: string;
  durationSeconds: number;
  segments: TranscriptSegment[];
};

export type AsrErrorCode =
  | 'timeout'
  | 'rate_limited'
  | 'provider_error'
  | 'network_error'
  | 'invalid_response'
  | 'not_configured';

export type AsrError = { code: AsrErrorCode; status?: number; retryAfterSeconds?: number };

export type AsrResponse = { ok: true; transcript: RawTranscript } | { ok: false; error: AsrError };

export type AudioInput = { bytes: Uint8Array; mimeType: string };

export interface TranscriptionProvider {
  readonly name: string;
  transcribe(audio: AudioInput): Promise<AsrResponse>;
}

/**
 * Whisper's own decoding defaults, kept rather than invented so the numbers can
 * be checked against the reference implementation.
 */
export const NO_SPEECH_THRESHOLD = 0.6;
export const LOGPROB_REJECT = -1.0;
export const COMPRESSION_RATIO_THRESHOLD = 2.4;

/**
 * Between clean and rejected. A transcript in this band is used, but any write
 * it leads to is put behind a confirmation instead of executed (PLAN §6.4).
 */
export const LOGPROB_UNCERTAIN = -0.5;

/** Same cap as inbound text, so voice cannot smuggle a longer message. */
const MAX_TRANSCRIPT_CHARS = 4096;

export type VoiceConfidence = 'high' | 'uncertain';

export type VoiceOutcome =
  | { status: 'ok'; text: string; confidence: VoiceConfidence; language: 'he' | 'en' }
  | { status: 'unclear'; reason: 'silence' | 'low_confidence' | 'unknown_language' }
  /** Past the size the transcriber accepts. Worth its own reply: it is fixable. */
  | { status: 'too_long' }
  | { status: 'failed'; errorCode: AsrErrorCode | 'media_error' };

/**
 * The audio behind a message: a media id the channel adapter fetches
 * (WhatsApp), or the bytes themselves when they came with the request (the
 * app, §6.18).
 */
export type VoiceRequest = { mediaId: string; mimeType: string; bytes?: Uint8Array };

/**
 * Fetch and grade one recording. Declared here rather than in the WhatsApp
 * adapter so `src/core/` can depend on the capability without depending on the
 * channel that provides it (CLAUDE.md invariant 11, PLAN §3.4).
 */
export type VoiceTranscriber = (request: VoiceRequest) => Promise<VoiceOutcome>;

export async function transcribeVoice(
  provider: TranscriptionProvider,
  audio: AudioInput,
): Promise<VoiceOutcome> {
  let response: AsrResponse;
  try {
    response = await provider.transcribe(audio);
  } catch {
    // A provider must not be able to take the request down with it.
    response = { ok: false, error: { code: 'provider_error' } };
  }

  if (!response.ok) return { status: 'failed', errorCode: response.error.code };
  return gradeTranscript(response.transcript);
}

/**
 * Decide whether a transcript is usable, and how much to trust it.
 *
 * Segment statistics are weighted by duration: without that, a fifth of a second
 * of throat-clearing scores the same as eight seconds of clear speech, and a
 * perfectly good message gets rejected.
 */
export function gradeTranscript(transcript: RawTranscript): VoiceOutcome {
  const text = normalizeTranscript(transcript.text);
  const segments = transcript.segments;

  const noSpeech = weightedMean(segments, (s) => s.noSpeechProb);
  const logprob = weightedMean(segments, (s) => s.avgLogprob);
  const repetition = segments.reduce((max, s) => Math.max(max, s.compressionRatio), 0);

  if (text.length === 0 || noSpeech > NO_SPEECH_THRESHOLD) {
    return { status: 'unclear', reason: 'silence' };
  }

  // A run-on repeat is Whisper's classic failure on noise: fluent, confident,
  // and entirely invented.
  if (logprob < LOGPROB_REJECT || repetition > COMPRESSION_RATIO_THRESHOLD) {
    return { status: 'unclear', reason: 'low_confidence' };
  }

  const language = normalizeLanguage(transcript.language);
  if (language === null) return { status: 'unclear', reason: 'unknown_language' };

  // No segments means no confidence signal at all. Absence of evidence is not
  // evidence of a good transcript, so it is graded down rather than trusted.
  const confident = segments.length > 0 && logprob >= LOGPROB_UNCERTAIN;

  return {
    status: 'ok',
    text,
    confidence: confident ? 'high' : 'uncertain',
    language,
  };
}

/** Whisper reports language names, not codes, and Hebrew has a legacy code. */
export function normalizeLanguage(value: string): 'he' | 'en' | null {
  const name = value.trim().toLowerCase();
  if (name === 'he' || name === 'iw' || name === 'hebrew') return 'he';
  if (name === 'en' || name === 'english') return 'en';
  return null;
}

function normalizeTranscript(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * Duration-weighted mean. Segments with no usable duration fall back to equal
 * weight, so a provider that omits timings still produces a sane number.
 */
function weightedMean(
  segments: readonly TranscriptSegment[],
  pick: (segment: TranscriptSegment) => number,
): number {
  if (segments.length === 0) return 0;

  let weightedTotal = 0;
  let weight = 0;
  for (const segment of segments) {
    const seconds = Math.max(0, segment.endSeconds - segment.startSeconds);
    const w = seconds > 0 ? seconds : 1;
    weightedTotal += pick(segment) * w;
    weight += w;
  }
  return weight === 0 ? 0 : weightedTotal / weight;
}

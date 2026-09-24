/**
 * Voice notes end to end: media id -> audio -> graded transcript (PLAN §6.10).
 *
 * This is the seam between the WhatsApp-specific half (the media id and the
 * token that fetches it) and the channel-neutral half (recognition and the
 * confidence gate). The pipeline sees only the second, so a second channel
 * would supply its own downloader and reuse everything else.
 *
 * Every failure becomes an outcome. Nothing throws out of here: an audio file
 * that cannot be fetched is an answerable situation, not an incident.
 */
import { fetchWhatsAppMedia, MediaError } from './media.js';
import { transcribeVoice } from '../../voice/transcribe.js';
import type { TranscriptionProvider, VoiceTranscriber } from '../../voice/transcribe.js';
import type { Logger } from '../../security/redact.js';

export type VoiceTranscriberConfig = {
  accessToken: string;
  provider: TranscriptionProvider;
  log: Logger;
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
};

export function createVoiceTranscriber(config: VoiceTranscriberConfig): VoiceTranscriber {
  return async ({ mediaId, mimeType }) => {
    const started = Date.now();

    let audio;
    try {
      audio = await fetchWhatsAppMedia(mediaId, {
        accessToken: config.accessToken,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
      });
    } catch (error) {
      const reason = error instanceof MediaError ? error.reason : 'download_failed';
      // The id and the url are omitted: both resolve back to the audio itself.
      config.log.warn('voice_media_failed', { errorCode: reason, mimeType });
      return reason === 'too_large' ? { status: 'too_long' } : { status: 'failed', errorCode: 'media_error' };
    }

    const outcome = await transcribeVoice(config.provider, audio);

    // Sizes and verdicts only. The transcript never reaches the log (PLAN §6.9).
    config.log.info('voice_transcribed', {
      provider: config.provider.name,
      status: outcome.status,
      confidence: outcome.status === 'ok' ? outcome.confidence : undefined,
      language: outcome.status === 'ok' ? outcome.language : undefined,
      reason: outcome.status === 'unclear' ? outcome.reason : undefined,
      errorCode: outcome.status === 'failed' ? outcome.errorCode : undefined,
      bytes: audio.bytes.byteLength,
      latencyMs: Date.now() - started,
    });

    return outcome;
  };
}

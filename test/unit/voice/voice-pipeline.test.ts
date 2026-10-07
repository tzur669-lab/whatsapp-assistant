/**
 * Voice notes through the pipeline (PLAN §6.10).
 *
 * The contract being pinned: a voice note follows exactly the same path as the
 * same words typed, every answer leads with what was heard, an unusable
 * recording produces a question rather than a guess, and the transcript never
 * reaches a log or the database.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Repository } from '../../../src/core/repo.js';
import { handleInbound } from '../../../src/core/pipeline.js';
import { createVoiceTranscriber } from '../../../src/channels/whatsapp/voice.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';
import { createFakeLogger } from '../../integration/fake-logger.js';
import { he } from '../../../src/render/he.js';
import { stripIsolates } from '../../../src/render/bidi.js';
import type { InboundEvent } from '../../../src/channels/types.js';
import type { VoiceOutcome } from '../../../src/voice/transcribe.js';

const MIGRATIONS = [
  { id: 1, sql: readFileSync(new URL('../../../migrations/0001_init.sql', import.meta.url), 'utf8') },
  { id: 22, sql: readFileSync(new URL('../../../migrations/0022_misses.sql', import.meta.url), 'utf8') },
];

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const PRINCIPAL = 'p_abcdef012345';

function audioEvent(overrides: Partial<Extract<InboundEvent, { kind: 'audio' }>> = {}): InboundEvent {
  return {
    kind: 'audio',
    wamid: 'wamid.V1',
    from: '972500000000',
    sentAtMs: NOW - 1_000,
    mediaId: 'MEDIA-1',
    mimeType: 'audio/ogg',
    voiceNote: true,
    forwarded: false,
    ...overrides,
  };
}

const spoken = (text: string, confidence: 'high' | 'uncertain' = 'high'): VoiceOutcome => ({
  status: 'ok',
  text,
  confidence,
  language: 'he',
});

describe('answering a voice note', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let log: ReturnType<typeof createFakeLogger>;

  const deps = (outcome: VoiceOutcome) => ({
    repo,
    log,
    now: () => NOW,
    principal: PRINCIPAL,
    transcribe: async () => outcome,
  });

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('runs a spoken command down the same path as the typed one', async () => {
    const out = await handleInbound(audioEvent(), deps(spoken('עזרה')));
    expect(out.action).toBe('reply');
    expect(out.action === 'reply' && out.text).toContain(he.help);
  });

  it('leads with what was heard, so the transcript is never acted on unseen', async () => {
    const out = await handleInbound(audioEvent(), deps(spoken('עזרה')));
    const text = out.action === 'reply' ? stripIsolates(out.text) : '';
    expect(text.startsWith('שמעתי: עזרה')).toBe(true);
  });

  it('isolates the transcript, so an English recording cannot reorder the line', async () => {
    const out = await handleInbound(audioEvent(), deps(spoken('remind me tomorrow')));
    expect(out.action === 'reply' && out.text).toContain('⁨remind me tomorrow⁩');
  });

  it('echoes the transcript even when the request was not understood', async () => {
    const out = await handleInbound(audioEvent(), deps(spoken('תזכיר לי מחר בשמונה')));
    const text = out.action === 'reply' ? stripIsolates(out.text) : '';
    expect(text).toContain('שמעתי: תזכיר לי מחר בשמונה');
    expect(text).toContain(stripIsolates(he.notUnderstood));
  });

  it('writes the audit row for a spoken command, same as for a typed one', async () => {
    await handleInbound(audioEvent(), deps(spoken('/ping')));
    expect(driver.exec('SELECT * FROM audit_log')[0]).toMatchObject({
      tool: 'ping',
      decision: 'ALLOW',
    });
  });

  it('opens the 24h window, because a voice note is still an inbound message', async () => {
    await handleInbound(audioEvent(), deps(spoken('עזרה')));
    expect(repo.lastInboundAt(PRINCIPAL)).toBe(NOW);
  });

  it('drops a replayed voice note without transcribing it twice', async () => {
    let calls = 0;
    const counting = {
      ...deps(spoken('עזרה')),
      transcribe: async () => {
        calls++;
        return spoken('עזרה');
      },
    };
    await handleInbound(audioEvent(), counting);
    const second = await handleInbound(audioEvent(), counting);

    expect(second).toEqual({ action: 'none', reason: 'duplicate' });
    expect(calls).toBe(1);
  });
});

describe('recordings that cannot be acted on', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let log: ReturnType<typeof createFakeLogger>;

  const reply = async (outcome: VoiceOutcome) => {
    const out = await handleInbound(audioEvent(), {
      repo,
      log,
      now: () => NOW,
      principal: PRINCIPAL,
      transcribe: async () => outcome,
    });
    return out.action === 'reply' ? out.text : '';
  };

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('says nothing was heard when the recording holds no speech', async () => {
    expect(await reply({ status: 'unclear', reason: 'silence' })).toBe(he.voiceSilent);
  });

  it('asks for a clearer recording when the recognizer is unsure', async () => {
    expect(await reply({ status: 'unclear', reason: 'low_confidence' })).toBe(he.voiceUnclear);
  });

  it('names the language limit rather than answering in the wrong one', async () => {
    expect(await reply({ status: 'unclear', reason: 'unknown_language' })).toBe(he.voiceLanguage);
  });

  it('says a recording is too long, which is something the user can fix', async () => {
    expect(await reply({ status: 'too_long' })).toBe(he.voiceTooLong);
  });

  it('gives a plain failure message, with no provider detail in it', async () => {
    const text = await reply({ status: 'failed', errorCode: 'rate_limited' });
    expect(text).toBe(he.voiceFailed);
    expect(text).not.toContain('rate');
  });

  it('records the outcome as a stable code, never as the transcript', async () => {
    await reply({ status: 'unclear', reason: 'low_confidence' });
    expect(repo.getInbound('wamid.V1')).toMatchObject({
      decision: 'CLARIFY',
      error_code: 'E_VOICE_UNCLEAR',
    });
  });

  it('answers a voice note as unsupported when no transcriber is configured', async () => {
    const out = await handleInbound(audioEvent(), {
      repo,
      log,
      now: () => NOW,
      principal: PRINCIPAL,
    });
    expect(out).toEqual({ action: 'reply', text: he.unsupportedType });
  });
});

describe('the transcript stays out of the record', () => {
  let driver: TestSqlDriver;
  let repo: Repository;
  let log: ReturnType<typeof createFakeLogger>;

  beforeEach(() => {
    driver = new TestSqlDriver();
    repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    log = createFakeLogger();
  });
  afterEach(() => driver.close());

  it('never logs what was said, and never stores it', async () => {
    await handleInbound(audioEvent(), {
      repo,
      log,
      now: () => NOW,
      principal: PRINCIPAL,
      transcribe: async () => spoken('CANARY-SPOKEN-ALOUD'),
    });

    expect(JSON.stringify(log.captured)).not.toContain('CANARY');
    const dump = JSON.stringify(driver.exec('SELECT * FROM inbound_messages'));
    expect(dump).not.toContain('CANARY');
  });

  it('never logs the media id, which resolves straight back to the audio', async () => {
    await handleInbound(audioEvent({ mediaId: 'MEDIA-CANARY' }), {
      repo,
      log,
      now: () => NOW,
      principal: PRINCIPAL,
      transcribe: async () => spoken('עזרה'),
    });
    expect(JSON.stringify(log.captured)).not.toContain('MEDIA-CANARY');
  });
});

describe('createVoiceTranscriber', () => {
  const provider = {
    name: 'fake',
    transcribe: async () => ({
      ok: true as const,
      transcript: {
        text: 'עזרה',
        language: 'hebrew',
        durationSeconds: 1,
        segments: [
          {
            startSeconds: 0,
            endSeconds: 1,
            avgLogprob: -0.1,
            noSpeechProb: 0.01,
            compressionRatio: 1,
          },
        ],
      },
    }),
  };

  const fakeMeta = (metadata: unknown) =>
    (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('https://graph.facebook.com')) {
        return new Response(JSON.stringify(metadata), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(new Uint8Array([1, 2, 3, 4]));
    }) as unknown as typeof fetch;

  it('fetches the audio and returns a graded transcript', async () => {
    const log = createFakeLogger();
    const transcribe = createVoiceTranscriber({
      accessToken: 'fake-token',
      provider,
      log,
      fetchImpl: fakeMeta({
        url: 'https://lookaside.fbsbx.com/x',
        mime_type: 'audio/ogg',
        file_size: 4,
      }),
    });

    expect(await transcribe({ mediaId: 'M1', mimeType: 'audio/ogg' })).toMatchObject({
      status: 'ok',
      text: 'עזרה',
    });
  });

  it('turns an oversized file into its own answer, not a generic failure', async () => {
    const log = createFakeLogger();
    const transcribe = createVoiceTranscriber({
      accessToken: 'fake-token',
      provider,
      log,
      fetchImpl: fakeMeta({
        url: 'https://lookaside.fbsbx.com/x',
        mime_type: 'audio/ogg',
        file_size: 64 * 1024 * 1024,
      }),
    });

    expect(await transcribe({ mediaId: 'M1', mimeType: 'audio/ogg' })).toEqual({
      status: 'too_long',
    });
  });

  it('reports a download it refused as a media error, and throws nothing', async () => {
    const log = createFakeLogger();
    const transcribe = createVoiceTranscriber({
      accessToken: 'fake-token',
      provider,
      log,
      fetchImpl: fakeMeta({ url: 'https://evil.example.com/x', mime_type: 'audio/ogg', file_size: 4 }),
    });

    expect(await transcribe({ mediaId: 'M1', mimeType: 'audio/ogg' })).toEqual({
      status: 'failed',
      errorCode: 'media_error',
    });
    expect(log.captured.some((entry) => entry.event === 'voice_media_failed')).toBe(true);
  });

  it('logs the verdict and the size, never the words', async () => {
    const log = createFakeLogger();
    const transcribe = createVoiceTranscriber({
      accessToken: 'fake-token',
      provider,
      log,
      fetchImpl: fakeMeta({
        url: 'https://lookaside.fbsbx.com/x',
        mime_type: 'audio/ogg',
        file_size: 4,
      }),
    });
    await transcribe({ mediaId: 'M1', mimeType: 'audio/ogg' });

    const entry = log.captured.find((l) => l.event === 'voice_transcribed');
    expect(entry?.fields).toMatchObject({ status: 'ok', confidence: 'high', bytes: 4 });
    expect(JSON.stringify(log.captured)).not.toContain('עזרה');
  });
});

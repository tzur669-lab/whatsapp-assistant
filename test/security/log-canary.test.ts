/**
 * The canary test (PLAN §6.9): push a unique string through the whole inbound
 * pipeline and assert it never reaches the log sink.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Repository } from '../../src/core/repo.js';
import { handleInbound } from '../../src/core/pipeline.js';
import { createLogger, hashPrincipal } from '../../src/security/redact.js';
import { TestSqlDriver } from '../integration/sqlite-driver.js';
import { MIGRATIONS } from '../../src/platform/migrations.js';
import { createVoiceTranscriber } from '../../src/channels/whatsapp/voice.js';

const CANARY = 'CANARY-8f2a91c4-do-not-log';
const CANARY_NUMBER = '972500000000';

describe('log canary', () => {
  let written: string[];
  let driver: TestSqlDriver;

  beforeEach(() => {
    written = [];
    driver = new TestSqlDriver();
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      written.push(String(line));
    });
  });
  afterEach(() => {
    driver.close();
    vi.restoreAllMocks();
  });

  it('never writes the message text or the sender number to the log', async () => {
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const log = createLogger({ component: 'canary' });
    const principal = await hashPrincipal(CANARY_NUMBER, 'log-key');

    await handleInbound(
      {
        kind: 'text',
        wamid: 'wamid.CANARY',
        from: CANARY_NUMBER,
        sentAtMs: Date.now(),
        text: CANARY,
        forwarded: false,
      },
      { repo, log, now: () => Date.now(), principal },
    );

    const all = written.join('\n');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain(CANARY_NUMBER);
    expect(all).toContain('wamid.CANARY');
  });

  it('never writes the message text to the database either', async () => {
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const log = createLogger();

    await handleInbound(
      {
        kind: 'text',
        wamid: 'wamid.CANARY2',
        from: CANARY_NUMBER,
        sentAtMs: Date.now(),
        text: CANARY,
        forwarded: false,
      },
      { repo, log, now: () => Date.now(), principal: 'p_test' },
    );

    const dump = JSON.stringify(driver.exec('SELECT * FROM inbound_messages'));
    expect(dump).not.toContain(CANARY);
    expect(dump).not.toContain(CANARY_NUMBER);
  });

  it('never writes a voice transcript, or the media id behind it, to the log', async () => {
    const repo = new Repository(driver);
    repo.migrate(MIGRATIONS);
    const log = createLogger({ component: 'canary' });

    // A recognizer that hands back the canary, reached through the real
    // download path so the media id passes through the logger too.
    const transcribe = createVoiceTranscriber({
      accessToken: 'fake-token',
      log,
      provider: {
        name: 'fake',
        transcribe: async () => ({
          ok: true as const,
          transcript: {
            text: CANARY,
            language: 'hebrew',
            durationSeconds: 1,
            segments: [
              { startSeconds: 0, endSeconds: 1, avgLogprob: -0.1, noSpeechProb: 0.01, compressionRatio: 1 },
            ],
          },
        }),
      },
      fetchImpl: (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        return url.startsWith('https://graph.facebook.com')
          ? new Response(
              JSON.stringify({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'audio/ogg', file_size: 4 }),
              { headers: { 'content-type': 'application/json' } },
            )
          : new Response(new Uint8Array([1, 2, 3, 4]));
      }) as unknown as typeof fetch,
    });

    await handleInbound(
      {
        kind: 'audio',
        wamid: 'wamid.CANARY3',
        from: CANARY_NUMBER,
        sentAtMs: Date.now(),
        mediaId: `MEDIA-${CANARY}`,
        mimeType: 'audio/ogg',
        voiceNote: true,
        forwarded: false,
      },
      { repo, log, now: () => Date.now(), principal: 'p_test', transcribe },
    );

    const all = written.join('\n');
    expect(all).toContain('voice_transcribed');
    expect(all).not.toContain(CANARY);
    expect(JSON.stringify(driver.exec('SELECT * FROM inbound_messages'))).not.toContain(CANARY);
  });
});

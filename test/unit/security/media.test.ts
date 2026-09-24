/**
 * WhatsApp media download (PLAN §6.1, §6.10). Test-first: this is the one place
 * where an external response decides the URL of a request that carries our Meta
 * access token, so the host check and the redirect check are the security
 * boundary, not a nicety.
 */
import { describe, expect, it } from 'vitest';
import {
  fetchWhatsAppMedia,
  MediaError,
  MAX_AUDIO_BYTES,
  ALLOWED_AUDIO_MIME,
} from '../../../src/channels/whatsapp/media.js';

const TOKEN = 'fake-access-token';
const MEDIA_ID = '1234567890';
const CDN = 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc';

const AUDIO = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);

type Call = { url: string; init: RequestInit | undefined };

/** A fake Meta: one metadata response, then one binary response. */
function fakeMeta(options: {
  metadata?: unknown;
  metadataStatus?: number;
  downloadStatus?: number;
  downloadBody?: Uint8Array;
  downloadHeaders?: Record<string, string>;
}) {
  const calls: Call[] = [];
  const metadata = options.metadata ?? {
    url: CDN,
    mime_type: 'audio/ogg; codecs=opus',
    file_size: AUDIO.byteLength,
    id: MEDIA_ID,
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });

    if (calls.length === 1) {
      return new Response(JSON.stringify(metadata), {
        status: options.metadataStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const body = options.downloadBody ?? AUDIO;
    return new Response(body, {
      status: options.downloadStatus ?? 200,
      headers: { 'content-type': 'audio/ogg', ...options.downloadHeaders },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const reasonOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return 'no_error';
  } catch (error) {
    return error instanceof MediaError ? error.reason : 'wrong_error_type';
  }
};

describe('fetchWhatsAppMedia', () => {
  it('resolves the media id, then downloads the bytes', async () => {
    const { fetchImpl, calls } = fakeMeta({});
    const media = await fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl });

    expect(media.bytes).toEqual(AUDIO);
    expect(media.mimeType).toBe('audio/ogg');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain(MEDIA_ID);
    expect(calls[1]?.url).toBe(CDN);
  });

  it('authenticates both requests, since the CDN url is not public either', async () => {
    const { fetchImpl, calls } = fakeMeta({});
    await fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl });

    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it('never follows a redirect, which would hand the token to whoever it points at', async () => {
    const { fetchImpl, calls } = fakeMeta({});
    await fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl });
    expect(calls[1]?.init?.redirect).toBe('manual');
  });

  it('treats a redirect response as a failure rather than chasing it', async () => {
    const { fetchImpl } = fakeMeta({ downloadStatus: 302 });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'download_failed',
    );
  });

  it('strips the parameters from the declared mime type', async () => {
    const { fetchImpl } = fakeMeta({
      metadata: { url: CDN, mime_type: 'audio/ogg; codecs=opus', file_size: 8 },
    });
    const media = await fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl });
    expect(media.mimeType).toBe('audio/ogg');
  });
});

describe('host validation', () => {
  const rejected = [
    'http://lookaside.fbsbx.com/x', // plaintext
    'https://evil.example.com/x',
    'https://notfbcdn.net/x',
    'https://fbcdn.net.evil.example/x',
    'https://facebook.com.attacker.test/x',
    'https://user:pass@lookaside.fbsbx.com/x',
    'file:///etc/passwd',
    'https://127.0.0.1/x',
    'https://[::1]/x',
  ];

  for (const url of rejected) {
    it(`refuses to download from ${url}`, async () => {
      const { fetchImpl, calls } = fakeMeta({ metadata: { url, mime_type: 'audio/ogg', file_size: 8 } });
      expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
        'untrusted_host',
      );
      // The token was never sent to it.
      expect(calls).toHaveLength(1);
    });
  }

  const accepted = [
    'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
    'https://mmg.whatsapp.net/d/f/x.enc',
    'https://scontent.xx.fbcdn.net/v/t1/x',
    'https://graph.facebook.com/v21.0/1/x',
  ];

  for (const url of accepted) {
    it(`accepts ${new URL(url).hostname}`, async () => {
      const { fetchImpl, calls } = fakeMeta({ metadata: { url, mime_type: 'audio/ogg', file_size: 8 } });
      await fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl });
      expect(calls).toHaveLength(2);
    });
  }
});

describe('size and type limits', () => {
  it('refuses a file the metadata already says is too large, before downloading it', async () => {
    const { fetchImpl, calls } = fakeMeta({
      metadata: { url: CDN, mime_type: 'audio/ogg', file_size: MAX_AUDIO_BYTES + 1 },
    });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'too_large',
    );
    expect(calls).toHaveLength(1);
  });

  it('refuses a body that exceeds the cap even when the metadata understated it', async () => {
    const { fetchImpl } = fakeMeta({
      metadata: { url: CDN, mime_type: 'audio/ogg', file_size: 10 },
      downloadBody: new Uint8Array(MAX_AUDIO_BYTES + 1),
    });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'too_large',
    );
  });

  it('refuses a content-length over the cap without reading the body', async () => {
    const { fetchImpl } = fakeMeta({
      metadata: { url: CDN, mime_type: 'audio/ogg', file_size: 10 },
      downloadHeaders: { 'content-length': String(MAX_AUDIO_BYTES + 1) },
    });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'too_large',
    );
  });

  it('refuses a type that is not audio', async () => {
    const { fetchImpl, calls } = fakeMeta({
      metadata: { url: CDN, mime_type: 'application/pdf', file_size: 8 },
    });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'unsupported_type',
    );
    expect(calls).toHaveLength(1);
  });

  it('accepts every format WhatsApp can actually send', async () => {
    for (const mime of ALLOWED_AUDIO_MIME) {
      const { fetchImpl } = fakeMeta({ metadata: { url: CDN, mime_type: mime, file_size: 8 } });
      const media = await fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl });
      expect(media.mimeType).toBe(mime);
    }
  });

  it('refuses an empty body rather than sending nothing to the transcriber', async () => {
    const { fetchImpl } = fakeMeta({ downloadBody: new Uint8Array(0) });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'empty',
    );
  });
});

describe('failure handling', () => {
  it('reports a failed metadata lookup without reading its body', async () => {
    const { fetchImpl } = fakeMeta({ metadataStatus: 404 });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'metadata_failed',
    );
  });

  it('reports metadata that is missing a url', async () => {
    const { fetchImpl } = fakeMeta({ metadata: { mime_type: 'audio/ogg', file_size: 8 } });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'metadata_malformed',
    );
  });

  it('reports a failed download', async () => {
    const { fetchImpl } = fakeMeta({ downloadStatus: 500 });
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'download_failed',
    );
  });

  it('turns a transport failure into a reason code, not a raw error', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    expect(await reasonOf(fetchWhatsAppMedia(MEDIA_ID, { accessToken: TOKEN, fetchImpl }))).toBe(
      'metadata_failed',
    );
  });

  it('carries a stable error code and no media content in its message', async () => {
    const error = new MediaError('too_large');
    expect(error.message).toBe('E_MEDIA_TOO_LARGE');
  });
});

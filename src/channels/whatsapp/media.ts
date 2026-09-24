/**
 * Downloading inbound media from the WhatsApp Cloud API (PLAN §6.1, §6.10).
 *
 * The webhook carries only a media id. Fetching the bytes takes two requests:
 * one to resolve the id to a short-lived CDN url, and one to download it. Both
 * carry the Meta access token — the CDN url is not public.
 *
 * That second request is the reason this file is careful. Its destination comes
 * from a response body, so an incorrect or hostile url would send our token
 * wherever it pointed. Hence: an explicit host allowlist, HTTPS only, no
 * embedded credentials, and no redirect following. Size and type are checked
 * from the metadata first, so an oversized file costs one request, not a
 * download.
 *
 * Audio is held in memory for the length of one request and never stored.
 */

const GRAPH_VERSION = 'v21.0';
const METADATA_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/**
 * WhatsApp accepts audio up to 16 MB. Half that is minutes of speech at voice
 * note bitrates, and keeps a single request well inside the Worker's memory
 * and the transcriber's file limit (PLAN §2).
 */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

/** The audio formats WhatsApp itself can deliver. Anything else is refused. */
export const ALLOWED_AUDIO_MIME = [
  'audio/aac',
  'audio/amr',
  'audio/mp4',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
] as const;

/** Registrable domains Meta serves media from. Matched as a whole label, never as a substring. */
const TRUSTED_HOSTS = ['fbcdn.net', 'fbsbx.com', 'facebook.com', 'whatsapp.net'] as const;

export type MediaErrorReason =
  | 'metadata_failed'
  | 'metadata_malformed'
  | 'untrusted_host'
  | 'unsupported_type'
  | 'too_large'
  | 'download_failed'
  | 'empty';

export class MediaError extends Error {
  constructor(readonly reason: MediaErrorReason) {
    super(`E_MEDIA_${reason.toUpperCase()}`);
    this.name = 'MediaError';
  }
}

export type MediaFetchConfig = {
  accessToken: string;
  /** Injected so tests never reach the network. */
  fetchImpl?: typeof fetch;
};

export type FetchedMedia = {
  bytes: Uint8Array;
  /** Normalized: lower-cased, parameters stripped. */
  mimeType: string;
};

export async function fetchWhatsAppMedia(
  mediaId: string,
  config: MediaFetchConfig,
): Promise<FetchedMedia> {
  const doFetch = config.fetchImpl ?? fetch;
  const headers = {
    authorization: `Bearer ${config.accessToken}`,
    // Meta's CDN rejects requests with no user agent.
    'user-agent': 'wa-assistant/1.0',
  };

  const metadata = await fetchMetadata(doFetch, mediaId, headers);

  if (!ALLOWED_AUDIO_MIME.includes(metadata.mimeType as (typeof ALLOWED_AUDIO_MIME)[number])) {
    throw new MediaError('unsupported_type');
  }
  if (metadata.fileSize !== null && metadata.fileSize > MAX_AUDIO_BYTES) {
    throw new MediaError('too_large');
  }
  assertTrustedUrl(metadata.url);

  let response: Response;
  try {
    response = await doFetch(metadata.url, {
      headers,
      // A 3xx is refused rather than followed: the token travels with the
      // request, so the destination must stay the one we just validated.
      redirect: 'manual',
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new MediaError('download_failed');
  }

  // `ok` is 200–299, so this also catches the unfollowed 3xx and the status-0
  // opaque redirect that `redirect: 'manual'` produces.
  if (!response.ok) throw new MediaError('download_failed');

  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_AUDIO_BYTES) {
    throw new MediaError('too_large');
  }

  const bytes = await readCapped(response, MAX_AUDIO_BYTES);
  if (bytes.byteLength === 0) throw new MediaError('empty');

  return { bytes, mimeType: metadata.mimeType };
}

type MediaMetadata = { url: string; mimeType: string; fileSize: number | null };

async function fetchMetadata(
  doFetch: typeof fetch,
  mediaId: string,
  headers: Record<string, string>,
): Promise<MediaMetadata> {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(mediaId)}`;

  let response: Response;
  try {
    response = await doFetch(url, { headers, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  } catch {
    throw new MediaError('metadata_failed');
  }

  // The error body can echo request detail, so it is never read (CLAUDE.md).
  if (!response.ok) throw new MediaError('metadata_failed');

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MediaError('metadata_malformed');
  }

  const record = (payload ?? {}) as Record<string, unknown>;
  const mediaUrl = typeof record.url === 'string' ? record.url : '';
  const mimeType = typeof record.mime_type === 'string' ? normalizeMime(record.mime_type) : '';
  if (!mediaUrl || !mimeType) throw new MediaError('metadata_malformed');

  const size = Number(record.file_size);
  return {
    url: mediaUrl,
    mimeType,
    fileSize: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

/** `audio/ogg; codecs=opus` -> `audio/ogg`. */
function normalizeMime(value: string): string {
  return (value.split(';')[0] ?? '').trim().toLowerCase();
}

function assertTrustedUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaError('untrusted_host');
  }

  if (url.protocol !== 'https:') throw new MediaError('untrusted_host');
  // Credentials in the url would be sent instead of, or alongside, our own.
  if (url.username || url.password) throw new MediaError('untrusted_host');

  const host = url.hostname.toLowerCase();
  const trusted = TRUSTED_HOSTS.some((domain) => host === domain || host.endsWith(`.${domain}`));
  if (!trusted) throw new MediaError('untrusted_host');
}

/**
 * Read the body, stopping as soon as it passes the cap. A missing or lying
 * `content-length` must not be able to pull an unbounded body into memory.
 */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) throw new MediaError('too_large');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

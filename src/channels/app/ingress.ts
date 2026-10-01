/**
 * What the Worker checks on an app request before the Durable Object sees it
 * (PLAN §6.18): that the route exists on this channel, the shape of the
 * request, and its size — read against a byte counter, never trusted from a
 * header. Credentials are checked in the Durable Object, where the keys live.
 *
 * Standard `Request` and streams only, so this runs on Node too (invariant 11).
 */
import type { ChannelMode } from '../../core/env.js';

export type AppRoute = {
  method: 'GET' | 'POST';
  pattern: RegExp;
  /** Largest body accepted, in bytes. 0: no body at all. */
  maxBytes: number;
  /** The media type a POST must declare. */
  contentType?: string | readonly string[];
  /** The channels this route exists on. Everywhere else it is a 404. */
  channels: readonly ChannelMode[];
};

const JSON_TYPE = 'application/json';

/** 60 seconds of AAC at 64 kbit/s is about 480 KB; this leaves room and no more. */
export const MAX_VOICE_BYTES = 1024 * 1024;

export const APP_ROUTES: readonly AppRoute[] = [
  // Pairing and the call routes serve the companion on WhatsApp too.
  { method: 'POST', pattern: /^\/app\/pair$/, maxBytes: 8_192, contentType: JSON_TYPE, channels: ['whatsapp', 'app'] },
  { method: 'POST', pattern: /^\/app\/push-token$/, maxBytes: 8_192, contentType: JSON_TYPE, channels: ['whatsapp', 'app'] },
  { method: 'GET', pattern: /^\/device\/dispatch\/[0-9a-f]{32}$/, maxBytes: 0, channels: ['whatsapp', 'app'] },
  { method: 'POST', pattern: /^\/device\/report$/, maxBytes: 1_024, contentType: JSON_TYPE, channels: ['whatsapp', 'app'] },
  // The assistant itself, only when the app is the channel.
  { method: 'POST', pattern: /^\/app\/message$/, maxBytes: 8_192, contentType: JSON_TYPE, channels: ['app'] },
  {
    method: 'POST',
    // The message id, then optionally the conversation it was recorded in.
    pattern:
      /^\/app\/voice\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/,
    maxBytes: MAX_VOICE_BYTES,
    contentType: ['audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm'],
    channels: ['app'],
  },
  { method: 'GET', pattern: /^\/app\/outbox$/, maxBytes: 0, channels: ['app'] },
  { method: 'POST', pattern: /^\/app\/outbox\/ack$/, maxBytes: 4_096, contentType: JSON_TYPE, channels: ['app'] },
  // Action cards (§6.20): a claim consumes the card and returns what to run.
  { method: 'POST', pattern: /^\/app\/action\/claim$/, maxBytes: 1_024, contentType: JSON_TYPE, channels: ['app'] },
  { method: 'POST', pattern: /^\/app\/action\/report$/, maxBytes: 1_024, contentType: JSON_TYPE, channels: ['app'] },
  // Phone reads (§6.21): the phone's answer to a suspended turn. Twenty items of
  // at most a few hundred characters each, as UTF-8 Hebrew, with room for JSON.
  { method: 'POST', pattern: /^\/app\/device-result$/, maxBytes: 32_768, contentType: JSON_TYPE, channels: ['app'] },
];

export type Checked =
  | { ok: true; route: AppRoute; path: string; method: 'GET' | 'POST'; contentType: string; body: Uint8Array }
  | { ok: false; status: 400 | 404 | 413 | 415 };

/**
 * Everything but the credential. A route that does not exist on this channel
 * is indistinguishable from one that does not exist at all.
 */
export async function checkAppRequest(request: Request, channel: ChannelMode): Promise<Checked> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const route = APP_ROUTES.find((r) => r.method === method && r.pattern.test(url.pathname));
  if (!route || !route.channels.includes(channel)) return { ok: false, status: 404 };

  // The signature covers the path, not a query: none is ever sent, so one is refused.
  if (url.search !== '') return { ok: false, status: 400 };

  // A compressed body would be a different body from the one that was signed,
  // and a small one can inflate past every cap. Only identity is accepted.
  const encoding = (request.headers.get('content-encoding') ?? 'identity').trim().toLowerCase();
  if (encoding !== 'identity') return { ok: false, status: 415 };

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (route.contentType !== undefined) {
    const allowed = typeof route.contentType === 'string' ? [route.contentType] : route.contentType;
    if (!allowed.includes(contentType)) return { ok: false, status: 415 };
  }

  const body = await readCapped(request, route.maxBytes);
  if (body === null) return { ok: false, status: 413 };
  return { ok: true, route, path: url.pathname, method: route.method, contentType, body };
}

/**
 * The body, or null when it is longer than `maxBytes`. A declared length is
 * used only to refuse early; the count that decides is the bytes read.
 */
export async function readCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maxBytes)) return null;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

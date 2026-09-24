/**
 * Turns a verified webhook body into normalized events.
 *
 * Runs only after the HMAC has passed, but still treats every field as
 * untrusted: unknown shapes are dropped rather than coerced, and text is
 * length-capped before it goes anywhere else.
 */
import type { InboundEvent } from '../types.js';

const MAX_TEXT_CHARS = 4096;
const MAX_BUTTON_ID_CHARS = 256;
const MAX_MEDIA_ID_CHARS = 128;
const MAX_MIME_CHARS = 128;

export function parseWebhookPayload(payload: unknown): InboundEvent[] {
  const entries = asArray(prop(payload, 'entry'));
  const events: InboundEvent[] = [];

  for (const entry of entries) {
    for (const change of asArray(prop(entry, 'changes'))) {
      if (prop(change, 'field') !== 'messages') continue;
      const value = prop(change, 'value');

      for (const raw of asArray(prop(value, 'messages'))) {
        const event = parseMessage(raw);
        if (event) events.push(event);
      }
      for (const raw of asArray(prop(value, 'statuses'))) {
        const event = parseStatus(raw);
        if (event) events.push(event);
      }
    }
  }
  return events;
}

function parseMessage(raw: unknown): InboundEvent | null {
  const wamid = asString(prop(raw, 'id'));
  const from = asString(prop(raw, 'from'));
  const type = asString(prop(raw, 'type'));
  const sentAtMs = asTimestampMs(prop(raw, 'timestamp'));
  if (!wamid || !from || !type || sentAtMs === null) return null;

  const context = prop(raw, 'context');
  const forwarded =
    prop(context, 'forwarded') === true || prop(context, 'frequently_forwarded') === true;

  const base = { wamid, from, sentAtMs, forwarded };

  if (type === 'text') {
    const body = asString(prop(prop(raw, 'text'), 'body'));
    if (body === null) return null;
    return { kind: 'text', ...base, text: body.slice(0, MAX_TEXT_CHARS) };
  }

  if (type === 'audio') {
    const audio = prop(raw, 'audio');
    const mediaId = asString(prop(audio, 'id'));
    const mimeType = asString(prop(audio, 'mime_type'));
    // A message announcing audio without a media id is unusable, not "audio".
    if (mediaId === null || mimeType === null) return null;
    return {
      kind: 'audio',
      ...base,
      mediaId: mediaId.slice(0, MAX_MEDIA_ID_CHARS),
      mimeType: mimeType.slice(0, MAX_MIME_CHARS),
      voiceNote: prop(audio, 'voice') === true,
    };
  }

  if (type === 'interactive') {
    const interactive = prop(raw, 'interactive');
    if (asString(prop(interactive, 'type')) === 'button_reply') {
      const id = asString(prop(prop(interactive, 'button_reply'), 'id'));
      if (id === null) return null;
      return { kind: 'button', ...base, buttonId: id.slice(0, MAX_BUTTON_ID_CHARS) };
    }
  }

  return { kind: 'unsupported', ...base, messageType: type };
}

function parseStatus(raw: unknown): InboundEvent | null {
  const wamid = asString(prop(raw, 'id'));
  const status = asString(prop(raw, 'status'));
  const sentAtMs = asTimestampMs(prop(raw, 'timestamp'));
  const recipient = asString(prop(raw, 'recipient_id')) ?? '';
  if (!wamid || !status || sentAtMs === null) return null;

  // One number out of the error object and one enum out of the pricing object.
  // Everything else there can echo the message that failed (§6.8, §7.3).
  const firstError = asArray(prop(raw, 'errors'))[0];
  const errorCode = prop(firstError, 'code');
  const pricingCategory = asString(prop(prop(raw, 'pricing'), 'category'));

  return {
    kind: 'status',
    wamid,
    status: status.slice(0, MAX_STATUS_CHARS),
    sentAtMs,
    recipient,
    ...(typeof errorCode === 'number' && Number.isFinite(errorCode) ? { errorCode } : {}),
    ...(pricingCategory ? { pricingCategory: pricingCategory.slice(0, MAX_STATUS_CHARS) } : {}),
  };
}

/** Both fields are enums from Meta; cap them anyway — they arrive over the wire. */
const MAX_STATUS_CHARS = 32;

function prop(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Meta sends unix seconds as a string. */
function asTimestampMs(value: unknown): number | null {
  const seconds = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.trunc(seconds) * 1000;
}

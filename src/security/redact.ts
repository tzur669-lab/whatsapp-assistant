/**
 * The only logger the app may use (CLAUDE.md, PLAN §6.9).
 *
 * It is an allow-shaped redactor: known-sensitive keys are dropped outright at
 * every depth, long strings are truncated, and phone numbers are replaced by a
 * keyed hash. A canary test asserts nothing sensitive reaches the sink.
 */
import { hmacSha256Hex } from './hmac.js';
import { normalizeWaId } from './allowlist.js';

/** Keys whose values may carry message content, identities, or secrets. */
export const BANNED_LOG_FIELDS = [
  'text',
  'body',
  'message',
  'content',
  'title',
  'summary',
  'description',
  'reminderText',
  'query',
  'queryVariants',
  'query_variants',
  // A stored clarification carries the user's own words (§6.11).
  'slots',
  'slotsJson',
  'slots_json',
  'from',
  'to',
  'phone',
  'phoneNumber',
  'waId',
  'wa_id',
  'email',
  'attendees',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'authorization',
  'secret',
  'password',
  'pin',
  'prompt',
  'draft',
  'slots',
  // A transcript is the user's spoken words — message content by another route.
  'transcript',
  'transcription',
  // The media id and its signed url both resolve to the audio itself.
  'mediaId',
  'media_id',
  'mediaUrl',
  'audio',
  // The app channel (§6.18). A pairing code or its MAC is a capability, a push
  // token an address to a person's phone; a signature and a nonce are single-use
  // but say which request was which, and a public key names a device.
  // Not bare `code`: nested error codes (`{ code: 'E_…' }`) are what a log is for.
  'pairingCode',
  'bootstrapCode',
  'mac',
  'pushToken',
  'push_token',
  'signature',
  'nonce',
  'publicKey',
  'public_key',
  // The agent (§6.19). Its history, the model's reply and its tool arguments are
  // message content; a result can carry what others wrote — mail, notifications.
  'history',
  'reply',
  'arguments',
  'args',
  'result',
  'messages',
  'snippet',
  'notification',
  'sms',
  // Phone actions (§6.20): a place, a label, a card's preview and the words a
  // contact or an app is matched by are all the user's content.
  'destination',
  'label',
  'preview',
  'queries',
  // Phone reads (§6.21): what the phone read is other people's words, and the
  // stored turn is the conversation itself.
  'items',
  'sender',
  'name',
  'ciphertext',
  'state',
  // Gemini 3's thought signature (2026-10-08): opaque model data, on a tool
  // call or a message. `signature` is above; these are the wire names.
  'thought_signature',
  'thoughtSignature',
  'extra_content',
  'tool_calls',
] as const;

const BANNED = new Set<string>(BANNED_LOG_FIELDS);
const MAX_STRING = 128;
const MAX_DEPTH = 4;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/** A short, non-reversible, keyed identifier for a principal. */
export async function hashPrincipal(waId: string, logHashKey: string): Promise<string> {
  const normalized = normalizeWaId(waId) ?? waId;
  const mac = await hmacSha256Hex(logHashKey, normalized);
  return `p_${mac.slice(0, 12)}`;
}

export function createLogger(base: LogFields = {}): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...(redact(base, 0) as LogFields),
      ...(redact(fields ?? {}, 0) as LogFields),
    };
    // eslint-disable-next-line no-console -- this is the single sanctioned sink.
    console.log(safeStringify(record));
  };

  return {
    debug: (e, f) => emit('debug', e, f),
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
  };
}

function redact(value: unknown, depth: number, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}\u2026` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object') return undefined;

  if (depth >= MAX_DEPTH) return '[depth]';
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((v) => redact(v, depth + 1, seen));
  }

  const out: LogFields = {};
  for (const [key, v] of Object.entries(value as LogFields)) {
    if (BANNED.has(key)) continue;
    const cleaned = redact(v, depth + 1, seen);
    if (cleaned !== undefined) out[key] = cleaned;
  }
  return out;
}

function safeStringify(record: unknown): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'log_serialize_failed' });
  }
}

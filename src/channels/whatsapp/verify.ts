/**
 * Webhook ingress checks. Order is fixed by CLAUDE.md invariant 9:
 * raw body -> HMAC -> parse -> allowlist -> dedupe.
 *
 * Nothing here parses JSON. The signature covers the exact bytes Meta sent,
 * so re-serializing before verifying would break it.
 */
import { hmacSha256Hex, timingSafeEqualHex } from '../../security/hmac.js';
import { MAX_WEBHOOK_BODY_BYTES } from './limits.js';

export type SignatureFailure =
  | 'not_configured'
  | 'body_too_large'
  | 'missing_signature'
  | 'bad_signature_format'
  | 'signature_mismatch';

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailure };

const PREFIX = 'sha256=';

/** Verify `X-Hub-Signature-256` against the raw request body. */
export async function verifyWebhookSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): Promise<SignatureResult> {
  if (!appSecret) return { ok: false, reason: 'not_configured' };
  if (rawBody.length > MAX_WEBHOOK_BODY_BYTES) return { ok: false, reason: 'body_too_large' };
  if (!header) return { ok: false, reason: 'missing_signature' };
  if (!header.startsWith(PREFIX)) return { ok: false, reason: 'bad_signature_format' };

  const provided = header.slice(PREFIX.length);
  const expected = await hmacSha256Hex(appSecret, rawBody);
  return timingSafeEqualHex(provided, expected)
    ? { ok: true }
    : { ok: false, reason: 'signature_mismatch' };
}

export type HandshakeParams = {
  mode: string | null | undefined;
  token: string | null | undefined;
  challenge: string | null | undefined;
};

export type HandshakeResult = { ok: true; challenge: string } | { ok: false };

/** GET /wa/webhook subscription handshake. */
export function verifyWebhookHandshake(
  params: HandshakeParams,
  verifyToken: string,
): HandshakeResult {
  if (!verifyToken) return { ok: false };
  if (params.mode !== 'subscribe') return { ok: false };
  if (!params.token || !params.challenge) return { ok: false };
  if (!constantTimeEqual(params.token, verifyToken)) return { ok: false };
  return { ok: true, challenge: params.challenge };
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * HMAC helpers built on WebCrypto, which exists on both Workers and Node 20+.
 * Kept free of platform imports so the core stays portable (PLAN §3.4).
 */

const encoder = new TextEncoder();

/** HMAC-SHA256 of `message` under `secret`, lowercase hex. */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const HEX = /^[0-9a-f]+$/;

/**
 * Constant-time comparison of two hex digests.
 *
 * Length and character-class checks short-circuit, which is safe: both are
 * public properties of the encoding, not of the secret. The value comparison
 * itself always visits every byte.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length === 0 || x.length !== y.length) return false;
  if (!HEX.test(x) || !HEX.test(y)) return false;

  let diff = 0;
  for (let i = 0; i < x.length; i++) {
    diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The app channel's two credentials (PLAN §6.18).
 *
 * **Every request is signed.** At pairing the phone makes a P-256 key pair in
 * the Android Keystore that can never be exported, and gives us the public
 * half. Each request then carries a signature over one canonical string, so a
 * TLS-intercepting proxy on the home network (Netspark) can read a request but
 * cannot forge a new one, and cannot replay an old one past the nonce.
 *
 * **Pairing is a MAC, not a code in transit.** The pairing code is typed into
 * the app and never sent. The app proves it knows the code with an HMAC over
 * its own public key and push address, so an interceptor that sees the MAC
 * cannot swap in a key of its own — and at 100 bits, cannot brute-force the
 * code from the MAC offline either.
 *
 * WebCrypto only, which both Workers and Node provide (invariant 11).
 */
import { timingSafeEqualHex } from '../../security/hmac.js';

export const SIGNATURE_VERSION = 'ASSISTANT-REQ-v1';
export const PAIR_VERSION = 'ASSISTANT-PAIR-v1';

/** How far the phone's clock may be from ours, either way. */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;
/**
 * How long a nonce is remembered, counted from the request's own timestamp:
 * the skew window plus a minute, so it outlives every moment the same signed
 * request could still be accepted.
 */
export const NONCE_TTL_MS = CLOCK_SKEW_MS + 60 * 1000;

const DEVICE_ID = /^[0-9a-f]{32}$/;
const NONCE = /^[0-9a-f]{32}$/;
const TIMESTAMP = /^[0-9]{13}$/;
/** A P-256 DER signature is at most 72 bytes: 96 characters of base64. */
const SIGNATURE_B64 = /^[A-Za-z0-9+/]{8,96}={0,2}$/;

const encoder = new TextEncoder();

export type SignedHeaders = {
  deviceId: string;
  timestamp: number;
  nonce: string;
  /** DER, as Android's SHA256withECDSA produces it. */
  signature: Uint8Array;
};

/** The four headers, or null when any is missing or off-shape. */
export function parseSignedHeaders(header: (name: string) => string | null | undefined): SignedHeaders | null {
  const deviceId = header('x-device-id') ?? '';
  const timestamp = header('x-timestamp') ?? '';
  const nonce = header('x-nonce') ?? '';
  const signature = header('x-signature') ?? '';

  if (!DEVICE_ID.test(deviceId) || !TIMESTAMP.test(timestamp) || !NONCE.test(nonce)) return null;
  if (!SIGNATURE_B64.test(signature)) return null;

  const bytes = fromBase64(signature);
  if (!bytes) return null;
  return { deviceId, timestamp: Number(timestamp), nonce, signature: bytes };
}

/**
 * The string the phone signs. UTF-8, lines joined by a single `\n`, no
 * trailing newline. The body enters only as the hex SHA-256 of its raw bytes,
 * so no JSON canonicalisation is needed — or possible to get wrong.
 */
export function canonicalRequest(parts: {
  method: string;
  path: string;
  deviceId: string;
  timestamp: number;
  nonce: string;
  bodySha256Hex: string;
}): string {
  return [
    SIGNATURE_VERSION,
    parts.method.toUpperCase(),
    parts.path,
    parts.deviceId,
    String(parts.timestamp),
    parts.nonce,
    parts.bodySha256Hex,
  ].join('\n');
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

export function withinClockSkew(timestamp: number, nowMs: number): boolean {
  return Math.abs(nowMs - timestamp) <= CLOCK_SKEW_MS;
}

/** The phone's public key, as base64 of its X.509 SubjectPublicKeyInfo. */
export async function importDeviceKey(spkiBase64: string): Promise<CryptoKey | null> {
  const bytes = fromBase64(spkiBase64);
  if (!bytes || bytes.length < 26 || bytes.length > 200) return null;
  try {
    return await crypto.subtle.importKey('spki', bytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'verify',
    ]);
  } catch {
    return null;
  }
}

export async function verifyRequestSignature(
  key: CryptoKey,
  canonical: string,
  derSignature: Uint8Array,
): Promise<boolean> {
  const raw = derToRawEcdsa(derSignature);
  if (!raw) return false;
  try {
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw, encoder.encode(canonical));
  } catch {
    return false;
  }
}

/** The P-256 group order. r and s must both lie in [1, n-1]. */
const P256_N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');

/**
 * Strict DER → the 64-byte r||s WebCrypto verifies.
 *
 * Strict because a lenient parser is where signature bugs live: short-form
 * lengths only, exact lengths, minimal positive integers, nothing trailing.
 * Malleability (s versus n-s) is deliberately not policed — nothing here is
 * ever keyed on the signature's bytes; replay is stopped by the nonce, which
 * the signature covers.
 */
export function derToRawEcdsa(der: Uint8Array): Uint8Array | null {
  if (der.length < 8 || der.length > 72) return null;
  if (der[0] !== 0x30 || der[1] !== der.length - 2) return null;

  let offset = 2;
  const out = new Uint8Array(64);

  for (let part = 0; part < 2; part++) {
    if (der[offset] !== 0x02) return null;
    const length = der[offset + 1];
    if (length === undefined || length < 1 || length > 33) return null;
    const start = offset + 2;
    const end = start + length;
    if (end > der.length) return null;

    const value = der.subarray(start, end);
    const first = value[0]!;
    if (first & 0x80) return null; // negative
    if (first === 0x00 && (length === 1 || (value[1]! & 0x80) === 0)) return null; // non-minimal

    const magnitude = first === 0x00 ? value.subarray(1) : value;
    if (magnitude.length > 32) return null;

    const n = BigInt(`0x${toHex(magnitude) || '0'}`);
    if (n === 0n || n >= P256_N) return null;

    out.set(magnitude, part * 32 + (32 - magnitude.length));
    offset = end;
  }

  return offset === der.length ? out : null;
}

// -- pairing ------------------------------------------------------------------

/** Crockford base32: no I, L, O or U, so nothing reads as something else. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 20;
const CODE = new RegExp(`^[${CROCKFORD}]{${PAIRING_CODE_LENGTH}}$`);

/** 20 characters, 5 bits each: 100 bits, uniform (256 is a multiple of 32). */
export function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH));
  return [...bytes].map((b) => CROCKFORD[b & 31]).join('');
}

/** For display only: groups of four, dash-separated. */
export function formatPairingCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** What the user typed, as the canonical code, or null. */
export function normalizePairingCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  return CODE.test(cleaned) ? cleaned : null;
}

export function pairingMessage(publicKey: string, pushToken: string, timestamp: number): string {
  return [PAIR_VERSION, publicKey, pushToken, String(timestamp)].join('\n');
}

/** HMAC-SHA256 keyed by the code itself, lowercase hex. */
export async function pairingMac(
  code: string,
  publicKey: string,
  pushToken: string,
  timestamp: number,
): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(code), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(pairingMessage(publicKey, pushToken, timestamp)));
  return toHex(new Uint8Array(mac));
}

export function pairingMacMatches(expectedHex: string, presentedHex: string): boolean {
  return timingSafeEqualHex(expectedHex, presentedHex);
}

// -- bytes --------------------------------------------------------------------

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function fromBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * The app channel's request signature and pairing MAC (PLAN §6.18).
 *
 * Written before the implementation. The canonical string is pinned byte for
 * byte, because the phone builds the same string in Kotlin and a one-character
 * drift would reject every request — or, worse, sign something other than what
 * the server checks.
 */
import { describe, expect, it } from 'vitest';
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import {
  canonicalRequest,
  derToRawEcdsa,
  formatPairingCode,
  generatePairingCode,
  importDeviceKey,
  normalizePairingCode,
  pairingMac,
  pairingMessage,
  parseSignedHeaders,
  sha256Hex,
  verifyRequestSignature,
  withinClockSkew,
  CLOCK_SKEW_MS,
} from '../../../src/channels/app/verify.js';

const N = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551');

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  return { spki, privateKey };
}

/** What Android's SHA256withECDSA produces: an ASN.1 DER signature. */
function signDer(privateKey: ReturnType<typeof keyPair>['privateKey'], message: string): Uint8Array {
  const signer = createSign('SHA256');
  signer.update(Buffer.from(message, 'utf8'));
  return new Uint8Array(signer.sign({ key: privateKey, dsaEncoding: 'der' }));
}

function intBytes(n: bigint): number[] {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = [...Buffer.from(hex, 'hex')];
  return bytes[0]! >= 0x80 ? [0, ...bytes] : bytes;
}

function der(r: bigint, s: bigint): Uint8Array {
  const ri = intBytes(r);
  const si = intBytes(s);
  const body = [0x02, ri.length, ...ri, 0x02, si.length, ...si];
  return new Uint8Array([0x30, body.length, ...body]);
}

function rsOf(signature: Uint8Array): { r: bigint; s: bigint } {
  const raw = derToRawEcdsa(signature)!;
  const hex = Buffer.from(raw).toString('hex');
  return { r: BigInt(`0x${hex.slice(0, 64)}`), s: BigInt(`0x${hex.slice(64)}`) };
}

describe('canonicalRequest', () => {
  it('is pinned byte for byte', () => {
    expect(
      canonicalRequest({
        method: 'post',
        path: '/app/message',
        deviceId: '0123456789abcdef0123456789abcdef',
        timestamp: 1_790_000_000_000,
        nonce: 'fedcba9876543210fedcba9876543210',
        bodySha256Hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      }),
    ).toBe(
      [
        'ASSISTANT-REQ-v1',
        'POST',
        '/app/message',
        '0123456789abcdef0123456789abcdef',
        '1790000000000',
        'fedcba9876543210fedcba9876543210',
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      ].join('\n'),
    );
  });
});

describe('sha256Hex', () => {
  it('hashes the empty body to the well-known digest', async () => {
    expect(await sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes bytes, not a re-serialisation of them', async () => {
    const a = await sha256Hex(new TextEncoder().encode('{"a":1}'));
    const b = await sha256Hex(new TextEncoder().encode('{"a": 1}'));
    expect(a).not.toBe(b);
  });
});

describe('derToRawEcdsa', () => {
  const { privateKey } = keyPair();
  const good = signDer(privateKey, 'x');

  it('turns a DER signature into 64 bytes of r||s', () => {
    expect(derToRawEcdsa(good)?.length).toBe(64);
  });

  it('refuses a truncated signature', () => {
    expect(derToRawEcdsa(good.slice(0, good.length - 1))).toBeNull();
  });

  it('refuses trailing bytes', () => {
    expect(derToRawEcdsa(new Uint8Array([...good, 0]))).toBeNull();
  });

  it('refuses a non-minimal integer', () => {
    const { r, s } = rsOf(good);
    // One zero byte more than the minimal encoding needs.
    const ri = [0, ...intBytes(r)];
    const si = intBytes(s);
    const body = [0x02, ri.length, ...ri, 0x02, si.length, ...si];
    expect(derToRawEcdsa(new Uint8Array([0x30, body.length, ...body]))).toBeNull();
  });

  it('refuses a negative integer', () => {
    // 0x80 with no leading zero reads as negative in DER.
    const body = [0x02, 1, 0x80, 0x02, 1, 0x01];
    expect(derToRawEcdsa(new Uint8Array([0x30, body.length, ...body]))).toBeNull();
  });

  it('refuses r = 0 and r >= n', () => {
    expect(derToRawEcdsa(der(0n, 1n))).toBeNull();
    expect(derToRawEcdsa(der(N, 1n))).toBeNull();
  });

  it('refuses long-form lengths and a wrong outer tag', () => {
    const inner = good.slice(2);
    expect(derToRawEcdsa(new Uint8Array([0x30, 0x81, inner.length, ...inner]))).toBeNull();
    expect(derToRawEcdsa(new Uint8Array([0x31, inner.length, ...inner]))).toBeNull();
  });
});

describe('verifyRequestSignature', () => {
  const { spki, privateKey } = keyPair();
  const canonical = canonicalRequest({
    method: 'POST',
    path: '/app/message',
    deviceId: '0123456789abcdef0123456789abcdef',
    timestamp: 1_790_000_000_000,
    nonce: 'fedcba9876543210fedcba9876543210',
    bodySha256Hex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  });

  it('accepts the signature the phone made', async () => {
    const key = await importDeviceKey(spki);
    expect(await verifyRequestSignature(key!, canonical, signDer(privateKey, canonical))).toBe(true);
  });

  it('accepts the high-S twin, since nothing is keyed on signature bytes', async () => {
    const key = await importDeviceKey(spki);
    const { r, s } = rsOf(signDer(privateKey, canonical));
    expect(await verifyRequestSignature(key!, canonical, der(r, N - s))).toBe(true);
  });

  it('refuses a signature over a different path or body', async () => {
    const key = await importDeviceKey(spki);
    const signature = signDer(privateKey, canonical);
    expect(await verifyRequestSignature(key!, canonical.replace('/app/message', '/app/voice'), signature)).toBe(false);
    expect(await verifyRequestSignature(key!, `${canonical}0`, signature)).toBe(false);
  });

  it('refuses another device’s key', async () => {
    const other = await importDeviceKey(keyPair().spki);
    expect(await verifyRequestSignature(other!, canonical, signDer(privateKey, canonical))).toBe(false);
  });

  it('refuses malformed DER instead of throwing', async () => {
    const key = await importDeviceKey(spki);
    expect(await verifyRequestSignature(key!, canonical, new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe('importDeviceKey', () => {
  it('returns null for anything that is not a P-256 SPKI key', async () => {
    expect(await importDeviceKey('not base64 !!')).toBeNull();
    expect(await importDeviceKey(Buffer.from('short').toString('base64'))).toBeNull();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
    expect(await importDeviceKey(rsa.export({ type: 'spki', format: 'der' }).toString('base64'))).toBeNull();
  });
});

describe('parseSignedHeaders', () => {
  const headers = (over: Record<string, string> = {}) => {
    const all: Record<string, string> = {
      'x-device-id': '0123456789abcdef0123456789abcdef',
      'x-timestamp': '1790000000000',
      'x-nonce': 'fedcba9876543210fedcba9876543210',
      'x-signature': Buffer.from([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]).toString('base64'),
      ...over,
    };
    return (name: string) => all[name] ?? null;
  };

  it('reads the four headers', () => {
    const parsed = parseSignedHeaders(headers());
    expect(parsed?.deviceId).toBe('0123456789abcdef0123456789abcdef');
    expect(parsed?.timestamp).toBe(1_790_000_000_000);
    expect(parsed?.signature.length).toBe(8);
  });

  it('refuses anything off-shape', () => {
    expect(parseSignedHeaders(headers({ 'x-device-id': 'ABC' }))).toBeNull();
    expect(parseSignedHeaders(headers({ 'x-timestamp': '1.5e12' }))).toBeNull();
    expect(parseSignedHeaders(headers({ 'x-nonce': 'FEDCBA9876543210FEDCBA9876543210' }))).toBeNull();
    expect(parseSignedHeaders(headers({ 'x-signature': 'A'.repeat(200) }))).toBeNull();
  });
});

describe('withinClockSkew', () => {
  it('allows five minutes either way, and no more', () => {
    const now = 1_790_000_000_000;
    expect(withinClockSkew(now - CLOCK_SKEW_MS, now)).toBe(true);
    expect(withinClockSkew(now + CLOCK_SKEW_MS, now)).toBe(true);
    expect(withinClockSkew(now - CLOCK_SKEW_MS - 1, now)).toBe(false);
    expect(withinClockSkew(now + CLOCK_SKEW_MS + 1, now)).toBe(false);
  });
});

describe('pairing codes', () => {
  it('generates 20 Crockford characters, shown in groups of four', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{20}$/);
    expect(formatPairingCode(code)).toMatch(/^([0-9A-HJKMNP-TV-Z]{4}-){4}[0-9A-HJKMNP-TV-Z]{4}$/);
  });

  it('forgives case, dashes, spaces, and the letters people mistype for digits', () => {
    expect(normalizePairingCode('abcd-efgh jkmn-pqrs-tvwx')).toBe('ABCDEFGHJKMNPQRSTVWX');
    expect(normalizePairingCode('oOiI-lL00-0000-0000-0000')).toBe('00111100000000000000');
  });

  it('refuses the wrong length or a letter Crockford leaves out', () => {
    expect(normalizePairingCode('ABCD')).toBeNull();
    expect(normalizePairingCode('UUUU-UUUU-UUUU-UUUU-UUUU')).toBeNull();
    expect(normalizePairingCode('{"key": "x"}')).toBeNull();
  });
});

describe('pairingMac', () => {
  it('binds the code to this public key, push address and moment', async () => {
    const message = pairingMessage('PUBKEY', 'push-token', 1_790_000_000_000);
    expect(message).toBe('ASSISTANT-PAIR-v1\nPUBKEY\npush-token\n1790000000000');

    const expected = createHmac('sha256', 'ABCDEFGHJKMNPQRSTVWX').update(message).digest('hex');
    expect(await pairingMac('ABCDEFGHJKMNPQRSTVWX', 'PUBKEY', 'push-token', 1_790_000_000_000)).toBe(expected);
  });

  it('changes when the key is swapped', async () => {
    const a = await pairingMac('ABCDEFGHJKMNPQRSTVWX', 'KEY-A', 'p', 1);
    const b = await pairingMac('ABCDEFGHJKMNPQRSTVWX', 'KEY-B', 'p', 1);
    expect(a).not.toBe(b);
  });
});

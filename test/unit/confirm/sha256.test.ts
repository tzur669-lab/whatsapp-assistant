/**
 * The confirmation system hashes nonces with a hand-written SHA-256, because
 * those checks must be synchronous (see `pending.ts`). Hand-written crypto is
 * only acceptable if it is proven, so this checks it two ways: against the
 * published FIPS 180-4 vectors, and against WebCrypto over random input.
 */
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../src/confirm/pending.js';

const encoder = new TextEncoder();
const hash = (text: string) => sha256Hex(encoder.encode(text));

async function webcrypto(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('sha256Hex — published vectors', () => {
  it('hashes the empty string', () => {
    expect(hash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes "abc"', () => {
    expect(hash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('hashes the 448-bit message', () => {
    expect(hash('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('hashes a message spanning several blocks', () => {
    expect(hash('a'.repeat(1_000_000)).slice(0, 16)).toBe('cdc76e5c9914fb92');
  });
});

describe('sha256Hex — agrees with WebCrypto', () => {
  it('matches across lengths that straddle the padding boundaries', async () => {
    // 55/56 and 63/64 are where the length field forces an extra block.
    for (const length of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 200]) {
      const input = 'x'.repeat(length);
      expect(hash(input), `length ${length}`).toBe(await webcrypto(input));
    }
  });

  it('matches on hex nonces, which is what it actually hashes', async () => {
    for (let i = 0; i < 20; i++) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const nonce = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(hash(nonce)).toBe(await webcrypto(nonce));
    }
  });

  it('matches on Hebrew text, where UTF-8 is multi-byte', async () => {
    for (const text of ['שלום', 'תזכיר לי מחר ב-8 להתקשר לאבא', 'א'.repeat(100)]) {
      expect(hash(text)).toBe(await webcrypto(text));
    }
  });

  it('matches on JSON, which is what the input hash covers', async () => {
    const json = JSON.stringify({ text: 'להתקשר לאבא', dueAtUtc: 1790000000000, nested: [1, 2, 3] });
    expect(hash(json)).toBe(await webcrypto(json));
  });
});

describe('sha256Hex — basic properties', () => {
  it('is 64 hex characters', () => {
    expect(hash('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes completely for a one-character difference', () => {
    const a = hash('nonce-a');
    const b = hash('nonce-b');
    let same = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) same++;
    expect(same).toBeLessThan(24);
  });
});

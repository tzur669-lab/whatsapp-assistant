import { describe, expect, it } from 'vitest';
import { timingSafeEqualHex, hmacSha256Hex } from '../../../src/security/hmac.js';

const SECRET = 'test-app-secret';

describe('hmacSha256Hex', () => {
  it('matches a known vector', async () => {
    // Computed independently with Node crypto.
    const mac = await hmacSha256Hex('key', 'The quick brown fox jumps over the lazy dog');
    expect(mac).toBe('f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8');
  });

  it('is stable for the same input', async () => {
    const a = await hmacSha256Hex(SECRET, '{"a":1}');
    const b = await hmacSha256Hex(SECRET, '{"a":1}');
    expect(a).toBe(b);
  });

  it('changes when a single byte of the body changes', async () => {
    const a = await hmacSha256Hex(SECRET, '{"a":1}');
    const b = await hmacSha256Hex(SECRET, '{"a":2}');
    expect(a).not.toBe(b);
  });
});

describe('timingSafeEqualHex', () => {
  it('accepts identical hex strings', () => {
    expect(timingSafeEqualHex('abcdef01', 'abcdef01')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(timingSafeEqualHex('ABCDEF01', 'abcdef01')).toBe(true);
  });

  it('rejects different values of equal length', () => {
    expect(timingSafeEqualHex('abcdef01', 'abcdef02')).toBe(false);
  });

  it('rejects different lengths without throwing', () => {
    expect(timingSafeEqualHex('abcd', 'abcdef01')).toBe(false);
  });

  it('rejects empty input', () => {
    expect(timingSafeEqualHex('', '')).toBe(false);
    expect(timingSafeEqualHex('', 'abcd')).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(timingSafeEqualHex('zzzz', 'zzzz')).toBe(false);
  });
});

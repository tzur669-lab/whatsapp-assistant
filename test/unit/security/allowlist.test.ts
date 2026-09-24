import { describe, expect, it } from 'vitest';
import { parseAllowlist, isAllowed, normalizeWaId } from '../../../src/security/allowlist.js';

describe('normalizeWaId', () => {
  it('strips non-digits', () => {
    expect(normalizeWaId('+972-50-000-0000')).toBe('972500000000');
    expect(normalizeWaId(' 972 50 000 0000 ')).toBe('972500000000');
  });

  it('returns null for input with no digits', () => {
    expect(normalizeWaId('abc')).toBeNull();
    expect(normalizeWaId('')).toBeNull();
  });

  it('returns null for implausible lengths', () => {
    expect(normalizeWaId('12345')).toBeNull();
    expect(normalizeWaId('1'.repeat(20))).toBeNull();
  });
});

describe('parseAllowlist', () => {
  it('parses a comma-separated list and normalizes each entry', () => {
    expect(parseAllowlist('+972500000000, 972500000001')).toEqual([
      '972500000000',
      '972500000001',
    ]);
  });

  it('drops blanks and duplicates', () => {
    expect(parseAllowlist('972500000000,,972500000000, ')).toEqual(['972500000000']);
  });

  it('returns an empty list for undefined or empty config', () => {
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist('')).toEqual([]);
  });

  it('drops malformed entries rather than accepting them', () => {
    expect(parseAllowlist('972500000000,not-a-number')).toEqual(['972500000000']);
  });
});

describe('isAllowed', () => {
  const list = parseAllowlist('+972500000000');

  it('accepts a listed number in any format', () => {
    expect(isAllowed('972500000000', list)).toBe(true);
    expect(isAllowed('+972-50-000-0000', list)).toBe(true);
  });

  it('rejects an unlisted number', () => {
    expect(isAllowed('972500000009', list)).toBe(false);
  });

  it('fails closed on an empty allowlist', () => {
    expect(isAllowed('972500000000', [])).toBe(false);
  });

  it('fails closed on unparseable input', () => {
    expect(isAllowed('', list)).toBe(false);
    expect(isAllowed('abc', list)).toBe(false);
  });
});

/**
 * Token encryption (PLAN §6.6, §7.2). Test-first per CLAUDE.md.
 *
 * A Google refresh token is the one secret in this system that grants standing
 * access to real data, and it is the only thing stored encrypted at the app
 * level. The key is versioned so rotation is additive rather than a migration
 * (PLAN, ops/rotate-secrets.md).
 */
import { describe, expect, it } from 'vitest';
import {
  encryptToken,
  decryptToken,
  parseKeyring,
  CIPHERTEXT_PREFIX,
} from '../../../src/security/crypto.js';

// Obviously fake 32-byte keys, base64.
const KEY_V1 = Buffer.alloc(32, 1).toString('base64');
const KEY_V2 = Buffer.alloc(32, 2).toString('base64');

const keyring = parseKeyring({ TOKEN_ENC_KEY_V1: KEY_V1, TOKEN_ENC_KEY_V2: KEY_V2 });
const v1Only = parseKeyring({ TOKEN_ENC_KEY_V1: KEY_V1 });

const TOKEN = '1//0fake-refresh-token-value';
const AAD = { provider: 'google', account: 'primary' };

describe('parseKeyring', () => {
  it('reads every versioned key and picks the highest as current', () => {
    expect(keyring.currentVersion).toBe(2);
    expect([...keyring.versions].sort()).toEqual([1, 2]);
  });

  it('works with a single key', () => {
    expect(v1Only.currentVersion).toBe(1);
  });

  it('ignores unrelated environment entries', () => {
    const ring = parseKeyring({ TOKEN_ENC_KEY_V1: KEY_V1, GROQ_API_KEY: 'gsk_x', OTHER: 'y' });
    expect([...ring.versions]).toEqual([1]);
  });

  it('rejects a key that is not 32 bytes', () => {
    expect(() => parseKeyring({ TOKEN_ENC_KEY_V1: Buffer.alloc(16, 1).toString('base64') })).toThrow();
  });

  it('rejects a key that is not valid base64', () => {
    expect(() => parseKeyring({ TOKEN_ENC_KEY_V1: 'not base64 !!' })).toThrow();
  });

  it('throws when no key is configured at all, rather than running unencrypted', () => {
    expect(() => parseKeyring({})).toThrow();
  });
});

describe('encryptToken / decryptToken', () => {
  it('round-trips', async () => {
    const ciphertext = await encryptToken(TOKEN, keyring, AAD);
    expect(await decryptToken(ciphertext, keyring, AAD)).toBe(TOKEN);
  });

  it('round-trips a token with Hebrew and emoji, which UTF-8 makes multi-byte', async () => {
    const odd = 'טוקן-בדיקה 🔐 with spaces';
    expect(await decryptToken(await encryptToken(odd, keyring, AAD), keyring, AAD)).toBe(odd);
  });

  it('never contains the plaintext', async () => {
    const ciphertext = await encryptToken(TOKEN, keyring, AAD);
    expect(ciphertext).not.toContain(TOKEN);
    expect(ciphertext).not.toContain('refresh-token');
  });

  it('is tagged with its key version, so rotation can be additive', async () => {
    const ciphertext = await encryptToken(TOKEN, keyring, AAD);
    expect(ciphertext.startsWith(`${CIPHERTEXT_PREFIX}.2.`)).toBe(true);
  });

  it('uses a fresh nonce every time, so the same token encrypts differently', async () => {
    const a = await encryptToken(TOKEN, keyring, AAD);
    const b = await encryptToken(TOKEN, keyring, AAD);
    expect(a).not.toBe(b);
    expect(await decryptToken(b, keyring, AAD)).toBe(TOKEN);
  });

  it('decrypts a value written under an older key', async () => {
    const old = await encryptToken(TOKEN, v1Only, AAD);
    // The keyring still holds v1, so the newer deployment can read it.
    expect(await decryptToken(old, keyring, AAD)).toBe(TOKEN);
  });

  it('fails when the key version is no longer in the keyring', async () => {
    const underV2 = await encryptToken(TOKEN, keyring, AAD);
    await expect(decryptToken(underV2, v1Only, AAD)).rejects.toThrow(/key/i);
  });
});

describe('tampering', () => {
  it('refuses ciphertext whose bytes were altered', async () => {
    const ciphertext = await encryptToken(TOKEN, keyring, AAD);
    const [prefix, version, payload] = ciphertext.split('.');
    const flipped = [...(payload ?? '')];
    flipped[10] = flipped[10] === 'A' ? 'B' : 'A';
    await expect(
      decryptToken(`${prefix}.${version}.${flipped.join('')}`, keyring, AAD),
    ).rejects.toThrow();
  });

  it('refuses a different provider in the associated data', async () => {
    const ciphertext = await encryptToken(TOKEN, keyring, AAD);
    await expect(
      decryptToken(ciphertext, keyring, { provider: 'microsoft', account: 'primary' }),
    ).rejects.toThrow();
  });

  it('refuses a different account in the associated data', async () => {
    // A token bound to one account must not decrypt for another.
    const ciphertext = await encryptToken(TOKEN, keyring, AAD);
    await expect(
      decryptToken(ciphertext, keyring, { provider: 'google', account: 'other' }),
    ).rejects.toThrow();
  });

  it('refuses a malformed value rather than returning something', async () => {
    for (const bad of ['', 'nonsense', 'enc.1', 'enc.x.abcd', `${CIPHERTEXT_PREFIX}.1.!!!`]) {
      await expect(decryptToken(bad, keyring, AAD)).rejects.toThrow();
    }
  });

  it('refuses a value that was never encrypted, even if it looks like a token', async () => {
    await expect(decryptToken(TOKEN, keyring, AAD)).rejects.toThrow();
  });
});

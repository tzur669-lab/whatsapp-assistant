/**
 * Token encryption (PLAN §6.6, §7.2).
 *
 * A Google refresh token is the one stored secret that grants standing access
 * to real data, so it is encrypted at the application level rather than trusted
 * to platform storage alone.
 *
 * AES-256-GCM, with the provider and account as associated data: a token is
 * cryptographically bound to the integration it belongs to, so a row copied
 * between integrations will not decrypt.
 *
 * Keys are versioned (`TOKEN_ENC_KEY_V1`, `V2`, …) and the ciphertext carries
 * its version. Rotation is therefore additive — add the new key, re-encrypt,
 * and only then remove the old one — instead of a migration that could strand
 * every stored token (ops/rotate-secrets.md).
 */

/** Marks a value as produced by this module. */
export const CIPHERTEXT_PREFIX = 'enc';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_PATTERN = /^TOKEN_ENC_KEY_V(\d+)$/;

export type AssociatedData = { provider: string; account: string };

export type Keyring = {
  /** The version new ciphertext is written under: the highest available. */
  currentVersion: number;
  versions: ReadonlySet<number>;
  keyFor(version: number): Uint8Array | undefined;
};

export class CryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoError';
  }
}

/**
 * Collect every `TOKEN_ENC_KEY_V<n>` from the environment.
 *
 * Throws when nothing is configured. Running with no key would mean storing
 * tokens in the clear, which is worse than refusing to start.
 */
export function parseKeyring(env: Record<string, string | undefined>): Keyring {
  const keys = new Map<number, Uint8Array>();

  for (const [name, value] of Object.entries(env)) {
    const match = KEY_PATTERN.exec(name);
    if (!match || !value) continue;

    const version = Number(match[1]);
    const bytes = decodeBase64(value);
    if (bytes === null) {
      throw new CryptoError(`${name} is not valid base64`);
    }
    if (bytes.length !== KEY_BYTES) {
      throw new CryptoError(`${name} must be ${KEY_BYTES} bytes, got ${bytes.length}`);
    }
    keys.set(version, bytes);
  }

  if (keys.size === 0) {
    throw new CryptoError('no TOKEN_ENC_KEY_V<n> configured; refusing to store tokens unencrypted');
  }

  const currentVersion = Math.max(...keys.keys());
  return {
    currentVersion,
    versions: new Set(keys.keys()),
    keyFor: (version) => keys.get(version),
  };
}

/** `enc.<version>.<base64(iv || ciphertext)>` */
export async function encryptToken(
  plaintext: string,
  keyring: Keyring,
  aad: AssociatedData,
): Promise<string> {
  const raw = keyring.keyFor(keyring.currentVersion);
  if (!raw) throw new CryptoError(`no key for version ${keyring.currentVersion}`);

  const key = await importKey(raw, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encodeAad(aad) },
    key,
    new TextEncoder().encode(plaintext),
  );

  const payload = new Uint8Array(iv.length + ciphertext.byteLength);
  payload.set(iv, 0);
  payload.set(new Uint8Array(ciphertext), iv.length);

  return `${CIPHERTEXT_PREFIX}.${keyring.currentVersion}.${encodeBase64(payload)}`;
}

export async function decryptToken(
  value: string,
  keyring: Keyring,
  aad: AssociatedData,
): Promise<string> {
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== CIPHERTEXT_PREFIX) {
    throw new CryptoError('not an encrypted token');
  }

  const version = Number(parts[1]);
  if (!Number.isInteger(version)) throw new CryptoError('malformed key version');

  const raw = keyring.keyFor(version);
  if (!raw) throw new CryptoError(`no key for version ${version}; cannot decrypt`);

  const payload = decodeBase64(parts[2] ?? '');
  if (payload === null || payload.length <= IV_BYTES) {
    throw new CryptoError('malformed ciphertext');
  }

  const key = await importKey(raw, 'decrypt');
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: payload.slice(0, IV_BYTES),
        additionalData: encodeAad(aad),
      },
      key,
      payload.slice(IV_BYTES),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    // GCM authentication covers both the ciphertext and the associated data, so
    // this is equally "tampered with" and "wrong integration". Neither detail is
    // worth leaking in the message.
    throw new CryptoError('token failed authentication');
  }
}

/**
 * Imported keys, per raw key object and usage. Conversation history decrypts on
 * every agent turn, and importing a key each time is CPU the 10 ms budget does
 * not have (§4.1). Keyed weakly by the raw bytes, so a keyring that is dropped
 * takes its imported keys with it.
 */
const importedKeys = new WeakMap<Uint8Array, Map<'encrypt' | 'decrypt', Promise<CryptoKey>>>();

function importKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  let byUsage = importedKeys.get(raw);
  if (!byUsage) {
    byUsage = new Map();
    importedKeys.set(raw, byUsage);
  }
  let key = byUsage.get(usage);
  if (!key) {
    key = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [usage]);
    byUsage.set(usage, key);
  }
  return key;
}

/** Binds the ciphertext to its integration. Any change here breaks decryption. */
function encodeAad(aad: AssociatedData): Uint8Array {
  return new TextEncoder().encode(`${aad.provider}:${aad.account}`);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length === 0) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

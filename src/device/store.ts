/**
 * The device companion's state (PLAN §6.17).
 *
 * Three credentials, each a bearer secret, each kept only as something that
 * cannot be turned back into it:
 *
 *   pairing code   `/pair` sends it; the app trades it for a device token.
 *                  256 bits, 10 minutes, single use; stored as a keyed hash.
 *   device token   what the app authenticates with. 256 bits, stored as a
 *                  keyed hash, compared in constant time. It can fetch a
 *                  dispatch and report on one — nothing else.
 *   push address   the phone's FCM registration token. Not a secret that
 *                  grants anything, but an address to reach a person's phone,
 *                  so it is stored as AES-GCM ciphertext like a refresh token.
 *
 * Consumption is one statement (UPDATE … RETURNING), as for the OAuth link: a
 * read-then-write would let a replay through the gap.
 *
 * Nothing the device matched is ever written here. It reports how many
 * contacts matched and what happened, never which contact or which number.
 */
import type { SqlDriver } from '../core/sql.js';
import { hmacSha256Hex, timingSafeEqualHex } from '../security/hmac.js';
import { decryptToken, encryptToken } from '../security/crypto.js';
import type { Keyring } from '../security/crypto.js';

export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** A push that arrives late must not ring somebody half an hour later (§6.17). */
export const DISPATCH_TTL_MS = 2 * 60 * 1000;

/** 32 random bytes, base64url, no padding. */
const BEARER = /^[A-Za-z0-9_-]{43}$/;

export type ConsumeFailure = 'not_found' | 'expired' | 'already_used';
export type Consumed<T> = { ok: true; value: T } | { ok: false; reason: ConsumeFailure };

export type Device = { id: string; principal: string };

/** How many of the phone's contacts the words matched. Never which. */
export type Matched = 'none' | 'one' | 'many';
export type CallOutcome = 'placed' | 'cancelled' | 'no_match';

const OPEN = "('pending', 'fetched')";

export class DeviceStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly pepper: () => string,
    private readonly keyring: () => Keyring,
  ) {}

  // -- pairing ----------------------------------------------------------------

  async createPairing(principal: string): Promise<{ code: string; expiresAt: number }> {
    const code = randomBase64Url(32);
    const createdAt = this.now();
    const expiresAt = createdAt + PAIRING_TTL_MS;

    this.sql.exec(
      'INSERT INTO device_pairings (code_hash, principal, created_at, expires_at) VALUES (?, ?, ?, ?)',
      await this.hash('pair', code),
      principal,
      createdAt,
      expiresAt,
    );
    return { code, expiresAt };
  }

  /**
   * Trade a pairing code for a device token. The phone paired before this one
   * is revoked: one device at a time, so a lost phone is replaced, not joined.
   */
  async pair(
    code: string,
    pushToken: string,
  ): Promise<Consumed<{ deviceId: string; deviceToken: string }>> {
    if (!BEARER.test(code)) return { ok: false, reason: 'not_found' };

    const codeHash = await this.hash('pair', code);
    const now = this.now();
    const rows = this.sql.exec(
      `UPDATE device_pairings SET used_at = ?
       WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
       RETURNING principal`,
      now,
      codeHash,
      now,
    );
    const principal = rows[0]?.['principal'];
    if (typeof principal !== 'string') {
      return { ok: false, reason: this.whyPairingFailed(codeHash) };
    }

    this.revoke(principal);

    const deviceId = randomHex(16);
    const deviceToken = randomBase64Url(32);
    this.sql.exec(
      `INSERT INTO devices (id, principal, token_hash, push_token_enc, paired_at)
       VALUES (?, ?, ?, ?, ?)`,
      deviceId,
      principal,
      await this.hash('device', deviceToken),
      await this.encryptPush(deviceId, pushToken),
      now,
    );
    return { ok: true, value: { deviceId, deviceToken } };
  }

  // -- the device token -------------------------------------------------------

  /** The device a token belongs to, or null. Constant-time on the hash. */
  async authenticate(deviceToken: string): Promise<Device | null> {
    if (!BEARER.test(deviceToken)) return null;
    const presented = await this.hash('device', deviceToken);

    let found: Device | null = null;
    const rows = this.sql.exec(
      'SELECT id, principal, token_hash FROM devices WHERE revoked_at IS NULL',
    );
    // Every row is compared, match or not, so timing says nothing about which.
    for (const row of rows) {
      const matches = timingSafeEqualHex(presented, String(row['token_hash']));
      if (matches && found === null) {
        found = { id: String(row['id']), principal: String(row['principal']) };
      }
    }
    return found;
  }

  activeDevice(principal: string): Device | null {
    const row = this.sql.exec(
      `SELECT id, principal FROM devices
       WHERE principal = ? AND revoked_at IS NULL
       ORDER BY paired_at DESC LIMIT 1`,
      principal,
    )[0];
    return row ? { id: String(row['id']), principal: String(row['principal']) } : null;
  }

  async pushTokenOf(deviceId: string): Promise<string | null> {
    const row = this.sql.exec(
      'SELECT push_token_enc FROM devices WHERE id = ? AND revoked_at IS NULL',
      deviceId,
    )[0];
    const ciphertext = row?.['push_token_enc'];
    if (typeof ciphertext !== 'string') return null;
    try {
      return await decryptToken(ciphertext, this.keyring(), { provider: 'fcm', account: deviceId });
    } catch {
      return null;
    }
  }

  /** FCM rotates registration tokens; the app sends the new one. */
  async setPushToken(deviceId: string, pushToken: string): Promise<void> {
    this.sql.exec(
      'UPDATE devices SET push_token_enc = ? WHERE id = ? AND revoked_at IS NULL',
      await this.encryptPush(deviceId, pushToken),
      deviceId,
    );
  }

  /** `/pair off`. Returns how many devices it revoked. */
  revoke(principal: string): number {
    return this.sql.exec(
      'UPDATE devices SET revoked_at = ? WHERE principal = ? AND revoked_at IS NULL RETURNING id',
      this.now(),
      principal,
    ).length;
  }

  // -- dispatches -------------------------------------------------------------

  createDispatch(
    principal: string,
    deviceId: string,
    queryVariants: readonly string[],
  ): { id: string; expiresAt: number } {
    const id = randomHex(16);
    const createdAt = this.now();
    const expiresAt = createdAt + DISPATCH_TTL_MS;

    this.sql.exec(
      `INSERT INTO call_dispatches (id, principal, device_id, query_json, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      principal,
      deviceId,
      JSON.stringify(queryVariants),
      createdAt,
      expiresAt,
    );
    return { id, expiresAt };
  }

  /** What the device fetches after the push wakes it. Only its own, only in time. */
  fetchDispatch(
    id: string,
    deviceId: string,
  ): Consumed<{ queryVariants: string[]; expiresAt: number }> {
    const now = this.now();
    const row = this.sql.exec(
      `UPDATE call_dispatches SET status = 'fetched'
       WHERE id = ? AND device_id = ? AND status IN ${OPEN} AND expires_at > ?
       RETURNING query_json, expires_at`,
      id,
      deviceId,
      now,
    )[0];
    if (!row) return { ok: false, reason: this.whyDispatchFailed(id, deviceId) };

    const parsed: unknown = JSON.parse(String(row['query_json']));
    const queryVariants = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    return { ok: true, value: { queryVariants, expiresAt: Number(row['expires_at']) } };
  }

  /**
   * The device's one report. Taken until the sweep runs, not strictly until
   * expiry: a tap at 1:59 is a call that happened, and the reply should say so.
   */
  report(
    id: string,
    deviceId: string,
    report: { matched: Matched; outcome: CallOutcome },
  ): Consumed<{ principal: string; outcome: CallOutcome }> {
    const row = this.sql.exec(
      `UPDATE call_dispatches SET status = ?, matched = ?, settled_at = ?
       WHERE id = ? AND device_id = ? AND status IN ${OPEN}
       RETURNING principal`,
      report.outcome,
      report.matched,
      this.now(),
      id,
      deviceId,
    )[0];
    if (!row) return { ok: false, reason: this.whyDispatchFailed(id, deviceId) };
    return { ok: true, value: { principal: String(row['principal']), outcome: report.outcome } };
  }

  /** The push never reached the phone. Settled now, so the sweep does not reply twice. */
  markFailed(id: string): void {
    this.sql.exec(
      `UPDATE call_dispatches SET status = 'failed', settled_at = ? WHERE id = ? AND status IN ${OPEN}`,
      this.now(),
      id,
    );
  }

  /** Close every dispatch nobody answered, once, and name them for the reply. */
  expireDue(): Array<{ id: string; principal: string }> {
    const now = this.now();
    return this.sql
      .exec(
        `UPDATE call_dispatches SET status = 'expired', settled_at = ?
         WHERE status IN ${OPEN} AND expires_at <= ?
         RETURNING id, principal`,
        now,
        now,
      )
      .map((row) => ({ id: String(row['id']), principal: String(row['principal']) }));
  }

  nextExpiryAt(): number | null {
    const at = this.sql.exec(
      `SELECT MIN(expires_at) AS at FROM call_dispatches WHERE status IN ${OPEN}`,
    )[0]?.['at'];
    return typeof at === 'number' ? at : null;
  }

  /** Daily maintenance. The words to match go with the row. */
  purge(): void {
    this.sql.exec(`DELETE FROM call_dispatches WHERE status NOT IN ${OPEN}`);
    this.sql.exec(
      'DELETE FROM device_pairings WHERE used_at IS NOT NULL OR expires_at <= ?',
      this.now(),
    );
  }

  // -- internals --------------------------------------------------------------

  /** Domain-separated, so a pairing code can never pass as a device token. */
  private hash(kind: 'pair' | 'device', value: string): Promise<string> {
    return hmacSha256Hex(this.pepper(), `${kind}:${value}`);
  }

  private encryptPush(deviceId: string, pushToken: string): Promise<string> {
    return encryptToken(pushToken, this.keyring(), { provider: 'fcm', account: deviceId });
  }

  private whyPairingFailed(codeHash: string): ConsumeFailure {
    const row = this.sql.exec(
      'SELECT used_at, expires_at FROM device_pairings WHERE code_hash = ?',
      codeHash,
    )[0];
    if (!row) return 'not_found';
    if (row['used_at'] !== null && row['used_at'] !== undefined) return 'already_used';
    return 'expired';
  }

  private whyDispatchFailed(id: string, deviceId: string): ConsumeFailure {
    const row = this.sql.exec(
      'SELECT status FROM call_dispatches WHERE id = ? AND device_id = ?',
      id,
      deviceId,
    )[0];
    if (!row) return 'not_found';
    const status = String(row['status']);
    if (status === 'pending' || status === 'fetched') return 'expired';
    return status === 'expired' ? 'expired' : 'already_used';
  }
}

function randomBytes(count: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(count));
}

function randomHex(bytes: number): string {
  return [...randomBytes(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function randomBase64Url(bytes: number): string {
  let binary = '';
  for (const b of randomBytes(bytes)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

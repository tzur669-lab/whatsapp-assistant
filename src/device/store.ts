/**
 * The paired phone's state (PLAN §6.17, §6.18).
 *
 *   pairing code   a single-use capability: a `/pair` code (10 minutes) or the
 *                  bootstrap code set as a secret. It is never sent over the
 *                  network — the phone proves it knows the code with a MAC over
 *                  its own public key (`channels/app/verify.ts`). A live `/pair`
 *                  code is kept as ciphertext, because checking a MAC needs the
 *                  code; a used one is remembered by keyed hash.
 *   public key     the phone's Keystore key, P-256. Every request is signed with
 *                  it. Public, so stored as is; nothing here can sign.
 *   push address   the phone's FCM registration token. Not a credential, but an
 *                  address that reaches a person's phone, so AES-GCM ciphertext.
 *
 * One device at a time: pairing revokes the previous one, so a lost phone is
 * replaced, not joined. Consumption is one statement (UPDATE … RETURNING or
 * INSERT … ON CONFLICT), inside a transaction with the device insert.
 *
 * Nothing the device matched is ever written here. It reports how many
 * contacts matched and what happened, never which contact or which number.
 */
import type { SqlDriver } from '../core/sql.js';
import { hmacSha256Hex } from '../security/hmac.js';
import { decryptToken, encryptToken } from '../security/crypto.js';
import type { Keyring } from '../security/crypto.js';
import {
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
  pairingMac,
  pairingMacMatches,
  withinClockSkew,
} from '../channels/app/verify.js';
import type { PairRequest } from '../channels/app/parse.js';

export const PAIRING_TTL_MS = 10 * 60 * 1000;
/** A push that arrives late must not ring somebody half an hour later (§6.17). */
export const DISPATCH_TTL_MS = 2 * 60 * 1000;

export type ConsumeFailure = 'not_found' | 'expired' | 'already_used';
export type Consumed<T> = { ok: true; value: T } | { ok: false; reason: ConsumeFailure };

export type Device = { id: string; principal: string };
export type SigningDevice = Device & { publicKey: string };

/** How many of the phone's contacts the words matched. Never which. */
export type Matched = 'none' | 'one' | 'many';
export type CallOutcome = 'placed' | 'cancelled' | 'no_match';

const OPEN = "('pending', 'fetched')";

type Candidate = { kind: 'pair' | 'bootstrap'; code: string; codeHash: string; principal: string };

export class DeviceStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly pepper: () => string,
    private readonly keyring: () => Keyring,
  ) {}

  // -- pairing ----------------------------------------------------------------

  /** `/pair` in chat. The code is shown once, formatted for typing. */
  async createPairing(principal: string): Promise<{ code: string; expiresAt: number }> {
    const code = generatePairingCode();
    const createdAt = this.now();
    const expiresAt = createdAt + PAIRING_TTL_MS;
    const codeHash = await this.hash('pair', code);

    this.sql.exec(
      `INSERT INTO device_pairings (code_hash, principal, created_at, expires_at, kind, code_enc)
       VALUES (?, ?, ?, ?, 'pair', ?)`,
      codeHash,
      principal,
      createdAt,
      expiresAt,
      await this.encryptCode(codeHash, code),
    );
    return { code: formatPairingCode(code), expiresAt };
  }

  /**
   * Pair the phone that proved it knows a live code (PLAN §6.18).
   *
   * The code is either a `/pair` code or the bootstrap secret. Every candidate's
   * MAC is computed and compared, so timing says nothing about which one, if
   * any, matched. The phone paired before this one is revoked.
   *
   * A retry by the same public key after the code was used — the answer to the
   * first attempt was lost — gets the same device back. Anyone else gets
   * `already_used`.
   */
  async pair(
    request: PairRequest,
    context: { principal: string; bootstrapCode: string | null },
  ): Promise<Consumed<{ deviceId: string; reused: boolean }>> {
    const now = this.now();
    if (!withinClockSkew(request.timestamp, now)) return { ok: false, reason: 'expired' };

    let matched: Candidate | null = null;
    for (const candidate of await this.candidates(context)) {
      const expected = await pairingMac(candidate.code, request.publicKey, request.pushToken, request.timestamp);
      if (pairingMacMatches(expected, request.mac) && matched === null) matched = candidate;
    }
    if (!matched) return { ok: false, reason: 'not_found' };

    const keyHash = await this.hash('key', request.publicKey);
    const deviceId = randomHex(16);
    const pushTokenEnc = await this.encryptPush(deviceId, request.pushToken);
    const candidate = matched;

    return this.sql.transaction((): Consumed<{ deviceId: string; reused: boolean }> => {
      const consumed =
        candidate.kind === 'bootstrap'
          ? this.sql.exec(
              `INSERT INTO device_pairings (code_hash, principal, created_at, expires_at, used_at, kind, public_key_hash)
               VALUES (?, ?, ?, ?, ?, 'bootstrap', ?)
               ON CONFLICT(code_hash) DO NOTHING
               RETURNING principal`,
              candidate.codeHash,
              candidate.principal,
              now,
              now,
              now,
              keyHash,
            )
          : this.sql.exec(
              `UPDATE device_pairings SET used_at = ?, public_key_hash = ?
               WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?
               RETURNING principal`,
              now,
              keyHash,
              candidate.codeHash,
              now,
            );

      if (consumed.length === 0) {
        // Used already. The same key asking again gets its device back.
        const used = this.sql.exec(
          `SELECT p.device_id AS device_id FROM device_pairings p
           JOIN devices d ON d.id = p.device_id AND d.revoked_at IS NULL
           WHERE p.code_hash = ? AND p.public_key_hash = ?`,
          candidate.codeHash,
          keyHash,
        )[0];
        return used
          ? { ok: true, value: { deviceId: String(used['device_id']), reused: true } }
          : { ok: false, reason: 'already_used' };
      }

      this.revoke(candidate.principal);
      // `token_hash` is the bearer era's column, NOT NULL; an empty string is a
      // value no presented token can ever match (0010_app.sql).
      this.sql.exec(
        `INSERT INTO devices (id, principal, token_hash, public_key, push_token_enc, paired_at)
         VALUES (?, ?, '', ?, ?, ?)`,
        deviceId,
        candidate.principal,
        request.publicKey,
        pushTokenEnc,
        now,
      );
      // The code's ciphertext stays until the code expires, so the same key
      // retrying after a lost answer is matched again — see `candidates`.
      this.sql.exec('UPDATE device_pairings SET device_id = ? WHERE code_hash = ?', deviceId, candidate.codeHash);
      return { ok: true, value: { deviceId, reused: false } };
    });
  }

  // -- signed requests ----------------------------------------------------------

  /** The device a signature must be checked against. Revoked devices do not exist here. */
  signingDevice(deviceId: string): SigningDevice | null {
    const row = this.sql.exec(
      `SELECT id, principal, public_key FROM devices
       WHERE id = ? AND revoked_at IS NULL AND public_key IS NOT NULL`,
      deviceId,
    )[0];
    if (!row) return null;
    return { id: String(row['id']), principal: String(row['principal']), publicKey: String(row['public_key']) };
  }

  isActive(deviceId: string): boolean {
    return this.sql.exec('SELECT 1 FROM devices WHERE id = ? AND revoked_at IS NULL', deviceId).length > 0;
  }

  /**
   * Spend a nonce. False when this device has used it already. Expired nonces
   * go first, so the table holds only the few minutes that matter.
   */
  claimNonce(deviceId: string, nonce: string, expiresAt: number): boolean {
    this.purgeNonces(this.now());
    return (
      this.sql.exec(
        `INSERT INTO app_nonces (device_id, nonce, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(device_id, nonce) DO NOTHING
         RETURNING nonce`,
        deviceId,
        nonce,
        expiresAt,
      ).length > 0
    );
  }

  purgeNonces(nowMs: number): void {
    this.sql.exec('DELETE FROM app_nonces WHERE expires_at < ?', nowMs);
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

  /** FCM said this address is gone. The device stays paired; pushes stop until it sends a new one. */
  forgetPushToken(deviceId: string): void {
    this.sql.exec('UPDATE devices SET push_token_enc = NULL WHERE id = ?', deviceId);
  }

  /** `/pair off`, and every new pairing. Returns how many devices it revoked. */
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

  /**
   * Tie the dispatch a turn just created to the message that asked for it, so
   * the outcome that arrives later answers the same message in the app.
   */
  linkLatestDispatch(inReplyTo: string, sinceMs: number): void {
    this.sql.exec(
      `UPDATE call_dispatches SET in_reply_to = ?
       WHERE id = (SELECT id FROM call_dispatches
                   WHERE in_reply_to IS NULL AND created_at >= ?
                   ORDER BY created_at DESC LIMIT 1)`,
      inReplyTo,
      sinceMs,
    );
  }

  inReplyToOf(id: string): string | null {
    const value = this.sql.exec('SELECT in_reply_to FROM call_dispatches WHERE id = ?', id)[0]?.['in_reply_to'];
    return typeof value === 'string' ? value : null;
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

  /**
   * Daily maintenance. The words to match go with the row. A `/pair` code goes
   * once it has expired; a used bootstrap code stays, or it would work again.
   */
  purge(): void {
    const now = this.now();
    this.sql.exec(`DELETE FROM call_dispatches WHERE status NOT IN ${OPEN}`);
    this.sql.exec("DELETE FROM device_pairings WHERE kind = 'pair' AND expires_at <= ?", now);
    this.purgeNonces(now);
  }

  // -- internals --------------------------------------------------------------

  /**
   * Every code the phone could have used: the bootstrap secret, and each
   * `/pair` code still inside its ten minutes — used ones included, so a
   * pairing whose answer was lost can be retried by the same key.
   */
  private async candidates(context: { principal: string; bootstrapCode: string | null }): Promise<Candidate[]> {
    const out: Candidate[] = [];
    const bootstrap = context.bootstrapCode ? normalizePairingCode(context.bootstrapCode) : null;
    if (bootstrap) {
      out.push({
        kind: 'bootstrap',
        code: bootstrap,
        codeHash: await this.hash('bootstrap', bootstrap),
        principal: context.principal,
      });
    }

    const rows = this.sql.exec(
      `SELECT code_hash, principal, code_enc FROM device_pairings
       WHERE kind = 'pair' AND code_enc IS NOT NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 20`,
      this.now(),
    );
    for (const row of rows) {
      const codeHash = String(row['code_hash']);
      const code = await this.decryptCode(codeHash, String(row['code_enc']));
      if (code) out.push({ kind: 'pair', code, codeHash, principal: String(row['principal']) });
    }
    return out;
  }

  /** Domain-separated, so a value of one kind can never pass as another. */
  private hash(kind: 'pair' | 'bootstrap' | 'key', value: string): Promise<string> {
    return hmacSha256Hex(this.pepper(), `${kind}:${value}`);
  }

  private encryptCode(codeHash: string, code: string): Promise<string> {
    return encryptToken(code, this.keyring(), { provider: 'pairing', account: codeHash });
  }

  private async decryptCode(codeHash: string, ciphertext: string): Promise<string | null> {
    try {
      return await decryptToken(ciphertext, this.keyring(), { provider: 'pairing', account: codeHash });
    } catch {
      return null;
    }
  }

  private encryptPush(deviceId: string, pushToken: string): Promise<string> {
    return encryptToken(pushToken, this.keyring(), { provider: 'fcm', account: deviceId });
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


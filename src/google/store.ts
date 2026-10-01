/**
 * Google integration state (PLAN §6.6, §7.2).
 *
 * Three lifetimes, kept apart because they fail differently:
 *
 *   link    the one-time URL sent over WhatsApp — 10 minutes, single use
 *   state   one authorization attempt, carrying the PKCE verifier — 10 minutes
 *   grant   the standing integration, holding an encrypted refresh token
 *
 * Both short-lived rows are consumed with an UPDATE … RETURNING, so the check
 * and the consumption are one statement. A read-then-write would leave a window
 * where a replayed callback passes twice, which is the whole thing a single-use
 * state exists to prevent.
 *
 * The refresh token is written only as `enc.<version>.<base64>` ciphertext. It
 * is never returned in a listing, never logged, and never leaves this file in
 * plaintext except into `refreshAccessToken`.
 */
import type { SqlDriver } from '../core/sql.js';
import { decryptToken, encryptToken } from '../security/crypto.js';
import type { Keyring } from '../security/crypto.js';
import { isGrantName } from './grants.js';
import type { GrantName } from './grants.js';

const LINK_TTL_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

export const PROVIDER = 'google';
/** The calendar's grant, which predates the others (`grants.ts`). */
export const ACCOUNT = 'primary';

export type IntegrationStatus = 'connected' | 'disconnected';

export type Integration = {
  status: IntegrationStatus;
  scopes: string[];
  remindersCalendarId: string | null;
  connectedAt: number | null;
  lastError: string | null;
};

export type ConsumeFailure = 'not_found' | 'expired' | 'already_used';

export type Consumed<T> = { ok: true; value: T } | { ok: false; reason: ConsumeFailure };

export class GoogleStore {
  constructor(
    private readonly sql: SqlDriver,
    private readonly now: () => number,
    private readonly keyring: () => Keyring,
    /**
     * Which grant this store's standing integration is (`GRANTS[...].account`).
     * Links and authorization attempts are shared, and say their grant.
     */
    private readonly account: string = ACCOUNT,
  ) {}

  // -- the one-time link ------------------------------------------------------

  /** Returns the id to put in the link. 256 random bits, single use. */
  createLink(principal: string, grant: GrantName = 'calendar'): { id: string; expiresAt: number } {
    const id = randomHex(32);
    const createdAt = this.now();
    const expiresAt = createdAt + LINK_TTL_MS;

    this.sql.exec(
      'INSERT INTO oauth_links (id, principal, created_at, expires_at, grant_name) VALUES (?, ?, ?, ?, ?)',
      id,
      principal,
      createdAt,
      expiresAt,
      grant,
    );
    return { id, expiresAt };
  }

  /** Consume a link. One statement, so a double-click cannot pass twice. */
  useLink(id: string): Consumed<{ principal: string; grant: GrantName }> {
    const rows = this.sql.exec(
      `UPDATE oauth_links SET used_at = ?
       WHERE id = ? AND used_at IS NULL AND expires_at > ?
       RETURNING principal, grant_name`,
      this.now(),
      id,
      this.now(),
    );
    const principal = rows[0]?.['principal'];
    const grant = rows[0]?.['grant_name'];
    if (typeof principal === 'string' && isGrantName(grant)) return { ok: true, value: { principal, grant } };
    return { ok: false, reason: this.whyLinkFailed(id) };
  }

  // -- one authorization attempt ---------------------------------------------

  createState(principal: string, codeVerifier: string, grant: GrantName = 'calendar'): { state: string } {
    const state = randomHex(32);
    const createdAt = this.now();

    this.sql.exec(
      `INSERT INTO oauth_states (state, principal, code_verifier, created_at, expires_at, grant_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      state,
      principal,
      codeVerifier,
      createdAt,
      createdAt + STATE_TTL_MS,
      grant,
    );
    return { state };
  }

  useState(state: string): Consumed<{ principal: string; codeVerifier: string; grant: GrantName }> {
    const rows = this.sql.exec(
      `UPDATE oauth_states SET used_at = ?
       WHERE state = ? AND used_at IS NULL AND expires_at > ?
       RETURNING principal, code_verifier, grant_name`,
      this.now(),
      state,
      this.now(),
    );
    const row = rows[0];
    const grant = row?.['grant_name'];
    if (row && isGrantName(grant)) {
      return {
        ok: true,
        value: { principal: String(row['principal']), codeVerifier: String(row['code_verifier']), grant },
      };
    }
    return { ok: false, reason: this.whyStateFailed(state) };
  }

  // -- the standing grant -----------------------------------------------------

  async connect(params: { refreshToken: string; scopes: string[] }): Promise<void> {
    const ciphertext = await encryptToken(params.refreshToken, this.keyring(), {
      provider: PROVIDER,
      account: this.account,
    });
    const at = this.now();

    this.sql.exec(
      `INSERT INTO integrations
         (provider, account, status, refresh_token_enc, scopes, connected_at, updated_at, last_error)
       VALUES (?, ?, 'connected', ?, ?, ?, ?, NULL)
       ON CONFLICT(provider, account) DO UPDATE SET
         status = 'connected',
         refresh_token_enc = excluded.refresh_token_enc,
         scopes = excluded.scopes,
         connected_at = excluded.connected_at,
         updated_at = excluded.updated_at,
         last_error = NULL`,
      PROVIDER,
      this.account,
      ciphertext,
      params.scopes.join(' '),
      at,
      at,
    );
  }

  get(): Integration | null {
    const row = this.row();
    if (!row) return null;
    return {
      status: String(row['status']) as IntegrationStatus,
      scopes: String(row['scopes'] ?? '').split(' ').filter(Boolean),
      remindersCalendarId: asStringOrNull(row['reminders_calendar_id']),
      connectedAt: typeof row['connected_at'] === 'number' ? row['connected_at'] : null,
      lastError: asStringOrNull(row['last_error']),
    };
  }

  isConnected(): boolean {
    return this.get()?.status === 'connected';
  }

  /**
   * The refresh token in the clear, for one call to Google and nothing else.
   * Returns null when there is no usable grant, which callers answer with a
   * reconnect message rather than an error.
   */
  async refreshToken(): Promise<string | null> {
    const row = this.row();
    const ciphertext = row ? asStringOrNull(row['refresh_token_enc']) : null;
    if (!ciphertext || row?.['status'] !== 'connected') return null;

    try {
      return await decryptToken(ciphertext, this.keyring(), {
        provider: PROVIDER,
        account: this.account,
      });
    } catch {
      // A token that will not decrypt is a key problem, not a Google problem.
      this.disconnect('E_TOKEN_UNREADABLE');
      return null;
    }
  }

  /**
   * Mark the grant unusable and forget the token.
   *
   * `invalid_grant` means the user revoked access or the consent expired; there
   * is nothing to retry, and keeping ciphertext that can never be used again is
   * a liability with no upside (PLAN §6.6).
   */
  disconnect(errorCode: string): void {
    this.sql.exec(
      `UPDATE integrations
       SET status = 'disconnected', refresh_token_enc = NULL, last_error = ?, updated_at = ?
       WHERE provider = ? AND account = ?`,
      errorCode.slice(0, 64),
      this.now(),
      PROVIDER,
      this.account,
    );
  }

  setRemindersCalendarId(calendarId: string): void {
    this.sql.exec(
      `UPDATE integrations SET reminders_calendar_id = ?, updated_at = ?
       WHERE provider = ? AND account = ?`,
      calendarId,
      this.now(),
      PROVIDER,
      this.account,
    );
  }

  /** Run from the daily cron. Expired rows are consumed state, not history. */
  purgeExpired(): void {
    const now = this.now();
    this.sql.exec('DELETE FROM oauth_links WHERE expires_at <= ? OR used_at IS NOT NULL', now);
    this.sql.exec('DELETE FROM oauth_states WHERE expires_at <= ? OR used_at IS NOT NULL', now);
  }

  // -- helpers ----------------------------------------------------------------

  private row(): Record<string, unknown> | undefined {
    return this.sql.exec(
      'SELECT * FROM integrations WHERE provider = ? AND account = ?',
      PROVIDER,
      this.account,
    )[0];
  }

  /** Only reached after a failed consume, to tell the user something useful. */
  private whyLinkFailed(id: string): ConsumeFailure {
    const row = this.sql.exec('SELECT used_at, expires_at FROM oauth_links WHERE id = ?', id)[0];
    if (!row) return 'not_found';
    if (row['used_at'] !== null && row['used_at'] !== undefined) return 'already_used';
    return 'expired';
  }

  private whyStateFailed(state: string): ConsumeFailure {
    const row = this.sql.exec(
      'SELECT used_at, expires_at FROM oauth_states WHERE state = ?',
      state,
    )[0];
    if (!row) return 'not_found';
    if (row['used_at'] !== null && row['used_at'] !== undefined) return 'already_used';
    return 'expired';
  }
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((b) => b.toString(16).padStart(2, '0')).join('');
}

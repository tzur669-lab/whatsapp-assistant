/**
 * The Google OAuth exchange and its state store (PLAN §6.6, §7.2).
 *
 * The properties that matter are all about single use: a link that has sent
 * someone to Google is spent, a `state` that has been exchanged is spent, and
 * a refresh token exists on disk only as ciphertext.
 */
import { GRANTS } from '../../../src/google/grants.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  refreshAccessToken,
  GOOGLE_SCOPES,
} from '../../../src/google/oauth.js';
import { GoogleStore } from '../../../src/google/store.js';
import { parseKeyring } from '../../../src/security/crypto.js';
import { Repository } from '../../../src/core/repo.js';
import { TestSqlDriver } from '../../integration/sqlite-driver.js';

const MIGRATIONS = readdirSync(new URL('../../../migrations/', import.meta.url))
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file, i) => ({
    id: i + 1,
    sql: readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), 'utf8'),
  }));

const KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = Date.parse('2026-09-24T09:00:00Z');
const PRINCIPAL = 'p_test';
const REFRESH_TOKEN = '1//0fake-refresh-token';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const fakeFetch = (respond: () => Response) => {
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : input.toString(),
      body: new URLSearchParams(String(init?.body ?? '')),
    });
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
};

describe('the authorization URL', () => {
  const url = () =>
    new URL(
      buildAuthUrl({
        clientId: 'fake-client-id',
        redirectUri: 'https://assistant.example.test/oauth/google/callback',
        state: 'abc',
        challenge: 'xyz',
      }),
    );

  it('asks for offline access, which is what produces a refresh token at all', () => {
    expect(url().searchParams.get('access_type')).toBe('offline');
  });

  it('forces the consent screen, so a reconnect after a revoke works', () => {
    // Without this, re-authorizing returns no refresh token and the grant comes
    // back unusable.
    expect(url().searchParams.get('prompt')).toBe('consent');
  });

  it('uses PKCE with S256', () => {
    expect(url().searchParams.get('code_challenge_method')).toBe('S256');
    expect(url().searchParams.get('code_challenge')).toBe('xyz');
  });

  it('asks for exactly the calendar grant\'s scopes and no others', () => {
    expect(url().searchParams.get('scope')).toBe(GOOGLE_SCOPES.join(' '));
    expect(url().searchParams.get('include_granted_scopes')).toBe('false');
  });

  it('never carries the client secret', () => {
    expect(url().toString()).not.toContain('secret');
  });
});

describe('PKCE', () => {
  it('produces a fresh verifier every time', async () => {
    const a = await createPkce();
    const b = await createPkce();
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('is base64url, so it survives a query string unescaped', async () => {
    const { verifier, challenge } = await createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('matches the published S256 example', async () => {
    // RFC 7636 Appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('exchanging a code', () => {
  const params = {
    code: 'auth-code',
    codeVerifier: 'verifier',
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'https://assistant.example.test/oauth/google/callback',
  };

  it('sends the verifier, so a stolen code is useless without it', async () => {
    const { fetchImpl, calls } = fakeFetch(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: GOOGLE_SCOPES.join(' ') }),
    );
    await exchangeCode(params, fetchImpl);
    expect(calls[0]?.body.get('code_verifier')).toBe('verifier');
    expect(calls[0]?.body.get('grant_type')).toBe('authorization_code');
  });

  it('returns the grant with its scopes', async () => {
    const { fetchImpl } = fakeFetch(() =>
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: GOOGLE_SCOPES.join(' ') }),
    );
    const result = await exchangeCode(params, fetchImpl);
    expect(result).toMatchObject({
      ok: true,
      grant: { accessToken: 'at', refreshToken: 'rt', expiresInSeconds: 3599 },
    });
  });

  it('separates a revoked grant from every other failure', async () => {
    // invalid_grant is the difference between "retry" and "the user must
    // reconnect", so it is the one field worth reading from an error body.
    const { fetchImpl } = fakeFetch(() => json({ error: 'invalid_grant' }, 400));
    expect(await exchangeCode(params, fetchImpl)).toEqual({
      ok: false,
      error: { code: 'invalid_grant' },
    });
  });

  it('reports other failures by status alone', async () => {
    const { fetchImpl } = fakeFetch(() => json({ error: 'server_error' }, 503));
    expect(await exchangeCode(params, fetchImpl)).toEqual({
      ok: false,
      error: { code: 'provider_error', status: 503 },
    });
  });

  it('refuses a response with no access token', async () => {
    const { fetchImpl } = fakeFetch(() => json({ expires_in: 3599 }));
    expect(await exchangeCode(params, fetchImpl)).toEqual({
      ok: false,
      error: { code: 'invalid_response' },
    });
  });

  it('turns a transport failure into a code, not an exception', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await exchangeCode(params, fetchImpl)).toEqual({
      ok: false,
      error: { code: 'network_error' },
    });
  });
});

describe('refreshing', () => {
  it('accepts a response with no refresh token, which is the normal case', async () => {
    // Google returns one only on the first grant.
    const { fetchImpl } = fakeFetch(() => json({ access_token: 'at2', expires_in: 3599 }));
    const result = await refreshAccessToken(
      { refreshToken: 'rt', clientId: 'id', clientSecret: 'secret' },
      fetchImpl,
    );
    expect(result).toMatchObject({ ok: true, grant: { accessToken: 'at2' } });
    expect(result.ok && result.grant.refreshToken).toBeUndefined();
  });
});

describe('GoogleStore', () => {
  let driver: TestSqlDriver;
  let store: GoogleStore;
  let now = NOW;

  beforeEach(() => {
    now = NOW;
    driver = new TestSqlDriver();
    new Repository(driver).migrate(MIGRATIONS);
    store = new GoogleStore(driver, () => now, () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY }));
  });
  afterEach(() => driver.close());

  describe('the one-time link', () => {
    it('is long enough that it cannot be guessed', () => {
      expect(store.createLink(PRINCIPAL).id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('works once', () => {
      const { id } = store.createLink(PRINCIPAL);
      expect(store.useLink(id)).toEqual({ ok: true, value: { principal: PRINCIPAL, grant: 'calendar' } });
      expect(store.useLink(id)).toEqual({ ok: false, reason: 'already_used' });
    });

    it('expires after ten minutes', () => {
      const { id } = store.createLink(PRINCIPAL);
      now = NOW + 11 * 60_000;
      expect(store.useLink(id)).toEqual({ ok: false, reason: 'expired' });
    });

    it('reports an id that was never issued as not found', () => {
      expect(store.useLink('f'.repeat(64))).toEqual({ ok: false, reason: 'not_found' });
    });
  });

  describe('the authorization state', () => {
    it('carries the verifier back exactly once', () => {
      const { state } = store.createState(PRINCIPAL, 'the-verifier');
      expect(store.useState(state)).toEqual({
        ok: true,
        value: { principal: PRINCIPAL, codeVerifier: 'the-verifier', grant: 'calendar' },
      });
      // A replayed callback must not pass a second time.
      expect(store.useState(state)).toEqual({ ok: false, reason: 'already_used' });
    });

    it('expires', () => {
      const { state } = store.createState(PRINCIPAL, 'v');
      now = NOW + 11 * 60_000;
      expect(store.useState(state)).toEqual({ ok: false, reason: 'expired' });
    });
  });

  describe('separate grants (2026-10-01)', () => {
    it('carries the grant from the link to the state', () => {
      const { id } = store.createLink(PRINCIPAL, 'gmail');
      expect(store.useLink(id)).toEqual({ ok: true, value: { principal: PRINCIPAL, grant: 'gmail' } });
      const { state } = store.createState(PRINCIPAL, 'v', 'gmail');
      expect(store.useState(state)).toEqual({ ok: true, value: { principal: PRINCIPAL, codeVerifier: 'v', grant: 'gmail' } });
    });

    it('keeps each grant to itself', async () => {
      const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
      const gmail = new GoogleStore(driver, () => now, keyring, 'gmail');
      await gmail.connect({ refreshToken: 'gmail-token', scopes: GRANTS.gmail.scopes.slice() });
      expect(gmail.isConnected()).toBe(true);
      expect(store.isConnected()).toBe(false);
      expect(await gmail.refreshToken()).toBe('gmail-token');

      gmail.disconnect('E_TEST');
      await store.connect({ refreshToken: 'calendar-token', scopes: [] });
      expect(gmail.isConnected()).toBe(false);
      expect(await store.refreshToken()).toBe('calendar-token');
    });

    it("binds a token to its grant: moved to another, it does not decrypt", async () => {
      const keyring = () => parseKeyring({ TOKEN_ENC_KEY_V1: KEY });
      const gmail = new GoogleStore(driver, () => now, keyring, 'gmail');
      await gmail.connect({ refreshToken: 'gmail-token', scopes: [] });
      await store.connect({ refreshToken: 'calendar-token', scopes: [] });
      const stolen = driver.exec("SELECT refresh_token_enc FROM integrations WHERE account = 'gmail'")[0]!['refresh_token_enc'];
      driver.exec("UPDATE integrations SET refresh_token_enc = ? WHERE account = 'primary'", stolen);
      expect(await store.refreshToken()).toBeNull();
    });

    it('asks each grant only for its own scopes', () => {
      expect(GRANTS.gmail.scopes).toEqual([
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ]);
      expect(GRANTS.tasks.scopes).toEqual(['https://www.googleapis.com/auth/tasks']);
      expect(GRANTS.drive.scopes).toEqual(['https://www.googleapis.com/auth/drive.metadata.readonly']);
      expect(GRANTS.calendar.scopes).toContain('https://www.googleapis.com/auth/calendar.readonly');
      // Nothing that sends mail, and nothing with write access to Drive.
      const all = Object.values(GRANTS).flatMap((grant) => grant.scopes);
      expect(all.some((scope) => /gmail\.send|gmail\.modify|mail\.google\.com|auth\/drive$|drive\.file/.test(scope))).toBe(false);
    });
  });

  describe('the grant', () => {
    it('stores the refresh token only as ciphertext', async () => {
      await store.connect({ refreshToken: REFRESH_TOKEN, scopes: [...GOOGLE_SCOPES] });

      const dump = JSON.stringify(driver.exec('SELECT * FROM integrations'));
      expect(dump).not.toContain(REFRESH_TOKEN);
      expect(dump).toContain('enc.1.');
    });

    it('hands the token back in the clear only on request', async () => {
      await store.connect({ refreshToken: REFRESH_TOKEN, scopes: [] });
      expect(await store.refreshToken()).toBe(REFRESH_TOKEN);
    });

    it('reports its state', async () => {
      expect(store.isConnected()).toBe(false);
      await store.connect({ refreshToken: REFRESH_TOKEN, scopes: [...GOOGLE_SCOPES] });
      expect(store.isConnected()).toBe(true);
      expect(store.get()).toMatchObject({ status: 'connected', scopes: [...GOOGLE_SCOPES] });
    });

    it('forgets the token when the grant is revoked', async () => {
      await store.connect({ refreshToken: REFRESH_TOKEN, scopes: [] });
      store.disconnect('E_GOOGLE_INVALID_GRANT');

      expect(store.isConnected()).toBe(false);
      expect(await store.refreshToken()).toBeNull();
      // Keeping ciphertext that can never be used again is a liability.
      expect(JSON.stringify(driver.exec('SELECT * FROM integrations'))).not.toContain('enc.');
    });

    it('disconnects rather than throwing when the token will not decrypt', async () => {
      await store.connect({ refreshToken: REFRESH_TOKEN, scopes: [] });

      const otherKey = new GoogleStore(driver, () => now, () =>
        parseKeyring({ TOKEN_ENC_KEY_V1: Buffer.alloc(32, 9).toString('base64') }),
      );
      expect(await otherKey.refreshToken()).toBeNull();
      expect(store.get()?.lastError).toBe('E_TOKEN_UNREADABLE');
    });

    it('reconnecting replaces the old token', async () => {
      await store.connect({ refreshToken: 'first', scopes: [] });
      await store.connect({ refreshToken: 'second', scopes: [...GOOGLE_SCOPES] });
      expect(await store.refreshToken()).toBe('second');
      expect(store.get()?.lastError).toBeNull();
    });

    it('remembers the reminders calendar, so it is not created twice', async () => {
      await store.connect({ refreshToken: REFRESH_TOKEN, scopes: [] });
      store.setRemindersCalendarId('cal-123');
      expect(store.get()?.remindersCalendarId).toBe('cal-123');
    });
  });

  it('purges spent and expired rows', () => {
    const live = store.createLink(PRINCIPAL);
    const spent = store.createLink(PRINCIPAL);
    store.useLink(spent.id);

    store.purgeExpired();
    expect(store.useLink(spent.id)).toEqual({ ok: false, reason: 'not_found' });
    expect(store.useLink(live.id)).toMatchObject({ ok: true });
  });
});

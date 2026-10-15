/**
 * One authorized Google API call, for any grant (PLAN §6.6, 2026-10-01).
 *
 * Holds the grant's access token in memory between calls and refreshes it
 * shortly before expiry or on a 401; a revoked grant (`invalid_grant`) is
 * disconnected at once, since nothing can be retried. A response body is read
 * only on success: an error body can carry the user's data (event titles, mail
 * subjects), so it is never read or logged.
 */
import type { Logger } from '../security/redact.js';
import { refreshAccessToken } from './oauth.js';
import type { GoogleStore } from './store.js';

/** One request's own limit; exported for the agent's write bound (`agent/limits.ts`). */
export const TIMEOUT_MS = 10_000;
/** Refresh this far before expiry, so a call never races the deadline. */
const REFRESH_MARGIN_MS = 60_000;

export type GoogleFailure =
  | { code: 'not_connected' }
  | { code: 'disconnected' }
  /** An `If-Match` failed: the item changed since it was read. */
  | { code: 'changed' }
  /** Already gone. */
  | { code: 'not_found' }
  | { code: 'provider_error'; status: number }
  | { code: 'network_error' }
  | { code: 'invalid_response' };

export type GoogleResult<T> = { ok: true; value: T } | { ok: false; error: GoogleFailure };

/**
 * What a Google client needs of the API: one call. A `GoogleApi`, or a view of
 * it bound to an agent turn's abort signal (`withSignal`).
 */
export interface GoogleCaller {
  call(url: string, init?: RequestInit): Promise<GoogleResult<unknown>>;
  /**
   * The scopes this grant actually holds, as Google returned them at the last
   * consent (block L, L5): a user can untick one on the consent screen, so a
   * tool that needs a scope checks for it rather than assuming.
   */
  grantedScopes?(): readonly string[];
}

/**
 * The same caller, with every request (and the token refresh it chains) also
 * cut when `signal` fires — an agent turn's deadline (Improvement plan §3 T3).
 * A read's resolve and execute get one; a write's `execute` never does.
 */
export function withSignal(api: GoogleCaller, signal: AbortSignal): GoogleCaller {
  return {
    call: (url, init = { method: 'GET' }) =>
      api.call(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, signal]) : signal }),
    ...(api.grantedScopes ? { grantedScopes: () => api.grantedScopes!() } : {}),
  };
}

export type GoogleApiConfig = {
  store: GoogleStore;
  clientId: string;
  clientSecret: string;
  log: Logger;
  now(): number;
  fetchImpl?: typeof fetch;
  /** Names the API in logs (`<label>_call_failed`). */
  label: string;
};

export class GoogleApi implements GoogleCaller {
  private accessToken: string | null = null;
  private expiresAt = 0;
  private readonly fetchImpl: typeof fetch;

  grantedScopes(): readonly string[] {
    return this.config.store.get()?.scopes ?? [];
  }

  constructor(private readonly config: GoogleApiConfig) {
    // Through a closure: Workers' `fetch` called as a method of this object
    // throws "Illegal invocation" (every call failed in staging, 2026-10-01).
    const doFetch = config.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => doFetch(input, init);
  }

  /**
   * One call, with a single 401 retry: a cached token can be revoked between
   * the expiry check and the request, and only the 401 says so.
   *
   * `init.signal`, when given, is a turn's deadline: combined with each
   * request's own timeout, and passed to the refresh.
   */
  async call(url: string, init: RequestInit = { method: 'GET' }): Promise<GoogleResult<unknown>> {
    const turn = init.signal ?? undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token(attempt > 0, turn);
      if (!token.ok) return token;

      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          ...init,
          headers: {
            authorization: `Bearer ${token.value}`,
            'content-type': 'application/json',
            ...(init.headers as Record<string, string> | undefined),
          },
          signal: turn ? AbortSignal.any([turn, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        return { ok: false, error: { code: 'network_error' } };
      }

      if (response.status === 401 && attempt === 0) {
        this.accessToken = null;
        continue;
      }

      if (!response.ok) {
        this.config.log.warn(`${this.config.label}_call_failed`, { status: response.status });
        if (response.status === 412) return { ok: false, error: { code: 'changed' } };
        if (response.status === 404 || response.status === 410) return { ok: false, error: { code: 'not_found' } };
        return { ok: false, error: { code: 'provider_error', status: response.status } };
      }

      // A DELETE answers 204 with no body. That is a success, not a parse failure.
      if (response.status === 204) return { ok: true, value: {} };

      try {
        return { ok: true, value: await response.json() };
      } catch {
        return { ok: false, error: { code: 'invalid_response' } };
      }
    }

    return { ok: false, error: { code: 'provider_error', status: 401 } };
  }

  private async token(force: boolean, signal?: AbortSignal): Promise<GoogleResult<string>> {
    if (!force && this.accessToken && this.config.now() < this.expiresAt - REFRESH_MARGIN_MS) {
      return { ok: true, value: this.accessToken };
    }

    const refreshToken = await this.config.store.refreshToken();
    if (!refreshToken) return { ok: false, error: { code: 'not_connected' } };

    const result = await refreshAccessToken(
      { refreshToken, clientId: this.config.clientId, clientSecret: this.config.clientSecret },
      this.fetchImpl,
      signal,
    );

    if (!result.ok) {
      if (result.error.code === 'invalid_grant') {
        // Revoked or lapsed. Nothing to retry; the user has to reconnect.
        this.config.store.disconnect('E_GOOGLE_INVALID_GRANT');
        this.config.log.warn('google_disconnected', { errorCode: 'invalid_grant', api: this.config.label });
        return { ok: false, error: { code: 'disconnected' } };
      }
      this.config.log.warn('google_refresh_failed', { errorCode: result.error.code, api: this.config.label });
      return {
        ok: false,
        error:
          result.error.code === 'network_error'
            ? { code: 'network_error' }
            : { code: 'provider_error', status: 'status' in result.error ? result.error.status : 0 },
      };
    }

    this.accessToken = result.grant.accessToken;
    this.expiresAt = this.config.now() + result.grant.expiresInSeconds * 1000;
    return { ok: true, value: this.accessToken };
  }
}

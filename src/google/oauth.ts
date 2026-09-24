/**
 * The Google OAuth exchange (PLAN §6.6).
 *
 * Pure protocol: it builds URLs and parses token responses, and touches no
 * storage and no clock. What it deliberately does not do is decide anything —
 * whether a `state` is live, whether a link has been used, where the refresh
 * token goes: that is `store.ts`, inside the Durable Object where it can be
 * checked atomically.
 *
 * PKCE is used even though this is a confidential client with a secret. The
 * authorization code travels back through a browser redirect on a URL the user
 * can see and a referrer can leak; PKCE is what makes a stolen code useless
 * without the verifier, which never leaves our storage.
 */

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

/**
 * The only scopes this assistant asks for (PLAN §14). Anything beyond these is
 * a security decision recorded in §14 first, and a separate grant (§6.6).
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events.owned',
  'https://www.googleapis.com/auth/calendar.app.created',
] as const;

const TOKEN_TIMEOUT_MS = 10_000;

export type Pkce = { verifier: string; challenge: string };

export type TokenGrant = {
  accessToken: string;
  /** Absent on a refresh: Google returns it only on the first grant. */
  refreshToken?: string;
  expiresInSeconds: number;
  scopes: string[];
};

export type OAuthFailure =
  /** The grant is gone — revoked, expired, or the consent screen was reset. */
  | { code: 'invalid_grant' }
  | { code: 'provider_error'; status: number }
  | { code: 'network_error' }
  | { code: 'invalid_response' };

export type TokenResult = { ok: true; grant: TokenGrant } | { ok: false; error: OAuthFailure };

/** RFC 7636 S256. The verifier is stored; only its hash is ever sent. */
export async function createPkce(): Promise<Pkce> {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

export function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
}): string {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (params.scopes ?? GOOGLE_SCOPES).join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Offline access is what produces a refresh token at all.
  url.searchParams.set('access_type', 'offline');
  // Without this, a re-authorization returns no refresh token, and a grant that
  // was reconnected after a revoke would come back unusable.
  url.searchParams.set('prompt', 'consent');
  // Each scope is its own grant (§6.6), so previously granted ones stay out.
  url.searchParams.set('include_granted_scopes', 'false');
  return url.toString();
}

export async function exchangeCode(
  params: {
    code: string;
    codeVerifier: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  return postToken(
    {
      grant_type: 'authorization_code',
      code: params.code,
      code_verifier: params.codeVerifier,
      client_id: params.clientId,
      client_secret: params.clientSecret,
      redirect_uri: params.redirectUri,
    },
    fetchImpl,
  );
}

export async function refreshAccessToken(
  params: { refreshToken: string; clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  return postToken(
    {
      grant_type: 'refresh_token',
      refresh_token: params.refreshToken,
      client_id: params.clientId,
      client_secret: params.clientSecret,
    },
    fetchImpl,
  );
}

/** Best-effort revocation, for `ops/revoke-tokens.md`. */
export async function revokeToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function postToken(
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResult> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: { code: 'network_error' } };
  }

  if (!response.ok) {
    // One field only. `invalid_grant` is the difference between "retry later"
    // and "the user has to reconnect", so it is worth reading; the rest of the
    // body can quote the request back and is not.
    const error = await readErrorCode(response);
    return error === 'invalid_grant'
      ? { ok: false, error: { code: 'invalid_grant' } }
      : { ok: false, error: { code: 'provider_error', status: response.status } };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, error: { code: 'invalid_response' } };
  }

  const record = (payload ?? {}) as Record<string, unknown>;
  const accessToken = typeof record.access_token === 'string' ? record.access_token : '';
  if (!accessToken) return { ok: false, error: { code: 'invalid_response' } };

  const refreshToken = typeof record.refresh_token === 'string' ? record.refresh_token : undefined;
  return {
    ok: true,
    grant: {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      expiresInSeconds: typeof record.expires_in === 'number' ? record.expires_in : 3600,
      scopes: typeof record.scope === 'string' ? record.scope.split(' ').filter(Boolean) : [],
    },
  };
}

async function readErrorCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : '';
  } catch {
    return '';
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
